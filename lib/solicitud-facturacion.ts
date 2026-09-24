/**
 * SOLICITUD DE FACTURACIÓN AUTOMÁTICA (24-sep, ok de Lalo al "punto 1").
 *
 * Cuando el alta por chat deja la nota de venta CONFIRMADA y enlazada, Vicky
 * crea la Solicitud de Facturación en Zoho (`Solicitud_Adm_y_Finanzas`) con la
 * MISMA forma que las que finanzas acepta a la primera (golden SF10268 TESLA /
 * SF10305 Cafetería Camila) — en los cuatro países, con el layout, el nombre y
 * el área de la FICHA OPERATIVA de cada uno.
 *
 * Y cierra el motivo de rechazo que levantó Anderson ("faltan razón social,
 * giro, dirección y comuna: no están en solicitud, cuenta CRM ni NDV"):
 *  1. la SOLICITUD lleva los datos como campos Y en la descripción;
 *  2. la CUENTA CRM recibe Comuna y Dirección (solo si estaban vacías);
 *  3. la IMPLEMENTACIÓN recibe una nota "Datos de facturación (Vicky)".
 * La NDV (Creator) no se toca desde acá: giro/dirección en JsonToFacturacion
 * es tarea del cotizador/Nacho.
 *
 * Fuente de los datos, en orden: kv `datos_facturacion_` (pop-up de
 * aceptación + pantalla EMPRESA del flow) → borrador del alta → cotización →
 * padrón del país (SUNAT / RUES; el SII de Chile solo da razón social) →
 * contacto de Zoho. Lo que falte va "por confirmar" — la solicitud nace igual
 * y el aviso interno dice qué falta.
 *
 * Idempotente por cotización (kv `sf_facturacion_<quoteId>`) y contra Zoho:
 * si ya existe una solicitud humana con esa NDV, se adopta y no se duplica.
 * Best-effort: jamás toca la conversación ni frena el alta.
 */
import { getZohoAccessToken } from "./zoho-token"
import { getKvValue, setKvValue, fetchHistoryV3 } from "./supabase-persistence-v3"
import { avisarEquipoInterno } from "./alerta-interna"
import { fichaPorTelefono, type CodigoPaisOperativo } from "./paises/ficha-operativa"
import { leerDatosFacturacion, guardarDatosFacturacion, type DatosFacturacion } from "./datos-facturacion"
import { claveBorrador, claveCapacitacion } from "./onboarding/fase"
import { parsearBorrador } from "./onboarding/borrador"
import { parsearCertificadoTributario } from "./certificado-tributario"
import {
  faltantesFacturacion,
  mesInicioFacturacion,
  registroSolicitudFacturacion,
  type DatosSolicitudFacturacion,
} from "./solicitud-facturacion-payload"

const API = () => (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const MODULO = "Solicitud_Adm_y_Finanzas"
const OWNERS_ROBOT = /^(vicky@|info@geovictoria|ventas@geovictoria|productmanager@)/i
const SOLICITANTE_VICKY = { nombre: "Vicky GeoVictoria", email: "vicky@geovictoria.com" }

export const claveSolicitudFacturacion = (quoteId: string) => `sf_facturacion_${String(quoteId || "").replace(/\D/g, "")}`

export type ResultadoSolicitudFacturacion = {
  ok: boolean
  estado: "creada" | "ya_existia" | "adoptada" | "dry" | "sin_datos" | "error"
  sfId?: string
  numero?: string
  faltantes?: string[]
  registro?: Record<string, unknown>
  detalle?: string
  pais?: CodigoPaisOperativo
}

type Opts = {
  quoteId: string
  referenciaNdvId?: string
  impId?: string
  notaHardware?: string
  dry?: boolean
  /** Vuelve a crear aunque exista candado (solo diagnóstico). */
  forzar?: boolean
}

const limpio = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim()

async function headers() {
  const token = await getZohoAccessToken()
  return { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
}

async function getZoho<T = Record<string, unknown>>(H: Record<string, string>, path: string): Promise<T | null> {
  try {
    const r = await fetch(`${API()}${path}`, { headers: H, cache: "no-store" })
    if (r.status !== 200) return null
    const j = (await r.json().catch(() => ({}))) as { data?: T[] }
    return j?.data?.[0] || null
  } catch {
    return null
  }
}

async function coql<T = Record<string, unknown>>(H: Record<string, string>, select_query: string): Promise<T[]> {
  try {
    const r = await fetch(`${API()}/crm/v3/coql`, { method: "POST", headers: H, body: JSON.stringify({ select_query }), cache: "no-store" })
    if (r.status !== 200) {
      if (r.status !== 204) console.warn(`[sf] coql ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`)
      return []
    }
    const j = (await r.json().catch(() => ({}))) as { data?: T[] }
    return j?.data || []
  } catch (e) {
    console.warn("[sf] coql falló:", e instanceof Error ? e.message : e)
    return []
  }
}

/** Fecha de pago en la hora local del país (YYYY-MM-DD). */
function fechaLocal(iso: string, tz: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d)
}

/**
 * Mes de inicio de facturación: fecha de pago (kv de la marca, o hoy) en la
 * hora del país, corrida al mes siguiente si cae del día 15 en adelante
 * (`mesInicioFacturacion`).
 */
async function mesInicioDe(contact: string, tz: string): Promise<string> {
  let iso = new Date().toISOString()
  for (const k of [`pago_online_${contact}`, `comprobante_ok_${contact}`]) {
    try {
      const raw = await getKvValue(k)
      if (!raw) continue
      const j = JSON.parse(raw) as { at?: string }
      if (j?.at && /^\d{4}-\d{2}-\d{2}/.test(j.at)) {
        iso = j.at
        break
      }
    } catch {
      /* siguiente */
    }
  }
  return mesInicioFacturacion(fechaLocal(iso, tz))
}

/** Padrón del país: solo rellena lo VACÍO (regla SII: el padrón no manda). */
async function completarDesdePadron(pais: CodigoPaisOperativo, documento: string, d: DatosFacturacion): Promise<DatosFacturacion> {
  const out = { ...d }
  try {
    if (pais === "pe" && documento) {
      const { fichaRucSunat } = await import("./paises/pe/sunat-ruc")
      const f = await fichaRucSunat(documento)
      if (f) {
        if (!limpio(out.razonSocial) && f.razonSocial) out.razonSocial = f.razonSocial
        if (!limpio(out.direccion) && f.direccion) out.direccion = f.direccion
        if (!limpio(out.comuna) && f.distrito) out.comuna = f.distrito
        if (!limpio(out.ciudad) && (f.provincia || f.departamento)) out.ciudad = f.provincia || f.departamento || ""
      }
    } else if (pais === "co" && documento) {
      const { fichaNitRues } = await import("./paises/co/rues-nit")
      const f = await fichaNitRues(documento)
      if (f) {
        if (!limpio(out.razonSocial) && f.razonSocial) out.razonSocial = f.razonSocial
        // El RUES trae el CIIU (código de actividad), no una glosa de giro:
        // sirve como giro "por defecto" solo si el cliente no dijo nada.
        if (!limpio(out.giro) && f.ciiu) out.giro = `CIIU ${f.ciiu}`
      }
    } else if (pais === "cl" && documento && (!limpio(out.razonSocial) || !limpio(out.giro) || !limpio(out.direccion) || !limpio(out.comuna))) {
      // El padrón SII SÍ entrega giro, dirección y comuna (verificado 24-sep:
      // Fibravives, Andariego, Alba Campos) — la nota del 10-ago que lo daba
      // por muerto quedó vencida. Misma función que usa el prellenado del flow.
      const { fichaEmpresaSii } = await import("./empresas-sii")
      const f = await fichaEmpresaSii(documento)
      if (f) {
        if (!limpio(out.razonSocial) && f.razonSocial) out.razonSocial = f.razonSocial
        if (!limpio(out.giro) && f.giro) out.giro = f.giro
        if (!limpio(out.direccion) && f.direccion) out.direccion = f.direccion
        if (!limpio(out.comuna) && f.comuna) out.comuna = f.comuna
      }
    }
  } catch (e) {
    console.warn("[sf] padrón falló (se sigue sin él):", e instanceof Error ? e.message : e)
  }
  return out
}

/** Quién firma: dueño HUMANO del deal → gestora de venta autónoma del país → Vicky. */
async function solicitanteDe(H: Record<string, string>, dealId: string, pais: CodigoPaisOperativo): Promise<{ nombre: string; email: string }> {
  if (dealId) {
    const d = await getZoho<{ Owner?: { name?: string; email?: string } }>(H, `/crm/v3/Deals/${dealId}?fields=Owner`)
    const email = limpio(d?.Owner?.email).toLowerCase()
    if (email && !OWNERS_ROBOT.test(email)) return { nombre: limpio(d?.Owner?.name) || email, email }
  }
  const f = fichaPorTelefono(pais === "cl" ? "569" : pais === "pe" ? "519" : pais === "co" ? "573" : "521")
  const g = f.equipo.ventaAutonoma
  if (g) return { nombre: g.nombre, email: g.email }
  return SOLICITANTE_VICKY
}

async function subirComprobanteDesdeCotizacion(H: Record<string, string>, quoteId: string, sfId: string): Promise<string> {
  try {
    const r = await fetch(`${API()}/crm/v3/Cotizaciones_GeoVictoria/${quoteId}/Attachments?fields=id,File_Name,Size`, { headers: H, cache: "no-store" })
    if (r.status !== 200) return "sin_adjuntos"
    const j = (await r.json().catch(() => ({}))) as { data?: Array<{ id: string; File_Name?: string; Size?: string }> }
    const cand = (j.data || []).filter((a) => /comprobante|pago|aviso|transfer/i.test(String(a.File_Name || ""))).slice(0, 2)
    if (!cand.length) return "sin_comprobante"
    const subidos: string[] = []
    for (const a of cand) {
      const dl = await fetch(`${API()}/crm/v3/Cotizaciones_GeoVictoria/${quoteId}/Attachments/${a.id}`, { headers: { Authorization: H.Authorization }, cache: "no-store" })
      if (!dl.ok) {
        console.warn(`[sf] no se pudo bajar el adjunto ${a.File_Name}: ${dl.status}`)
        continue
      }
      const buf = Buffer.from(await dl.arrayBuffer())
      if (!buf.length) continue
      const form = new FormData()
      form.append("file", new Blob([buf]), String(a.File_Name || "comprobante"))
      const up = await fetch(`${API()}/crm/v3/${MODULO}/${sfId}/Attachments`, { method: "POST", headers: { Authorization: H.Authorization }, body: form, cache: "no-store" })
      if (up.ok) subidos.push(String(a.File_Name || a.id))
      else console.warn(`[sf] no se pudo subir ${a.File_Name} a la SF: ${up.status}`)
    }
    return subidos.length ? `adjuntos: ${subidos.join(", ")}` : "adjunto_no_subido"
  } catch (e) {
    return `adjunto_error: ${e instanceof Error ? e.message : String(e)}`
  }
}

/** Cuenta CRM: Comuna y Dirección SOLO si estaban vacías (jamás pisa lo del ejecutivo). */
async function completarCuenta(H: Record<string, string>, cuentaId: string, d: DatosFacturacion): Promise<string> {
  if (!cuentaId) return "sin_cuenta"
  const a = await getZoho<{ Comuna?: string; Direcci_n_de_la_Empresa?: string }>(H, `/crm/v3/Accounts/${cuentaId}?fields=Comuna,Direcci_n_de_la_Empresa`)
  if (!a) return "cuenta_ilegible"
  const put: Record<string, string> = {}
  if (!limpio(a.Comuna) && limpio(d.comuna)) put.Comuna = limpio(d.comuna).slice(0, 255)
  if (!limpio(a.Direcci_n_de_la_Empresa) && limpio(d.direccion)) put.Direcci_n_de_la_Empresa = limpio(d.direccion).slice(0, 255)
  if (!Object.keys(put).length) return "cuenta_ya_tenia"
  try {
    const r = await fetch(`${API()}/crm/v3/Accounts/${cuentaId}`, {
      method: "PUT",
      headers: H,
      body: JSON.stringify({ data: [put], trigger: ["blueprint"] }),
      cache: "no-store",
    })
    return r.ok ? `cuenta: ${Object.keys(put).join("+")}` : `cuenta_put_${r.status}`
  } catch {
    return "cuenta_put_error"
  }
}

async function notaEnImplementacion(H: Record<string, string>, impId: string, titulo: string, contenido: string): Promise<boolean> {
  if (!impId) return false
  try {
    const r = await fetch(`${API()}/crm/v3/Notes`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ data: [{ Note_Title: titulo, Note_Content: contenido.slice(0, 30000), Parent_Id: impId, $se_module: "Implementaciones" }] }),
      cache: "no-store",
    })
    return r.ok
  } catch {
    return false
  }
}

/** Placeholder por campo para los obligatorios de otro tipo de solicitud. */
function placeholderObligatorio(apiName: string, empresa: string): unknown {
  switch (apiName) {
    case "N_Factura":
      return 0
    case "Fecha_comprometida_para_desactivar":
      return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00")
    case "Nombre_empresa_plataforma":
    case "Nombre_empresa_en_platafora":
      return empresa.toUpperCase() || "EMPRESA"
    case "Motivo":
    case "ltimo_mes_de_servicio_a_facturar":
    default:
      return "No aplica (solicitud de facturación)"
  }
}

async function crearConObligatoriosDeOtroTipo(
  H: Record<string, string>,
  registro: Record<string, unknown>,
  empresa: string,
): Promise<{ ok: true; id: string; rellenados: string[] } | { ok: false; detalle: string }> {
  const rec = { ...registro }
  const rellenados: string[] = []
  for (let intento = 0; intento < 8; intento++) {
    const r = await fetch(`${API()}/crm/v8/${MODULO}`, { method: "POST", headers: H, body: JSON.stringify({ data: [rec], trigger: ["workflow", "blueprint"] }), cache: "no-store" })
    const j = (await r.json().catch(() => ({}))) as { data?: Array<{ code?: string; details?: { id?: string; api_name?: string; expected_data_type?: string }; message?: string }> }
    const fila = j?.data?.[0]
    if (r.ok && fila?.code === "SUCCESS" && fila?.details?.id) {
      if (rellenados.length) console.log(`[sf] creada rellenando obligatorios de otro tipo: ${rellenados.join(", ")}`)
      return { ok: true, id: String(fila.details.id), rellenados }
    }
    const campo = String(fila?.details?.api_name || "")
    if (fila?.code === "MANDATORY_NOT_FOUND" && campo && !(campo in rec)) {
      rec[campo] = placeholderObligatorio(campo, empresa)
      rellenados.push(campo)
      continue
    }
    if (fila?.code === "INVALID_DATA" && campo && campo in rec && rellenados.includes(campo)) {
      // El placeholder no calzó con el tipo: se prueba el otro formato una vez.
      rec[campo] = typeof rec[campo] === "number" ? "0" : rec[campo] === "No aplica (solicitud de facturación)" ? new Date().toISOString().slice(0, 10) : "-"
      rellenados.push(`${campo}*`)
      continue
    }
    return { ok: false, detalle: `${r.status} ${fila?.code || ""} ${fila?.message || ""} ${campo}`.trim() }
  }
  return { ok: false, detalle: "demasiados reintentos de obligatorios" }
}

/**
 * Crea (o adopta) la Solicitud de Facturación de una venta por chat.
 * `contact` = teléfono del cliente (decide el país por la ficha).
 */
export async function crearSolicitudFacturacion(contact: string, opts: Opts): Promise<ResultadoSolicitudFacturacion> {
  const c = String(contact || "").replace(/\D/g, "")
  const quoteId = String(opts.quoteId || "").replace(/\D/g, "")
  if (!c || !quoteId) return { ok: false, estado: "error", detalle: "sin contacto o cotización" }
  const ficha = fichaPorTelefono(c)
  const pais = ficha.pais
  const clave = claveSolicitudFacturacion(quoteId)

  if (!opts.forzar && !opts.dry) {
    const previa = await getKvValue(clave).catch(() => null)
    if (previa) {
      try {
        const j = JSON.parse(previa) as { sfId?: string; numero?: string }
        return { ok: true, estado: "ya_existia", sfId: j.sfId, numero: j.numero, pais }
      } catch {
        return { ok: true, estado: "ya_existia", pais }
      }
    }
  }

  const H = await headers()

  // 1. Cotización (cuenta, contacto, deal, teléfono, correo, documento, razón social).
  const q = await getZoho<{
    Name?: string
    Numero_Cotizacion?: string
    Cuenta_Asociada?: { id?: string; name?: string }
    Contacto_Asociado?: { id?: string; name?: string }
    Deal_Asociado?: { id?: string }
    Tel_fono_Contacto?: string
    Email_Contacto?: string
    RUT_Cliente?: string
    RUT_Empresa?: string
    Nota_de_Venta?: { id?: string; name?: string }
    Estado_Cotizacion?: string
  }>(H, `/crm/v3/Cotizaciones_GeoVictoria/${quoteId}?fields=Name,Numero_Cotizacion,Cuenta_Asociada,Contacto_Asociado,Deal_Asociado,Tel_fono_Contacto,Email_Contacto,RUT_Cliente,RUT_Empresa,Nota_de_Venta,Estado_Cotizacion`)
  if (!q) return { ok: false, estado: "error", detalle: "cotización ilegible", pais }

  // La NDV VIGENTE vive en la IMPLEMENTACIÓN (regla 11-sep: cuando una nota se
  // rehace el reapuntado va a la IMP y la cotización se queda atrás — Mila:
  // cotización en NDV-31857, IMP en NDV-31862, la SF de Grey colgaba de la
  // segunda). Orden: lo que pasa el llamador → IMP → cotización.
  const impIdConocido =
    limpio(opts.impId) ||
    (await getKvValue(claveCapacitacion(c)).then((raw) => (raw ? (JSON.parse(raw) as { implementacionId?: string }).implementacionId || "" : "")).catch(() => ""))
  const impNdv = impIdConocido
    ? await getZoho<{ Nota_de_Venta_Asociada?: { id?: string } }>(H, `/crm/v3/Implementaciones/${impIdConocido}?fields=Nota_de_Venta_Asociada`)
    : null
  const referenciaId = String(opts.referenciaNdvId || impNdv?.Nota_de_Venta_Asociada?.id || q.Nota_de_Venta?.id || "").trim()
  const cuentaIdTemprana = limpio(q.Cuenta_Asociada?.id)

  // 2. ¿Ya existe una solicitud (humana o nuestra) para esta venta? Se ADOPTA.
  //    Por la NDV vigente O por la CUENTA (una "Nueva empresa" reciente de la
  //    misma cuenta es la misma venta aunque la NDV se haya rehecho después).
  if (!opts.dry && (referenciaId || cuentaIdTemprana)) {
    const desde = new Date(Date.now() - 120 * 86400e3).toISOString().replace(/\.\d{3}Z$/, "+00:00")
    const condiciones = [
      referenciaId ? `ID_NDV = '${referenciaId}'` : "",
      cuentaIdTemprana ? `((Cuenta = '${cuentaIdTemprana}' and nombre_por_colocar = 'Nueva empresa') and Created_Time >= '${desde}')` : "",
    ].filter(Boolean)
    const donde = condiciones.length === 2 ? `(${condiciones[0]} or ${condiciones[1]})` : condiciones[0]
    const ya = await coql<{ id: string; Nro_Solicitud?: string; Estado?: string }>(
      H,
      `select id, Nro_Solicitud, Estado from ${MODULO} where (${donde} and Solicitud = 'Facturación') order by Created_Time desc limit 1`,
    )
    if (ya[0]?.id) {
      await setKvValue(clave, JSON.stringify({ sfId: ya[0].id, numero: ya[0].Nro_Solicitud || "", adoptada: true, at: new Date().toISOString() })).catch(() => {})
      return { ok: true, estado: "adoptada", sfId: ya[0].id, numero: ya[0].Nro_Solicitud, pais, detalle: `ya existía (${ya[0].Estado || "?"})` }
    }
  }

  // 3. Referencia NDV (PDF, cuenta, razón social de la nota).
  const ref = referenciaId
    ? await getZoho<{ URL_PDF?: string; Account_CRM?: { id?: string; name?: string }; Nombre_Empresa?: string; ESTADO?: string; Name?: string }>(
        H,
        `/crm/v3/Referencias_NDV/${referenciaId}?fields=URL_PDF,Account_CRM,Nombre_Empresa,ESTADO,Name`,
      )
    : null

  // 4. Datos de facturación: kv → borrador → cotización → padrón → contacto.
  let d: DatosFacturacion = (await leerDatosFacturacion(c)) || {}
  try {
    const rawB = await getKvValue(claveBorrador(c))
    const b = rawB ? parsearBorrador(JSON.parse(rawB)) : null
    if (b) {
      if (!limpio(d.razonSocial) && limpio(b.empresa?.nombre)) d.razonSocial = b.empresa!.nombre
      if (!limpio(d.documento) && limpio(b.empresa?.identificador)) d.documento = b.empresa!.identificador
      const adminNombre = [b.admin?.nombre, b.admin?.apellido].map(limpio).filter(Boolean).join(" ")
      if (!limpio(d.contactoNombre) && adminNombre) d.contactoNombre = adminNombre
      if (!limpio(d.correo) && limpio(b.admin?.email)) d.correo = b.admin!.email
    }
  } catch {
    /* sin borrador */
  }
  // "Otro" es el giro por DEFECTO que el prellenado del flow escribe cuando no
  // encontró fuente (25-ago): no es un dato del cliente, así que no le gana al
  // padrón (Alba Campos salía "Otro" teniendo giro en el SII).
  if (/^otro$/i.test(limpio(d.giro))) d.giro = ""
  if (!limpio(d.documento)) d.documento = limpio(q.RUT_Cliente) || limpio(q.RUT_Empresa)
  if (!limpio(d.razonSocial)) d.razonSocial = limpio(ref?.Nombre_Empresa) || limpio(q.Cuenta_Asociada?.name) || limpio(q.Name).replace(/^Cotizaci[oó]n\s+/i, "").replace(/\s+-\s+\d{1,2}[-/]\d{1,2}[-/]\d{2,4}.*$/, "")
  if (!limpio(d.telefono)) d.telefono = limpio(q.Tel_fono_Contacto) || `+${c}`
  if (!limpio(d.correo)) d.correo = limpio(q.Email_Contacto)
  // CERTIFICADO TRIBUTARIO EN EL CHAT (24-sep, caso HSEQTECH): si el cliente
  // mandó su e-RUT / ficha RUC / RUT DIAN / constancia SAT por WhatsApp, la
  // visión ya lo transcribió en el historial. Rellena SOLO lo vacío y solo si
  // el documento del certificado es el de la venta (no el de un proveedor).
  if (!limpio(d.giro) || !limpio(d.direccion) || !limpio(d.comuna)) {
    try {
      const hist = await fetchHistoryV3(c, 200)
      const digs = (x: unknown) => String(x ?? "").replace(/[^\dkK]/g, "").toUpperCase()
      for (const m of [...hist].reverse()) {
        if (m.role !== "user") continue
        const cert = parsearCertificadoTributario(String(m.content || ""))
        if (!cert) continue
        if (cert.documento && limpio(d.documento) && digs(cert.documento) !== digs(d.documento)) continue
        if (!limpio(d.giro) && cert.giro) d.giro = cert.giro
        if (!limpio(d.direccion) && cert.direccion) d.direccion = cert.direccion
        if (!limpio(d.comuna) && cert.comuna) d.comuna = cert.comuna
        if (!limpio(d.ciudad) && cert.ciudad) d.ciudad = cert.ciudad
        if (!limpio(d.razonSocial) && cert.razonSocial) d.razonSocial = cert.razonSocial
        if (!limpio(d.documento) && cert.documento) d.documento = cert.documento
        break
      }
    } catch (e) {
      console.warn(`[solicitud-facturacion] certificado del chat ilegible contact=${c}: ${e instanceof Error ? e.message : e}`)
    }
  }
  d = await completarDesdePadron(pais, limpio(d.documento), d)
  if ((!limpio(d.contactoNombre) || !limpio(d.correo)) && q.Contacto_Asociado?.id) {
    const ct = await getZoho<{ First_Name?: string; Last_Name?: string; Email?: string }>(H, `/crm/v3/Contacts/${q.Contacto_Asociado.id}?fields=First_Name,Last_Name,Email`)
    const n = [ct?.First_Name, ct?.Last_Name].map(limpio).filter((x) => x && !/^prospecto$/i.test(x)).join(" ")
    if (!limpio(d.contactoNombre) && n) d.contactoNombre = n
    if (!limpio(d.correo) && limpio(ct?.Email)) d.correo = ct!.Email
  }
  // Lo consolidado se guarda como fuente única (la próxima solicitud del
  // mismo cliente, o el ticket ST, parte de acá).
  if (!opts.dry) await guardarDatosFacturacion(c, d, "consolidado").catch(() => {})

  const cuentaId = limpio(q.Cuenta_Asociada?.id) || limpio(ref?.Account_CRM?.id)
  const solicitante = await solicitanteDe(H, limpio(q.Deal_Asociado?.id), pais)
  const mesInicio = await mesInicioDe(c, ficha.tz)

  const datos: DatosSolicitudFacturacion = {
    pais,
    paisNombre: ficha.nombre,
    layoutId: ficha.solicitudes.facturacionLayoutId,
    nombrePlantilla: ficha.solicitudes.facturacionNombre,
    area: ficha.solicitudes.facturacionArea,
    empresa: limpio(d.razonSocial),
    documento: limpio(d.documento),
    documentoEtiqueta: ficha.documento.etiqueta,
    giro: d.giro,
    direccion: d.direccion,
    comuna: d.comuna,
    ciudad: d.ciudad,
    telefono: d.telefono,
    contactoNombre: d.contactoNombre,
    correo: d.correo,
    cuentaId: cuentaId || undefined,
    referenciaNdvId: referenciaId || undefined,
    urlPdfNdv: limpio(ref?.URL_PDF) || undefined,
    mesInicio,
    solicitanteNombre: solicitante.nombre,
    solicitanteEmail: solicitante.email,
    notaHardware: opts.notaHardware,
  }
  const faltantes = faltantesFacturacion(datos)
  const registro = registroSolicitudFacturacion(datos)

  if (opts.dry) return { ok: true, estado: "dry", registro, faltantes, pais, detalle: `solicitante ${solicitante.email}` }

  // 5. Crear. OJO (24-sep, primera creación real): el layout marca como
  //    obligatorios campos de OTROS tipos de solicitud (N_Factura, Motivo,
  //    Fecha_comprometida_para_desactivar, ltimo_mes_de_servicio_a_facturar,
  //    Nombre_empresa_plataforma) que la UI oculta con reglas de layout — por
  //    eso los humanos los dejan null y la API responde MANDATORY_NOT_FOUND.
  //    Se rellenan con un "No aplica" explícito SOLO cuando Zoho los exige,
  //    campo por campo, y quedan ocultos igual para quien lee la solicitud.
  let sfId = ""
  try {
    const creado = await crearConObligatoriosDeOtroTipo(H, registro, datos.empresa)
    if (!creado.ok) {
      await avisarEquipoInterno(`⚠️ SOLICITUD DE FACTURACIÓN de ${datos.empresa || quoteId} (${ficha.nombre}) NO se pudo crear: ${creado.detalle}. Hay que hacerla a mano.`).catch(() => {})
      return { ok: false, estado: "error", detalle: creado.detalle, registro, faltantes, pais }
    }
    sfId = creado.id
  } catch (e) {
    return { ok: false, estado: "error", detalle: e instanceof Error ? e.message : String(e), registro, faltantes, pais }
  }

  const creada = await getZoho<{ Nro_Solicitud?: string }>(H, `/crm/v3/${MODULO}/${sfId}?fields=Nro_Solicitud`)
  const numero = limpio(creada?.Nro_Solicitud)
  await setKvValue(clave, JSON.stringify({ sfId, numero, at: new Date().toISOString(), faltantes })).catch(() => {})

  // 6. Cuenta CRM + comprobante + nota en la IMP (best-effort, en paralelo).
  const impId = impIdConocido
  const descripcion = String(registro.Descripci_n || "")
  const [cuenta, adjunto, nota] = await Promise.all([
    completarCuenta(H, cuentaId, d),
    subirComprobanteDesdeCotizacion(H, quoteId, sfId),
    notaEnImplementacion(
      H,
      impId,
      `Datos de facturación (Vicky) · ${datos.empresa}`,
      `${descripcion}\n\nSolicitud de Facturación ${numero || sfId} creada automáticamente.${faltantes.length ? `\nFALTA: ${faltantes.join(", ")}.` : ""}`,
    ),
  ])

  const aviso =
    `🧾 Solicitud de Facturación ${numero || sfId} creada sola (${ficha.nombre}) para ${datos.empresa}` +
    (ref?.Name ? ` · ${ref.Name}` : "") +
    ` · solicitante ${solicitante.nombre}` +
    (faltantes.length ? ` · ⚠️ FALTA: ${faltantes.join(", ")} (quedó "por confirmar" — completar antes de que finanzas la revise)` : " · datos completos") +
    ` · ${cuenta} · ${adjunto}${nota ? " · nota en la IMP" : ""}`
  await avisarEquipoInterno(aviso).catch(() => {})
  console.log(`[sf] ${aviso}`)
  return { ok: true, estado: "creada", sfId, numero, faltantes, pais, detalle: `${cuenta} · ${adjunto}` }
}
