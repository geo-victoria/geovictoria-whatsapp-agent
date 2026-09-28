/**
 * HITO DE INTENCIÓN SIN TOOL (arreglo 2, VB Lalo 07-sep).
 *
 * En el guion consultivo 21+ Vicky conversa varios turnos sin llamar ninguna
 * tool, y los hitos del CRM solo se disparaban con tools: un cliente con
 * dotación y RUT dados a las 07:55 (Conbes) no existía en Zoho a las 10:00,
 * y el traspaso del reloj lo creó ciego y lo entregó a las SDR. Acá, apenas
 * el chat tiene un RUT válido del cliente, se dispara el hito "intencion" con
 * lo que ya dijo (nombre/empresa/dotación/correo/RUT): la escalera del CRM
 * decide sola — RUT + >20 → deal + Tómbola Deals; ≤20 → lead pre-formal con
 * Vicky (el deal nace con la formal, regla intacta).
 *
 * Una sola vez por conversación (candado kv `hito_chat_<fono>`). Best-effort:
 * jamás toca la respuesta al cliente.
 */
import { getKvValue, setKvValue } from "./supabase-persistence-v3"

export async function hitoIntencionDesdeChat(contact: string): Promise<"disparado" | "sin_rut" | "ya" | "omitido"> {
  const clean = (contact || "").replace(/\D/g, "")
  // Los 4 países (27-sep): RUT · RUC · NIT · RFC, cada uno con su tómbola
  // "Deals 2026" por territorio.
  if (!["56", "51", "57", "52"].some((p) => clean.startsWith(p))) return "omitido"
  const candado = `hito_chat_${clean}`
  try {
    if (await getKvValue(candado)) return "ya"
    const { datosDelChat } = await import("./extraer-datos-chat")
    const datos = await datosDelChat(clean, { soloSiHayRut: true })
    if (!datos.rut) return "sin_rut"
    await setKvValue(candado, new Date().toISOString()).catch(() => {})
    const { sincronizarHitoCrm } = await import("./crm-hitos")
    await sincronizarHitoCrm(clean, "intencion", {
      nombre: datos.nombre,
      empresa: datos.empresa,
      email: datos.email,
      rut: datos.rut,
      empleados: datos.empleados,
    })
    console.log(
      `[hito-por-chat] ${clean}: hito intencion por ${clean.startsWith("51") ? "RUC" : clean.startsWith("57") ? "NIT" : "RUT"} en el chat (empleados=${datos.empleados ?? "?"}, empresa=${datos.empresa || "?"})`,
    )
    return "disparado"
  } catch (e) {
    console.warn(`[hito-por-chat] ${clean}:`, e instanceof Error ? e.message : e)
    return "omitido"
  }
}

/**
 * RUC EN EL NOMBRE DEL TRATO DESDE EL CHAT (Perú, Lalo 28-sep: "toma también
 * los que den RUC en el chat"). El cotizador ya lo pone al emitir la formal;
 * esto cubre los tratos que nacen antes (hito, traspaso) cuando el cliente
 * escribe su RUC. RUC leído con el validador (sin modelo), solo de mensajes
 * del CLIENTE. Candado `ruc_trato_<fono>` solo cuando el trato quedó con el
 * RUC; sin trato todavía, se reintenta en el turno siguiente. Best-effort.
 */
export async function rucEnTratoDesdeChat(contact: string): Promise<"renombrado" | "ya" | "sin_ruc" | "sin_trato" | "omitido"> {
  const clean = (contact || "").replace(/\D/g, "")
  if (!clean.startsWith("51")) return "omitido"
  const candado = `ruc_trato_${clean}`
  try {
    if (await getKvValue(candado)) return "ya"
    const { fetchHistoryV3 } = await import("./supabase-persistence-v3")
    const hist = await fetchHistoryV3(clean, 60).catch(() => [])
    const delCliente = hist
      .filter((m) => m.role === "user")
      .map((m) => String(m.content || ""))
      .join("\n")
    const { rucEnTexto } = await import("./rut")
    const ruc = rucEnTexto(delCliente)
    if (!ruc) return "sin_ruc"
    const { dealActivoEnKv } = await import("./crm-hitos")
    const dealId = await dealActivoEnKv(clean)
    if (!dealId) return "sin_trato"
    const { getZohoAccessToken } = await import("./zoho-token")
    const token = await getZohoAccessToken()
    const api = process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com"
    const h = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
    const r = await fetch(`${api}/crm/v3/Deals/${dealId}?fields=Deal_Name`, { headers: h, cache: "no-store" })
    const d = (await r.json().catch(() => ({}))) as { data?: Array<{ Deal_Name?: string }> }
    const actual = String(d?.data?.[0]?.Deal_Name || "")
    if (!actual) return "sin_trato"
    const { nombreTratoConRuc } = await import("./nombre-trato-ruc")
    const nuevo = nombreTratoConRuc(actual, ruc)
    if (nuevo !== actual) {
      const put = await fetch(`${api}/crm/v3/Deals`, {
        method: "PUT",
        headers: h,
        cache: "no-store",
        body: JSON.stringify({ data: [{ id: dealId, Deal_Name: nuevo }], trigger: [] }),
      })
      const pj = (await put.json().catch(() => ({}))) as { data?: Array<{ code?: string }> }
      if (pj?.data?.[0]?.code !== "SUCCESS") {
        console.warn(`[ruc-trato] ${clean}: no se pudo renombrar el trato ${dealId}`)
        return "sin_trato"
      }
      console.log(`[ruc-trato] ${clean}: trato ${dealId} → "${nuevo}"`)
    }
    await setKvValue(candado, new Date().toISOString()).catch(() => {})
    return nuevo !== actual ? "renombrado" : "ya"
  } catch (e) {
    console.warn(`[ruc-trato] ${clean}:`, e instanceof Error ? e.message : e)
    return "omitido"
  }
}
