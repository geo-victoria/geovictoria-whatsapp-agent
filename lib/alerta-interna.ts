/**
 * Aviso interno al equipo — la red de seguridad de todo lo demás.
 *
 * Auditoría de barreras 20-jul: cuando una tool de registro (callback/reunión)
 * fallaba incluso tras el reintento forzado, el fallback le pedía al cliente
 * RE-TIPEAR nombre/empresa/teléfono que ya estaban en el historial (≥7 casos,
 * incluido un cliente urgido que los escribió 3 veces). Ahora el fallback no
 * re-pide nada: avisa al equipo con este helper para completar a mano.
 *
 * PERO EL AVISO ERA CIEGO (descubierto el 27-jul). Iba solo por
 * sendBotmakerMessage, que es TEXTO LIBRE: fuera de la ventana de 24h de
 * WhatsApp, Meta lo descarta en silencio y la función igual devuelve ok. El
 * número de destino es interno y casi nunca le escribe a Vicky — ese día
 * llevaba 47 horas sin hacerlo, así que la ventana estaba cerrada.
 *
 * O sea: Vicky le decía al cliente "ya avisé al equipo para que igual te
 * contacten" y ese aviso no llegaba a ninguna parte. La promesa era sincera y
 * el respaldo no existía. Es el peor lugar donde tener un fallo mudo, porque
 * este helper es justamente lo que sostiene todos los demás fallbacks.
 *
 * Ahora hay DOS canales y el orden importa:
 *   1. Se PERSISTE siempre en vic_v3_inbox (contact = "equipo:alerta"). Es
 *      durable, consultable y no depende de ninguna ventana.
 *   2. Se intenta el push por WhatsApp, best-effort.
 *
 * Devuelve si el push llegó a salir, para que quien llame pueda decidir. Nunca
 * lanza: un fallo del aviso no puede tumbar el turno del cliente.
 */

import { sendBotmakerMessage } from "./botmaker-push-v3"

const NOTIFY_TO = (process.env.QUOTE_NOTIFY_TO || process.env.VICKY_REPORT_PHONE || "56944668823")
  .trim()
  .replace(/\D/g, "")

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

/** Contacto sintético bajo el que viven las alertas del equipo. */
export const CONTACTO_ALERTAS = "equipo:alerta"

/**
 * Deja la alerta escrita en la base. Es el canal que NO puede fallar en
 * silencio: si el push de WhatsApp se pierde, la alerta sigue acá.
 */
async function persistirAlerta(texto: string): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return false
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/vic_v3_inbox`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify([{ contact: CONTACTO_ALERTAS, message: texto.slice(0, 4000) }]),
      cache: "no-store",
    })
    return res.ok
  } catch (e) {
    console.error("[alerta-interna] no se pudo persistir la alerta:", e)
    return false
  }
}

export async function avisarEquipoInterno(texto: string): Promise<boolean> {
  if (!texto) return false

  // 1. Durable primero: si el proceso muere después, la alerta ya está escrita.
  const persistida = await persistirAlerta(texto)

  // 2. Push best-effort. Fuera de la ventana de 24h esto se pierde y no hay
  //    forma de saberlo desde acá — por eso el paso 1 va antes y no depende.
  // INTERRUPTOR (Lalo 25-ago, "apaga las notificaciones internas a mi
  // whatsapp, solo ensucian cuando quiero hacer pruebas"): vic_kv
  // `avisos_internos_wsp` = "off" silencia SOLO el push de WhatsApp — la
  // alerta sigue persistida en vic_v3_inbox (paso 1) y visible en el dash.
  // Reactivar sin deploy: borrar la clave o ponerla en "on".
  let silenciado = false
  try {
    const { getKvValue } = await import("./supabase-persistence-v3")
    silenciado = ((await getKvValue("avisos_internos_wsp")) || "").trim().toLowerCase() === "off"
  } catch {
    /* sin kv legible, se avisa como siempre */
  }
  let enviada = false
  if (NOTIFY_TO && !silenciado) {
    enviada = await sendBotmakerMessage(NOTIFY_TO, texto).catch((e) => {
      console.error("[alerta-interna] push al equipo falló:", e)
      return false
    })
  }

  // Se registra el resultado de los dos canales: si un día nadie ve las
  // alertas, este log dice si fue por el push o por la base.
  console.warn(
    `[alerta-interna] persistida=${persistida} push=${enviada} texto=${JSON.stringify(texto.slice(0, 120))}`,
  )
  return enviada
}
