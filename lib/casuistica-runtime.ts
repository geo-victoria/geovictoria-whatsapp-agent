/**
 * Casuística del contacto — capa con RED (la pura vive en casuistica-contacto).
 *
 *  - casuisticaDeContacto(fono): lee los últimos 40 mensajes del cliente y
 *    clasifica (determinista, sin modelo).
 *  - aplicarCasuisticaNoProspecto(fono, c, origen): efectos best-effort cuando
 *    el contacto NO es prospecto: marca la conversación como soporte (sale de
 *    relojes y toques), cierra el loop con motivo propio y, SOLO para leads
 *    que Vicky creó DESDE HOY (nunca data histórica — orden de Lalo 08-sep),
 *    los deja "No Calificado" con el motivo correcto y una nota.
 *
 * Todo fuera del camino de la respuesta al cliente: si algo falla, la
 * conversación sigue igual (principio rector 24-jul).
 */

import { clasificarCasuistica, motivoCierreLoop, type Casuistica } from "./casuistica-contacto"
import { fetchHistoryV3, getKvValue, setKvValue, marcarConversacionSoporte } from "./supabase-persistence-v3"

/** Solo leads creados desde este instante se auto-marcan. La data anterior no se toca. */
export const CASUISTICA_DESDE = "2026-09-08T21:00:00.000Z"
const VICKY_OWNER_ID = "3525045000484500876"

export async function casuisticaDeContacto(contact: string): Promise<Casuistica> {
  const clean = (contact || "").replace(/\D/g, "")
  try {
    const historial = await fetchHistoryV3(clean, 40)
    const mensajes = historial
      .filter((m) => m.role === "user")
      .map((m) => String(m.content || ""))
      .filter((t) => !t.startsWith("[REGISTRO INTERNO"))
    return clasificarCasuistica(mensajes)
  } catch {
    return clasificarCasuistica([])
  }
}

export async function aplicarCasuisticaNoProspecto(contact: string, c: Casuistica, origen: string): Promise<void> {
  const clean = (contact || "").replace(/\D/g, "")
  if (!clean || c.esProspecto) return
  const candado = `casuistica_aplicada_${clean}`
  try {
    const previa = await getKvValue(candado)
    if (previa === c.tipo) return
    await setKvValue(candado, c.tipo)
  } catch { /* sin candado: sigue */ }
  console.log(`[casuistica] ${clean}: ${c.tipo} (${origen}) — evidencia: ${c.evidencia.join(", ")}`)
  const pais = clean.startsWith("57") ? "co" : clean.startsWith("52") ? "mx" : clean.startsWith("51") ? "pe" : "cl"
  // 1) Conversación de soporte / no comercial: sin cadencia, sin relojes.
  await marcarConversacionSoporte(clean, pais).catch(() => {})
  // 2) Loop cerrado con motivo propio (excluido de toques y traspasos).
  try {
    const { mas50CierraLoop } = await import("./loop-v2")
    await mas50CierraLoop(clean, motivoCierreLoop(c))
  } catch { /* best-effort */ }
  // 3) Lead de Vicky creado DESDE HOY → No Calificado con motivo + nota.
  try {
    const leadId = ((await getKvValue(`zoho_lead_${clean}`)) || "").trim()
    if (!/^\d{6,}$/.test(leadId) || !c.motivoZoho) return
    const { getZohoAccessToken } = await import("./zoho-token")
    const token = await getZohoAccessToken()
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
    const r = await fetch(`${api}/crm/v3/Leads/${leadId}?fields=Lead_Status,Motivo_No_calificado,Owner,Created_Time,Converted__s`, { headers: H, cache: "no-store" })
    if (r.status !== 200) return
    const lead = ((await r.json().catch(() => ({}))) as { data?: Array<{ Lead_Status?: string; Owner?: { id?: string; email?: string }; Created_Time?: string; Converted__s?: boolean }> }).data?.[0]
    if (!lead || lead.Converted__s) return
    if (!lead.Created_Time || new Date(lead.Created_Time).getTime() < new Date(CASUISTICA_DESDE).getTime()) return
    if (/no calificado/i.test(String(lead.Lead_Status || ""))) return
    const ownerId = String(lead.Owner?.id || "")
    const ownerEmail = String(lead.Owner?.email || "")
    const roster = ((process.env.VICKY_TM_ROSTER_CALIFICACION_EMAILS || "aaraque@geovictoria.com,asepulveda@geovictoria.com").split(",").map((s) => s.trim().toLowerCase()))
    // Solo leads sin gestión humana real: los de Vicky o los recién entregados al roster SDR.
    if (ownerId !== VICKY_OWNER_ID && !roster.includes(ownerEmail.toLowerCase())) return
    const put = await fetch(`${api}/crm/v3/Leads`, {
      method: "PUT", headers: H, cache: "no-store",
      body: JSON.stringify({ data: [{ id: leadId, Lead_Status: "No Calificado", Motivo_No_calificado: c.motivoZoho }], trigger: ["blueprint"], skip_feature_execution: [{ name: "assignment_rules" }] }),
    })
    const body = (await put.json().catch(() => ({}))) as { data?: Array<{ code?: string; message?: string }> }
    const ok = put.ok && body?.data?.[0]?.code === "SUCCESS"
    await fetch(`${api}/crm/v3/Notes`, {
      method: "POST", headers: H, cache: "no-store",
      body: JSON.stringify({
        data: [{
          Note_Title: `Casuística Vicky: ${c.tipo} (no es prospecto)`,
          Note_Content:
            `Vicky detectó en el chat que este contacto no es un prospecto de venta (${c.tipo}). Evidencia: ${c.evidencia.join(", ") || "-"}. ` +
            `${ok ? `Lead dejado en "No Calificado / ${c.motivoZoho}".` : `No se pudo cambiar el estado automáticamente (${JSON.stringify(body).slice(0, 120)}) — corresponde "No Calificado / ${c.motivoZoho}".`} ` +
            `La conversación quedó como soporte/no comercial: sin traspaso ni seguimiento.`,
          Parent_Id: leadId, $se_module: "Leads",
        }],
      }),
    }).catch(() => null)
    console.log(`[casuistica] ${clean}: lead ${leadId} → No Calificado / ${c.motivoZoho} (${ok ? "ok" : "PUT no aplicó"})`)
  } catch (e) {
    console.warn(`[casuistica] ${clean}: efectos fallaron:`, e instanceof Error ? e.message : e)
  }
}
