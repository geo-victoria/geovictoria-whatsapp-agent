/**
 * Tags de Botmaker por conversación (pedido Lalo 28-jul): un tag POR PAÍS —
 * comercial_cl / comercial_co / comercial_mx — para que cada ejecutivo filtre
 * en la bandeja de Botmaker ("Por tag") y vea SOLO las conversaciones con
 * intención comercial de su país.
 *
 * Regla de oro: el tag se aplica por SEÑALES DETERMINISTAS de compra (vio
 * precio, cotización, reunión, callback, comprobante) — nunca por
 * clasificador. Una conversación de soporte no dispara ninguna de esas
 * tools, así que es imposible taguearla por accidente.
 *
 * API: PATCH /v2.0/chats/{chatReference} con body { tags: { nombre: true } }.
 * chatReference = "<línea>:<teléfono>" (la doc acepta la línea de WhatsApp
 * como channelId). Best-effort SIEMPRE: un fallo acá jamás afecta el turno.
 */

const BM_TOKEN = (process.env.BOTMAKER_ACCESS_TOKEN || "").trim()

// Líneas de WhatsApp por país (mismas fuentes que el resto del código).
export const LINEA_POR_PAIS: Record<string, string> = {
  cl: (process.env.BOTMAKER_CHANNEL_NUMBER || "56967308227").replace(/\D/g, ""),
  co: (process.env.BOTMAKER_CHANNEL_NUMBER_CO || "573181070737").replace(/\D/g, ""),
  mx: (process.env.BOTMAKER_CHANNEL_NUMBER_MX || "5215659778486").replace(/\D/g, ""),
  pe: (process.env.BOTMAKER_CHANNEL_NUMBER_PE || "51922067167").replace(/\D/g, ""),
}

/** País del contacto por prefijo telefónico; null si no es CL/CO/MX/PE. */
export function paisDeContacto(contact: string): "cl" | "co" | "mx" | "pe" | null {
  const c = (contact || "").replace(/\D/g, "")
  if (c.startsWith("56")) return "cl"
  if (c.startsWith("57")) return "co"
  if (c.startsWith("52")) return "mx"
  if (c.startsWith("51")) return "pe"
  return null
}

// Guard en memoria por instancia: evita repetir el PATCH en cada tool del
// mismo turno/proceso. Idempotente igual (poner el tag dos veces no daña),
// esto solo ahorra llamadas.
const yaTagueados = new Set<string>()

/**
 * Marca el chat del contacto como comercial de su país. Best-effort.
 */
export async function tagearChatComercial(contact: string): Promise<boolean> {
  try {
    const clean = (contact || "").replace(/\D/g, "")
    if (!clean || !BM_TOKEN) return false
    if (yaTagueados.has(clean)) return true
    const pais = paisDeContacto(clean)
    if (!pais) return false
    const linea = LINEA_POR_PAIS[pais]
    const tag = `comercial_${pais}`
    const res = await fetch(
      `https://api.botmaker.com/v2.0/chats/${encodeURIComponent(`${linea}:${clean}`)}`,
      {
        method: "PATCH",
        headers: {
          "access-token": BM_TOKEN,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ tags: { [tag]: true } }),
        cache: "no-store",
      },
    )
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      console.warn(`[botmaker-tags] PATCH ${tag} ${clean} → ${res.status}: ${body.slice(0, 200)}`)
      return false
    }
    yaTagueados.add(clean)
    console.log(`[botmaker-tags] ${clean} tagueado ${tag}`)
    return true
  } catch (e) {
    console.warn("[botmaker-tags] excepción:", e)
    return false
  }
}

/**
 * Tools cuyo ÉXITO es señal inequívoca de intención comercial. Soporte no
 * pasa por ninguna: derivar_a_soporte / consultar_agente_soporte quedan fuera
 * a propósito.
 */
export const TOOLS_SENAL_COMERCIAL = new Set([
  "cotizar_referencial",
  "consultar_descuento_referencial",
  "generar_link_cotizadora",
  "actualizar_cotizacion",
  "enviar_cotizacion_whatsapp",
  "consultar_disponibilidad_horario",
  "agendar_reunion",
  "reagendar_reunion",
  "registrar_solicitud_callback",
  "registrar_comprobante_transferencia",
])
