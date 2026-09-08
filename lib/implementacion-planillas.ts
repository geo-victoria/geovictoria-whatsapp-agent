/**
 * PLANILLAS DEL WIZARD → IMPLEMENTACIÓN (Lalo 08-sep, caso Haus IMP-11441).
 *
 * Cuando la configuración se cierra por chat, el wizard genera los dos Excel
 * (usuarios + planificaciones) y dispara su Zoho Flow — pero ese Flow NO
 * encuentra la Implementación que nosotros creamos al alta (GV Avanzado), así
 * que la IMP quedaba SIN planillas. Las implementaciones nacidas del wizard
 * las llevan como nota "planillas" con los dos archivos adjuntos (IMP-11176).
 * Acá se replica ese formato: se bajan los Excel de la sesión del wizard (URL
 * firmada 14 d) y se suben como adjuntos de una nota en la IMP. Idempotente
 * por nombre de archivo (kv `onb_planillas_imp_`). Best-effort: nunca lanza.
 */

import { getZohoAccessToken } from "./zoho-token"
import { getKvValue, setKvValue } from "./supabase-persistence-v3"
import { clavePlanillasImp } from "./onboarding/fase"
import { planillaUsuariosXlsx, rutPlanilla, type FilaPlanillaUsuario } from "./escribir-excel"
import type { Configuracion } from "./onboarding/configuracion"
import type { Borrador } from "./onboarding/borrador"

const API = () => (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const WIZARD_URL = (process.env.VICKY_ONBOARDING_WIZARD_URL || "https://onboarding.geovictoria.com").trim().replace(/\/+$/, "")
export const TITULO_NOTA_PLANILLAS = "Planillas de ingreso (Vicky)"

export type PlanillaWizard = { tipo: "usuarios" | "planificaciones"; filename: string; url?: string; buffer?: Buffer }
type Registro = { impId: string; notaId: string; archivos: string[]; campo?: string }

/**
 * PLANILLA DESDE LA NÓMINA DEL CHAT (Lalo 08-sep, caso Molinas IMP-11428:
 * "vicky le dijo que ya cargó toda su data pero no veo plantillas de ingreso
 * en la implementación"). El wizard solo genera Excel cuando el cliente
 * CONFIRMA la configuración; si dio la nómina por chat y no confirmó, la
 * planilla se arma acá con las mismas 11 columnas (admin primero).
 */
export function planillaDesdeConfiguracion(config: Partial<Configuracion> | null | undefined, borrador: Borrador | null | undefined): PlanillaWizard | null {
  const trabajadores = (config?.trabajadores || []).filter((t) => String(t?.rut || "").trim())
  if (!trabajadores.length) return null
  const rutEmpresa = String(borrador?.empresa?.identificador || "").trim()
  const filas: FilaPlanillaUsuario[] = []
  const admin = borrador?.admin
  if (admin?.identificador || admin?.email) {
    filas.push({ rut: String(admin.identificador || ""), correo: admin.email || "", nombres: admin.nombre || "", apellidos: admin.apellido || "", tipo: "administrador" })
  }
  for (const t of trabajadores) {
    filas.push({ rut: String(t.rut || ""), correo: t.correo, nombres: t.nombres, apellidos: t.apellidos, grupo: t.grupo, telefono1: t.telefono1, telefono2: t.telefono2, telefono3: t.telefono3, tipo: "usuario" })
  }
  const rutKey = rutPlanilla(rutEmpresa) || "sin-rut"
  return {
    tipo: "usuarios",
    filename: `usuarios-${rutKey}-vicky-${trabajadores.length}.xlsx`,
    buffer: planillaUsuariosXlsx(rutEmpresa, filas),
  }
}

/** Sube el Excel al campo de archivo `Planilla_de_Ingreso` de la IMP (obligatorio para SMB) si está vacío. */
async function subirAlCampoPlanilla(token: string, impId: string, buf: ArrayBuffer, filename: string): Promise<boolean> {
  const H = { Authorization: `Zoho-oauthtoken ${token}` }
  const actual = await fetch(`${API()}/crm/v3/Implementaciones/${impId}?fields=Planilla_de_Ingreso`, { headers: H, cache: "no-store" })
  const rec = ((await actual.json().catch(() => ({}))) as { data?: Array<{ Planilla_de_Ingreso?: unknown[] }> }).data?.[0]
  if (Array.isArray(rec?.Planilla_de_Ingreso) && rec!.Planilla_de_Ingreso!.length) return true
  const form = new FormData()
  form.append("file", new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), filename)
  const up = await fetch(`${API()}/crm/v3/files`, { method: "POST", headers: H, body: form, cache: "no-store" })
  const uj = (await up.json().catch(() => ({}))) as { data?: Array<{ details?: { id?: string }; code?: string }> }
  const fileId = uj?.data?.[0]?.details?.id || ""
  if (!up.ok || !fileId) {
    console.warn(`[imp-planillas] subida a /files falló ${up.status}: ${JSON.stringify(uj).slice(0, 200)}`)
    return false
  }
  const put = await fetch(`${API()}/crm/v3/Implementaciones`, {
    method: "PUT", headers: { ...H, "Content-Type": "application/json" }, cache: "no-store",
    body: JSON.stringify({ data: [{ id: impId, Planilla_de_Ingreso: [{ file_id: fileId }] }], trigger: ["blueprint"] }),
  })
  const pj = (await put.json().catch(() => ({}))) as { data?: Array<{ code?: string; message?: string }> }
  const ok = put.ok && pj?.data?.[0]?.code === "SUCCESS"
  if (!ok) console.warn(`[imp-planillas] campo Planilla_de_Ingreso no se pudo fijar: ${JSON.stringify(pj).slice(0, 200)}`)
  return ok
}

/** Excel disponibles en la sesión del wizard del contacto (vacío si nunca se cerró). */
export async function planillasDeSesionWizard(contact: string): Promise<PlanillaWizard[]> {
  const token = (await getKvValue(`onboarding_wizard_token_${contact}`).catch(() => null)) || ""
  if (!token) return []
  try {
    const r = await fetch(`${WIZARD_URL}/api/onboarding/${encodeURIComponent(token)}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) })
    if (!r.ok) return []
    const ses = (await r.json().catch(() => ({}))) as { formData?: Record<string, unknown> }
    const fd = (ses.formData || {}) as {
      excelUrls?: Partial<Record<"usuarios" | "planificaciones", { filename?: string; url?: string }>>
      excelUrlUsuarios?: string
      excelUrlPlanificaciones?: string
    }
    const out: PlanillaWizard[] = []
    for (const tipo of ["usuarios", "planificaciones"] as const) {
      const url = String(fd.excelUrls?.[tipo]?.url || (tipo === "usuarios" ? fd.excelUrlUsuarios : fd.excelUrlPlanificaciones) || "").trim()
      if (!url) continue
      const filename =
        String(fd.excelUrls?.[tipo]?.filename || "").trim() || decodeURIComponent(url.split("?")[0].split("/").pop() || `${tipo}.xlsx`)
      out.push({ tipo, filename, url })
    }
    return out
  } catch {
    return []
  }
}

async function subirAdjuntoNota(token: string, notaId: string, impId: string, buf: ArrayBuffer, filename: string): Promise<boolean> {
  const form = new FormData()
  form.append("file", new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), filename)
  const H = { Authorization: `Zoho-oauthtoken ${token}` }
  let r = await fetch(`${API()}/crm/v3/Notes/${notaId}/Attachments`, { method: "POST", headers: H, body: form, cache: "no-store" })
  if (r.ok) return true
  const detalle = await r.text().catch(() => "")
  console.warn(`[imp-planillas] adjunto a nota ${notaId} falló ${r.status}: ${detalle.slice(0, 200)} — reintento sobre la IMP`)
  const form2 = new FormData()
  form2.append("file", new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), filename)
  r = await fetch(`${API()}/crm/v3/Implementaciones/${impId}/Attachments`, { method: "POST", headers: H, body: form2, cache: "no-store" })
  if (!r.ok) console.warn(`[imp-planillas] adjunto a IMP ${impId} falló ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`)
  return r.ok
}

/**
 * Deja las planillas del wizard en la Implementación (nota + adjuntos).
 * Devuelve qué archivos quedaron (nuevos + ya estaban) y nunca lanza.
 */
export async function adjuntarPlanillasImplementacion(
  contact: string,
  impId: string,
  empresa: string,
  detalle = "",
  fuente: { config?: Partial<Configuracion> | null; borrador?: Borrador | null } = {},
): Promise<{ ok: boolean; archivos: string[]; nuevos: string[]; notaId?: string; motivo?: string; campo?: string }> {
  const fono = (contact || "").replace(/\D/g, "")
  try {
    let planillas = await planillasDeSesionWizard(fono)
    const hayNomina = (fuente.config?.trabajadores || []).some((t) => String(t?.rut || "").trim())
    // Interruptor vic_kv `wizard_solo_excel`="on": solo cuando el wizard en
    // producción ya entiende `soloExcel` (sin eso el POST cerraría el
    // onboarding y dispararía el Zoho Flow).
    const wizardListo = (await getKvValue("wizard_solo_excel").catch(() => null)) === "on"
    if (!planillas.length && hayNomina && fuente.borrador && wizardListo) {
      // Lalo 08-sep: "usa como base las planillas que ya se han subido a otras
      // implementaciones" — el formato oficial lo produce el WIZARD (plantilla
      // PLANTILLA_INGRESO.xlsx + usuarios). Se le pide generarlas sin cerrar.
      try {
        const { generarPlanillasWizard } = await import("./wizard-sesion")
        const { configuracionVacia } = await import("./onboarding/configuracion")
        const g = await generarPlanillasWizard(fono, fuente.borrador, { ...configuracionVacia(), ...(fuente.config || {}) })
        if ("error" in g) console.warn(`[imp-planillas] ${fono}: wizard soloExcel falló: ${g.error}`)
        else planillas = await planillasDeSesionWizard(fono)
      } catch (e) {
        console.warn(`[imp-planillas] ${fono}: wizard soloExcel excepción:`, e instanceof Error ? e.message : e)
      }
    }
    if (!planillas.length) {
      const propia = planillaDesdeConfiguracion(fuente.config, fuente.borrador)
      if (propia) planillas = [propia]
    }
    if (!planillas.length) return { ok: false, archivos: [], nuevos: [], motivo: "sin nómina en el chat ni planillas del wizard" }
    let reg: Registro | null = null
    try {
      const raw = await getKvValue(clavePlanillasImp(fono))
      reg = raw ? (JSON.parse(raw) as Registro) : null
    } catch {
      reg = null
    }
    if (reg && reg.impId !== impId) reg = null
    const yaEstan = new Set(reg?.archivos || [])
    const pendientes = planillas.filter((p) => !yaEstan.has(p.filename))
    const usuarios = planillas.find((p) => p.tipo === "usuarios")
    const faltaCampo = Boolean(usuarios && reg?.campo !== usuarios.filename)
    if (!pendientes.length && !faltaCampo) return { ok: true, archivos: [...yaEstan], nuevos: [], notaId: reg?.notaId, campo: reg?.campo }

    const token = await getZohoAccessToken()
    const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
    let notaId = reg?.notaId || ""
    if (!notaId) {
      const contenido =
        `Planillas generadas desde la configuración que el cliente hizo por chat con Vicky (mismo formato del wizard de auto-onboarding). ` +
        `Adjuntas: ${planillas.map((p) => p.filename).join(" · ")}.\n` +
        `Sirven para cargar usuarios, turnos y planificaciones en la capacitación — el alta por chat NO crea usuarios en la plataforma.` +
        (detalle ? `\n\n${detalle}` : "")
      const r = await fetch(`${API()}/crm/v3/Notes`, {
        method: "POST",
        headers: H,
        cache: "no-store",
        body: JSON.stringify({
          data: [{ Note_Title: `${TITULO_NOTA_PLANILLAS} · ${empresa || fono}`.slice(0, 120), Note_Content: contenido.slice(0, 60000), Parent_Id: impId, $se_module: "Implementaciones" }],
        }),
      })
      const j = (await r.json().catch(() => ({}))) as { data?: Array<{ details?: { id?: string } }> }
      notaId = j?.data?.[0]?.details?.id || ""
      if (!notaId) return { ok: false, archivos: [...yaEstan], nuevos: [], motivo: `no se pudo crear la nota (${r.status})` }
    }
    const nuevos: string[] = []
    let campo = reg?.campo || ""
    const bytesDe = async (p: PlanillaWizard): Promise<ArrayBuffer | null> => {
      if (p.buffer) return p.buffer.buffer.slice(p.buffer.byteOffset, p.buffer.byteOffset + p.buffer.byteLength) as ArrayBuffer
      if (!p.url) return null
      const d = await fetch(p.url, { cache: "no-store", signal: AbortSignal.timeout(20_000) })
      if (!d.ok) {
        console.warn(`[imp-planillas] descarga ${p.filename} falló ${d.status}`)
        return null
      }
      const buf = await d.arrayBuffer()
      return buf.byteLength ? buf : null
    }
    for (const p of pendientes) {
      try {
        const buf = await bytesDe(p)
        if (!buf) continue
        if (await subirAdjuntoNota(token, notaId, impId, buf, p.filename)) nuevos.push(p.filename)
      } catch (e) {
        console.warn(`[imp-planillas] ${p.filename}:`, e instanceof Error ? e.message : e)
      }
    }
    // Campo de archivo de la IMP ("OBLIGATORIO para SMB", Lalo 08-sep): la planilla de usuarios.
    if (usuarios && faltaCampo) {
      try {
        const buf = await bytesDe(usuarios)
        if (buf && (await subirAlCampoPlanilla(token, impId, buf, usuarios.filename))) campo = usuarios.filename
      } catch (e) {
        console.warn(`[imp-planillas] campo Planilla_de_Ingreso:`, e instanceof Error ? e.message : e)
      }
    }
    const archivos = [...new Set([...yaEstan, ...nuevos])]
    await setKvValue(clavePlanillasImp(fono), JSON.stringify({ impId, notaId, archivos, campo } satisfies Registro)).catch(() => {})
    if (nuevos.length) console.log(`[imp-planillas] IMP ${impId}: adjuntos ${nuevos.join(", ")} (nota ${notaId}); campo Planilla_de_Ingreso=${campo || "-"}`)
    return { ok: archivos.length > 0, archivos, nuevos, notaId, campo, motivo: nuevos.length ? undefined : "descarga o subida fallida" }
  } catch (e) {
    console.warn("[imp-planillas] excepción:", e instanceof Error ? e.message : e)
    return { ok: false, archivos: [], nuevos: [], motivo: e instanceof Error ? e.message : String(e) }
  }
}
