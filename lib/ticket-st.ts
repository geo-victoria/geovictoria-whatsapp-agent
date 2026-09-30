/**
 * Ticket de SERVICIO TÉCNICO automático para una venta de Vicky (30-sep, orden
 * de Lalo: "crear tickets de Servicio Técnico automáticamente"). Nace cuando
 * la NDV está CONFIRMADA y la referencia trae equipos de campo (reloj/kit),
 * con la forma de los tickets que Nailliw crea a mano (lib/ticket-st-payload).
 *
 *  - ADOPTA un ticket existente (humano o nuestro) por la NDV vigente o por la
 *    cuenta en los últimos 60 días: jamás dos tickets para la misma venta.
 *  - Categoría desde los ítems de la NDV: instalación técnica manda; si no,
 *    envío. Regla SSTT: un solo servicio técnico por nota.
 *  - Modelo del equipo = nombre EXACTO del ítem de la NDV (rechazo "Equipo en
 *    planilla no coincide con ítem NDV").
 *  - Dirección/comuna/región: datos de facturación consolidados (formulario,
 *    padrón, certificado del chat) → cotización → padrón SII. Región = picklist
 *    de ST (lib/regiones-cl).
 *  - Planilla de equipos: generada desde la NDV y adjuntada al ticket
 *    (Attachments, que funciona con el scope actual). Si existe el token de
 *    ZohoFiles, además se sube al campo `Planilla_equipos`.
 *  - Lo que el chat no pregunta va declarado, no inventado; la respuesta trae
 *    `faltantes` y el aviso interno los nombra.
 * Best-effort: nunca toca la conversación.
 */
import { getZohoAccessToken } from "./zoho-token"
import { getKvValue, setKvValue } from "./supabase-persistence-v3"
import { avisarEquipoInterno } from "./alerta-interna"
import { fichaPorTelefono, personaPorEmail } from "./paises/ficha-operativa"
import { leerDatosFacturacion } from "./datos-facturacion"
import { claveCapacitacion, claveAltaSolicitada } from "./onboarding/fase"
import { escribirXlsx } from "./escribir-excel"
import { regionDeUbicacion, regionDesdePadron } from "./regiones-cl"
import { mesInicioFacturacion, etiquetaMes } from "./solicitud-facturacion-payload"
import {
  categoriaDesdeItems,
  esEquipoDeCampo,
  faltantesTicketST,
  filasPlanillaEquipos,
  registroTicketST,
  nombreTicketST,
  equiposDesdeCotizacion,
  type DatosTicketST,
  type EquipoTicket,
} from "./ticket-st-payload"
import { subirArchivoZohoFiles } from "./zoho-files-token"

const API = () => (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const MODULO = "TicketsST"
const QUOTE_MOD = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
const OWNERS_ROBOT = /^(vicky@|info@geovictoria|ventas@geovictoria|productmanager@)/i
const limpio = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim()

export const claveTicketST = (quoteId: string) => `ticket_st_${String(quoteId || "").replace(/\D/g, "")}`

export type ResultadoTicketST = {
  ok: boolean
  estado: "creado" | "adoptado" | "ya_existia" | "sin_hardware" | "sin_ndv" | "dry" | "error"
  ticketId?: string
  numero?: string
  categoria?: string
  faltantes?: string[]
  planilla?: "campo" | "adjunto" | "no"
  detalle?: string
  registro?: Record<string, unknown>
}

type Opts = { quoteId: string; referenciaNdvId?: string; impId?: string; companyId?: string; dry?: boolean; forzar?: boolean }

async function headers() {
  const token = await getZohoAccessToken()
  return { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
}
async function getZoho<T = Record<string, unknown>>(H: Record<string, string>, path: string): Promise<T | null> {
  try {
    const r = await fetch(`${API()}${path}`, { headers: H, cache: "no-store" })
    if (r.status !== 200) return null
    return ((await r.json().catch(() => ({}))) as { data?: T[] }).data?.[0] || null
  } catch {
    return null
  }
}
async function coql<T = Record<string, unknown>>(H: Record<string, string>, select_query: string): Promise<T[]> {
  try {
    const r = await fetch(`${API()}/crm/v3/coql`, { method: "POST", headers: H, body: JSON.stringify({ select_query }), cache: "no-store" })
    if (r.status === 204) return []
    if (r.status !== 200) {
      console.warn(`[ticket-st] COQL ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)} — ${select_query.slice(0, 120)}`)
      return []
    }
    return ((await r.json().catch(() => ({}))) as { data?: T[] }).data || []
  } catch (e) {
    console.warn("[ticket-st] COQL:", e instanceof Error ? e.message : e)
    return []
  }
}

type FilaEquipoRef = { NOMBRE?: string; CANTIDAD?: number; PRECIO?: number; ID_ITEM?: string }
type Referencia = {
  id: string
  Name?: string
  URL_PDF?: string
  ID_SO?: string
  Monto_Total_HW?: number
  ESTADO?: string
  Account_CRM?: { id?: string; name?: string }
  Equipos_Referencias_NV?: FilaEquipoRef[]
}

async function ejecutivoDe(H: Record<string, string>, dealId: string, pais: "cl"): Promise<{ id: string; nombre: string; email: string }> {
  if (dealId) {
    const d = await getZoho<{ Owner?: { id?: string; name?: string; email?: string } }>(H, `/crm/v3/Deals/${dealId}?fields=Owner`)
    const email = limpio(d?.Owner?.email).toLowerCase()
    if (email && !OWNERS_ROBOT.test(email)) return { id: limpio(d?.Owner?.id), nombre: limpio(d?.Owner?.name) || email, email }
  }
  const g = fichaPorTelefono(pais === "cl" ? "569" : "569").equipo.ventaAutonoma
  if (g) return { id: g.zohoId, nombre: g.nombre, email: g.email }
  return { id: "", nombre: "Vicky GeoVictoria", email: "vicky@geovictoria.com" }
}

async function mesFacturacionDe(contact: string, tz: string): Promise<string> {
  let iso = new Date().toISOString()
  for (const k of [`pago_online_${contact}`, `comprobante_ok_${contact}`]) {
    try {
      const raw = await getKvValue(k)
      if (!raw) continue
      const j = JSON.parse(raw) as { at?: string }
      if (j?.at && /^\d{4}-\d{2}-\d{2}/.test(j.at)) { iso = j.at; break }
    } catch { /* siguiente */ }
  }
  const local = new Intl.DateTimeFormat("en-CA", { timeZone: tz || "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso))
  return etiquetaMes(mesInicioFacturacion(local))
}

async function adjuntarPlanilla(H: Record<string, string>, ticketId: string, buf: Buffer, filename: string): Promise<"campo" | "adjunto" | "no"> {
  // 1) Campo fileupload (exige ZohoFiles): si hay token, es lo que ST espera.
  const fileId = await subirArchivoZohoFiles(buf, filename, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").catch(() => null)
  if (fileId) {
    const put = await fetch(`${API()}/crm/v3/${MODULO}`, {
      method: "PUT", headers: H, cache: "no-store",
      body: JSON.stringify({ data: [{ id: ticketId, Planilla_equipos: [{ file_id: fileId }] }] }),
    })
    const pj = (await put.json().catch(() => ({}))) as { data?: Array<{ code?: string }> }
    if (put.ok && pj?.data?.[0]?.code === "SUCCESS") return "campo"
    console.warn(`[ticket-st] Planilla_equipos no se pudo fijar: ${JSON.stringify(pj).slice(0, 200)}`)
  }
  // 2) Related list Attachments (funciona con el scope actual).
  try {
    const form = new FormData()
    form.append("file", new Blob([buf as unknown as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), filename)
    const up = await fetch(`${API()}/crm/v3/${MODULO}/${ticketId}/Attachments`, { method: "POST", headers: { Authorization: H.Authorization }, body: form, cache: "no-store" })
    if (up.ok) return "adjunto"
    console.warn(`[ticket-st] adjunto falló ${up.status}: ${(await up.text().catch(() => "")).slice(0, 200)}`)
  } catch (e) {
    console.warn("[ticket-st] adjunto:", e instanceof Error ? e.message : e)
  }
  return "no"
}

export async function crearTicketST(contact: string, opts: Opts): Promise<ResultadoTicketST> {
  const c = String(contact || "").replace(/\D/g, "")
  const quoteId = String(opts.quoteId || "").replace(/\D/g, "")
  if (!c || !quoteId) return { ok: false, estado: "error", detalle: "sin contacto o cotización" }
  const ficha = fichaPorTelefono(c)
  if (ficha.pais !== "cl") return { ok: false, estado: "error", detalle: `ticket ST automático solo en Chile por ahora (${ficha.pais})` }
  const clave = claveTicketST(quoteId)

  if (!opts.forzar && !opts.dry) {
    const previa = await getKvValue(clave).catch(() => null)
    if (previa) {
      try {
        const j = JSON.parse(previa) as { ticketId?: string; numero?: string; estado?: string }
        if (j.estado === "sin_hardware") return { ok: true, estado: "sin_hardware", detalle: "ya evaluado: sin equipos" }
        return { ok: true, estado: "ya_existia", ticketId: j.ticketId, numero: j.numero }
      } catch {
        return { ok: true, estado: "ya_existia" }
      }
    }
  }

  const H = await headers()
  const q = await getZoho<{
    Name?: string; Numero_Cotizacion?: string
    Cuenta_Asociada?: { id?: string; name?: string }
    Contacto_Asociado?: { id?: string; name?: string }
    Deal_Asociado?: { id?: string }
    Tel_fono_Contacto?: string; Email_Contacto?: string; RUT_Cliente?: string; RUT_Empresa?: string
    Nota_de_Venta?: { id?: string; name?: string }
    Detalle_Items_Cotizacion?: Array<{ Codigo_Item?: string; Nombre_Item?: string; Modalidad?: string; Cantidad?: number; Subtotal_UF?: number }>
  }>(H, `/crm/v3/${QUOTE_MOD}/${quoteId}?fields=Name,Numero_Cotizacion,Cuenta_Asociada,Contacto_Asociado,Deal_Asociado,Tel_fono_Contacto,Email_Contacto,RUT_Cliente,RUT_Empresa,Nota_de_Venta,Detalle_Items_Cotizacion`)
  if (!q) return { ok: false, estado: "error", detalle: "cotización ilegible" }

  // NDV vigente: llamador → IMP → cotización (regla 11-sep: el reapuntado va a la IMP).
  const impId =
    limpio(opts.impId) ||
    (await getKvValue(claveCapacitacion(c)).then((raw) => (raw ? (JSON.parse(raw) as { implementacionId?: string }).implementacionId || "" : "")).catch(() => ""))
  const impNdv = impId ? await getZoho<{ Nota_de_Venta_Asociada?: { id?: string }; N_Implementacion?: string }>(H, `/crm/v3/Implementaciones/${impId}?fields=Nota_de_Venta_Asociada,N_Implementacion`) : null
  const referenciaId = limpio(opts.referenciaNdvId || impNdv?.Nota_de_Venta_Asociada?.id || q.Nota_de_Venta?.id)
  if (!referenciaId) return { ok: false, estado: "sin_ndv", detalle: "la venta no tiene NDV enlazada todavía" }
  const ref = await getZoho<Referencia>(H, `/crm/v3/Referencias_NDV/${referenciaId}?fields=Name,URL_PDF,ID_SO,Monto_Total_HW,ESTADO,Account_CRM,Equipos_Referencias_NV`)
  if (!ref) return { ok: false, estado: "sin_ndv", detalle: `referencia ${referenciaId} ilegible` }

  const filas = Array.isArray(ref.Equipos_Referencias_NV) ? ref.Equipos_Referencias_NV : []
  const nombres = filas.map((f) => limpio(f.NOMBRE))
  let equipos: EquipoTicket[] = filas
    .filter((f) => esEquipoDeCampo(limpio(f.NOMBRE)))
    .map((f) => ({ nombre: limpio(f.NOMBRE), cantidad: Number(f.CANTIDAD || 1) || 1, precio: Number(f.PRECIO || 0) || 0 }))
  // ARRIENDO: el reloj va en el bloque recurrente de la NDV, no en la lista de
  // equipos de la referencia (ahí solo aparecen envío/instalación). Se
  // reconstruye desde la cotización con el MISMO nombre de Books.
  if (!equipos.length) equipos = equiposDesdeCotizacion(q.Detalle_Items_Cotizacion || [])
  if (!equipos.length) {
    if (!opts.dry) await setKvValue(clave, JSON.stringify({ estado: "sin_hardware", at: new Date().toISOString(), referenciaId })).catch(() => {})
    return { ok: true, estado: "sin_hardware", detalle: `NDV ${ref.Name || ""} sin equipos de campo (${nombres.join(" · ") || "sin ítems"})` }
  }
  const servicios = nombres.filter((n) => /env[ií]o|despacho|instalaci|visita/i.test(n))
  const itemsCot = (q.Detalle_Items_Cotizacion || []).map((f) => `${f.Codigo_Item || ""} ${f.Nombre_Item || ""}`)
  const categoria = categoriaDesdeItems([...nombres, ...itemsCot.filter((s) => /instalacion_reloj|instalaci/i.test(s))])

  const cuentaId = limpio(q.Cuenta_Asociada?.id) || limpio(ref.Account_CRM?.id)
  // Ticket existente (humano o nuestro) para esta venta → se adopta.
  if (!opts.dry && (referenciaId || cuentaId)) {
    const desde = new Date(Date.now() - 60 * 86400e3).toISOString().replace(/\.\d{3}Z$/, "+00:00")
    const cond = [
      `ID_Nota_de_venta = '${referenciaId}'`,
      cuentaId ? `((Lookup_1 = '${cuentaId}' and Tipo = 'Venta') and Created_Time >= '${desde}')` : "",
    ].filter(Boolean)
    const donde = cond.length === 2 ? `(${cond[0]} or ${cond[1]})` : cond[0]
    const ya = await coql<{ id: string; Name?: string; Estado?: string; Pick_List_1?: string }>(
      H,
      `select id, Name, Estado, Pick_List_1 from ${MODULO} where (${donde} and Estado != 'Anulado') order by Created_Time desc limit 1`,
    )
    if (ya[0]?.id) {
      await setKvValue(clave, JSON.stringify({ ticketId: ya[0].id, numero: ya[0].Name || "", adoptado: true, at: new Date().toISOString() })).catch(() => {})
      return { ok: true, estado: "adoptado", ticketId: ya[0].id, numero: ya[0].Name, categoria: ya[0].Pick_List_1, detalle: `ya existía (${ya[0].Estado || "?"})` }
    }
  }

  // Datos del lugar y del contacto.
  const df = (await leerDatosFacturacion(c).catch(() => null)) || {}
  const rut = limpio(q.RUT_Empresa || q.RUT_Cliente || df.documento)
  let direccion = limpio(df.direccion)
  let comuna = limpio(df.comuna)
  let region = regionDeUbicacion(comuna || direccion)
  if ((!direccion || !comuna || !region) && rut) {
    try {
      const { fichaEmpresaSii } = await import("./empresas-sii")
      const sii = await fichaEmpresaSii(rut)
      if (sii) {
        if (!direccion) direccion = limpio(sii.direccion)
        if (!comuna) comuna = limpio(sii.comuna)
        if (!region) region = regionDesdePadron(String(sii.region || "")) || regionDeUbicacion(comuna)
      }
    } catch { /* sin padrón */ }
  }
  if (!region && comuna) region = regionDeUbicacion(comuna)

  const ejecutivo = await ejecutivoDe(H, limpio(q.Deal_Asociado?.id), "cl")
  const ejecutivoId = ejecutivo.id || limpio(personaPorEmail(ejecutivo.email)?.zohoId)
  const pagoMarcado = Boolean((await getKvValue(`pago_online_${c}`).catch(() => null)) || (await getKvValue(`comprobante_ok_${c}`).catch(() => null)))
  let companyId = limpio(opts.companyId)
  if (!companyId) {
    try {
      const raw = await getKvValue(claveAltaSolicitada(c))
      companyId = limpio(raw ? (JSON.parse(raw) as { companyId?: string | number }).companyId : "")
    } catch { /* sin alta */ }
  }

  const d: DatosTicketST = {
    pais: "cl",
    layoutId: ficha.solicitudes.stLayoutId,
    categoria,
    empresa: limpio(q.Cuenta_Asociada?.name) || limpio(ref.Account_CRM?.name) || limpio(df.razonSocial),
    rutEmpresa: rut,
    companyId: companyId || undefined,
    cuentaId,
    contactoId: limpio(q.Contacto_Asociado?.id) || undefined,
    contactoNombre: limpio(df.contactoNombre) || limpio(q.Contacto_Asociado?.name),
    contactoTelefono: limpio(q.Tel_fono_Contacto) || (c ? `+${c}` : "") || limpio(df.telefono),
    contactoCorreo: limpio(q.Email_Contacto) || limpio(df.correo),
    ejecutivoId: ejecutivoId || undefined,
    ejecutivoNombre: ejecutivo.nombre,
    ejecutivoEmail: ejecutivo.email,
    solicitanteNombre: ejecutivo.nombre,
    solicitanteEmail: ejecutivo.email,
    referenciaNdvId: referenciaId,
    ndvNombre: limpio(ref.Name),
    soNumero: limpio(ref.ID_SO),
    pdfNdv: limpio(ref.URL_PDF),
    montoNvUF: Number(ref.Monto_Total_HW || 0) || equipos.reduce((a, e) => a + e.precio * e.cantidad, 0),
    equipos,
    servicios,
    direccion,
    comuna,
    region,
    relojPagado: pagoMarcado,
    mesFacturacion: await mesFacturacionDe(c, ficha.tz),
    cotizacionNumero: limpio(q.Numero_Cotizacion),
  }
  const faltantes = faltantesTicketST(d)
  const registro = registroTicketST(d)
  if (opts.dry) return { ok: true, estado: "dry", categoria, faltantes, registro }

  const r = await fetch(`${API()}/crm/v3/${MODULO}`, { method: "POST", headers: H, cache: "no-store", body: JSON.stringify({ data: [registro] }) })
  const j = (await r.json().catch(() => ({}))) as { data?: Array<{ code?: string; message?: string; details?: { id?: string; api_name?: string } }> }
  const ticketId = limpio(j?.data?.[0]?.details?.id)
  if (!r.ok || !ticketId) {
    const det = `${j?.data?.[0]?.code || r.status}: ${j?.data?.[0]?.message || ""} ${j?.data?.[0]?.details?.api_name || ""}`.trim()
    console.warn(`[ticket-st] ${quoteId}: no se creó — ${det}`)
    return { ok: false, estado: "error", detalle: det, faltantes, registro }
  }
  const creado = await getZoho<{ Name?: string }>(H, `/crm/v3/${MODULO}/${ticketId}?fields=Name`)
  const numero = limpio(creado?.Name)

  // Planilla de equipos desde la NDV.
  let planilla: "campo" | "adjunto" | "no" = "no"
  try {
    const buf = escribirXlsx("Equipos Asistencia WIFI-LAN", filasPlanillaEquipos(d))
    const fname = `Planilla equipos asistencia 2025 - ${limpio(d.empresa).replace(/[^\w.-]+/g, "_").slice(0, 40) || "empresa"}.xlsx`
    planilla = await adjuntarPlanilla(H, ticketId, buf, fname)
  } catch (e) {
    console.warn("[ticket-st] planilla:", e instanceof Error ? e.message : e)
  }

  await setKvValue(clave, JSON.stringify({ ticketId, numero, categoria, planilla, faltantes, at: new Date().toISOString() })).catch(() => {})
  // Nota en la IMP para que el implementador sepa que el envío/instalación ya está pedido.
  if (impId) {
    fetch(`${API()}/crm/v3/Implementaciones/${impId}/Notes`, {
      method: "POST", headers: H, cache: "no-store",
      body: JSON.stringify({ data: [{ Note_Title: `Ticket ST ${numero || ""} (${categoria}) creado por Vicky`, Note_Content: `${nombreTicketST(d)} · NDV ${d.ndvNombre} · ${d.soNumero} · ${d.equipos.map((e) => `${e.cantidad} × ${e.nombre}`).join(", ")} · ${[d.direccion, d.comuna, d.region].filter(Boolean).join(", ") || "dirección por confirmar"}${faltantes.length ? ` · FALTA: ${faltantes.join(", ")}` : ""}` }] }),
    }).catch(() => {})
  }
  await avisarEquipoInterno(
    `🛠️ Ticket ST ${numero || ticketId} (${categoria}) creado para ${d.empresa} · ${d.ndvNombre} / ${d.soNumero} · ${d.equipos.map((e) => `${e.cantidad} × ${e.nombre}`).join(", ")} · ${[d.direccion, d.comuna, d.region].filter(Boolean).join(", ") || "SIN dirección"} · ejecutivo ${d.ejecutivoNombre} · planilla: ${planilla}${faltantes.length ? ` · FALTA: ${faltantes.join(", ")}` : ""}`,
  ).catch(() => {})
  return { ok: true, estado: "creado", ticketId, numero, categoria, faltantes, planilla }
}
