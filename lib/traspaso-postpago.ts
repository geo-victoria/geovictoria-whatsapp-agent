/**
 * Cierre de cadencia + TRASPASO post-pago, compartido por dos vías:
 *
 *   1. Webhook vic-quote-notify (tiempo real): el cotizador avisa al pagar.
 *   2. Barrido horario en vic-deal-stage-cron (red de seguridad): cubre el
 *      caso Constanza/COT233 (20-jul) — el cotizador registró el pago pero el
 *      request al agente nunca salió (faltan VICKY_AGENT_NOTIFY_URL /
 *      VICKY_AGENT_CRON_SECRET en su Vercel) y el cliente quedó sin traspaso
 *      y con la llamada agendada viva.
 *
 * Idempotente: el traspaso se envía UNA vez por cotización (candado kv
 * traspaso_postpago_<quoteId>), venga por la vía que venga.
 */

import {
  appendAssistantV3,
  closeFollowup,
  findContactByQuoteId,
  getKvValue,
  getQuotePointers,
  setKvValue,
} from "./supabase-persistence-v3"
import { cancelPendingCallbacks } from "./dapta-voice"
import { sendBotmakerMessage } from "./botmaker-push-v3"
import { PERFIL_CO } from "./paises/co"
import { obtenerLinkOnboarding } from "./tools/registrar-comprobante-transferencia"
import { pagoCierraLoop } from "./loop-v2"
import { onboardingEnabled, claveFase, claveBorrador } from "./onboarding/fase"
import { mensajeKickoffCL } from "./onboarding/prompt"
import { entregarKickoffOnboarding } from "./onboarding-canal"
import { parsearBorrador, sembrarBorrador, type Borrador } from "./onboarding/borrador"

export type ResultadoTraspaso = {
  contact?: string
  traspaso: "enviado" | "ya_enviado" | "push_fallo" | "omitido" | "sin_contacto"
}

/**
 * Cierra toda la proactividad del contacto dueño de la cotización (nudges,
 * anuncios y llamadas agendadas) y, si `enviarTraspaso`, le presenta a su
 * ejecutivo humano. Best-effort en cada paso; nunca lanza.
 */
export async function cerrarYTraspasarPostPago(
  quoteId: string,
  opts: { enviarTraspaso?: boolean } = {},
): Promise<ResultadoTraspaso> {
  const enviarTraspaso = opts.enviarTraspaso !== false
  const contact = await findContactByQuoteId(quoteId).catch(() => null)
  if (!contact) return { traspaso: "sin_contacto" }

  await closeFollowup(contact, "cotizacion_aceptada").catch(() => {})
  await cancelPendingCallbacks(contact).catch(() => {})
  // Regla de oro del Loop v2: el PAGO corta el loop de toques para siempre
  // (best-effort; con el flag apagado o sin fila en vic_loop es un no-op).
  await pagoCierraLoop(contact).catch(() => {})

  const esCO = contact.startsWith("57")
  const esMX = contact.startsWith("521") || (contact.startsWith("52") && contact.length === 12)
  const esCL = !esCO && !esMX
  // Vicky onboarding — CHILE PRIMERO (decisión 26-jul): el pago es la ÚNICA
  // puerta que mueve al contacto de venta a onboarding. CO y MX siguen con el
  // traspaso a ejecutivo humano hasta que la fase se abra para ellos.
  let borradorSembrado: Borrador | null = null
  if (onboardingEnabled() && esCL) {
    await setKvValue(claveFase(contact), "onboarding").catch(() => {})
    // Sembrar el borrador con lo que la VENTA ya sabe (regla de Eduardo,
    // 26-jul: no volver a preguntar lo que el cliente ya dio — confirmarlo o
    // actualizarlo). La cotización PAGADA trae razón social y RUT; si el
    // contacto ya dijo algo en la fase, eso queda por encima de la semilla.
    try {
      const pointers = await getQuotePointers(contact)
      const pagada = pointers.find((p) => p.quoteId === quoteId) || pointers[0]
      const previo = parsearBorrador(await getKvValue(claveBorrador(contact)).catch(() => null))
      borradorSembrado = sembrarBorrador(
        previo,
        { empresa: { nombre: pagada?.empresa, identificador: pagada?.rut } },
        "cl",
      )
      await setKvValue(claveBorrador(contact), JSON.stringify(borradorSembrado))
    } catch {
      borradorSembrado = null
    }
  }

  if (!enviarTraspaso) return { contact, traspaso: "omitido" }

  const kvKey = `traspaso_postpago_${quoteId}`
  const ya = await getKvValue(kvKey).catch(() => null)
  if (ya) return { contact, traspaso: "ya_enviado" }

  // Vicky AUTÓNOMA en CL (decisión 26-jul): con el flag encendido NO se
  // presenta a ningún ejecutivo — el mismo mensaje de bienvenida abre el alta
  // por chat, y el gate del webhook atiende las respuestas con el agente de
  // onboarding. Reemplaza al bloque del ejecutivo, no lo suma.
  if (onboardingEnabled() && esCL) {
    const kickoff = mensajeKickoffCL(borradorSembrado ?? undefined)
    // Fuera de la ventana de 24 h el texto libre muere en silencio (el cliente
    // pudo pagar un domingo tras dos días callado). Ahí va la plantilla HSM,
    // que reabre la ventana; el agente retoma cuando el cliente responde.
    const via = await entregarKickoffOnboarding(
      contact,
      kickoff,
      borradorSembrado?.empresa.nombre,
    )
    if (via === "fallo") return { contact, traspaso: "push_fallo" }
    await setKvValue(kvKey, new Date().toISOString()).catch(() => {})
    // Solo el texto libre es un mensaje de Vicky: la plantilla es un disparador
    // y meterla al historial le daría al modelo un turno que no dijo.
    if (via === "texto") await appendAssistantV3(contact, kickoff, "cl").catch(() => {})
    return { contact, traspaso: "enviado" }
  }

  const ejecutivo = esMX
    ? { nombre: "Yahel Segura", email: "ysegura@geovictoria.com", telefono: "+52 55 3763 6604" }
    : esCO
      ? PERFIL_CO.equipo.ejecutivo
      : { nombre: "Anderson Díaz", email: "adiazg@geovictoria.com", telefono: "+56 9 3937 2058" }
  // Caso Jessica/JEANSCO (24-jul): el mensaje de bienvenida DEBE traer el link
  // del auto-onboarding — antes solo presentaba al ejecutivo y el cliente
  // tenía que encontrar el wizard por su cuenta. El endpoint es idempotente.
  const linkOnboarding = await obtenerLinkOnboarding(quoteId).catch(() => "")
  const traspaso =
    `¡Felicitaciones y bienvenido a GeoVictoria! 🎉 Tu pago quedó registrado.\n\n` +
    (linkOnboarding
      ? `Para dejar tu empresa configurada y lista para operar, completa tu auto-onboarding aquí (toma ~10 minutos):\n👉 ${linkOnboarding}\n\n`
      : "") +
    `De aquí en adelante te acompaña *${ejecutivo.nombre}*, tu ejecutivo comercial, quien te contactará para coordinar la puesta en marcha:\n` +
    (ejecutivo.telefono ? `📱 ${ejecutivo.telefono}\n` : "") +
    `✉️ ${ejecutivo.email}`
  const pushed = await sendBotmakerMessage(
    contact,
    traspaso,
    esCO ? PERFIL_CO.canal.channelId : undefined,
  ).catch(() => false)
  if (!pushed) return { contact, traspaso: "push_fallo" }
  await setKvValue(kvKey, new Date().toISOString()).catch(() => {})
  await appendAssistantV3(contact, traspaso, esCO ? "co" : "cl").catch(() => {})
  return { contact, traspaso: "enviado" }
}
