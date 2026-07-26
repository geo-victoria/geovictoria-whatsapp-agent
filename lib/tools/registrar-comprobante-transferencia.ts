/**
 * Registro de comprobantes de transferencia enviados por WhatsApp.
 *
 * v1 VALIDAR + NOTIFICAR (decisión Lalo 17-jul): Vicky confirma la RECEPCIÓN
 * al cliente y deja el comprobante en manos del equipo; la confirmación del
 * PAGO la hace finanzas tras verificar en el banco. NUNCA se marca la
 * cotización como pagada desde acá (un comprobante adulterado no debe gatillar
 * el post-venta). Contexto: 2 de las 12 primeras ventas pagaron por
 * transferencia y quedaron INVISIBLES para el sistema (Supermercado Sur,
 * ELEAM) — esta tool cierra ese hoyo de visibilidad.
 *
 * v2 VALIDACIÓN BLANDA (decisión Lalo 26-jul, MVP/piloto de revenue): la
 * verificación bancaria deja de BLOQUEAR al cliente. Si Vicky pudo leer el
 * comprobante, el acceso al onboarding sale en ese mismo turno; finanzas sigue
 * verificando en paralelo, ahora como auditoría. Si el abono no aparece, el
 * equipo corta el onboarding a mano. Antes el cliente ya había pagado y quedaba
 * esperando hasta 24 horas hábiles — justo el punto donde la inmediatez (la
 * ventaja central de Vicky) se caía.
 *
 * Aplica a CL y MX. Colombia no entra: paga solo con tarjeta vía MercadoPago y
 * su set de tools no expone esta función.
 *
 * Qué hace:
 *   1. Asocia el comprobante a la cotización formal VIGENTE del contacto
 *      (puntero multi-RUT más reciente).
 *   2. Deja una NOTA en la cotización de Zoho con el detalle detectado.
 *   3. Avisa al equipo por WhatsApp (best-effort, ventana de 24h mediante),
 *      marcando si hubo habilitación blanda para que finanzas sepa que el
 *      cliente ya está adentro.
 *   4. Devuelve mensajeParaProspecto: recepción confirmada + acceso al
 *      onboarding si el comprobante era legible. Sin afirmar JAMÁS que el pago
 *      quedó confirmado — se confirma la recepción, no el dinero.
 */

import { getQuotePointers } from "@/lib/supabase-persistence-v3"
import { getZohoAccessToken } from "@/lib/zoho-token"
import { sendBotmakerMessage } from "@/lib/botmaker-push-v3"

const QUOTE_MODULE = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
const ZOHO_API_DOMAIN = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
// Mismo destinatario interno que las notificaciones de cotización (Eduardo).
const NOTIFY_TO = (process.env.QUOTE_NOTIFY_TO || process.env.VICKY_REPORT_PHONE || "56944668823")
  .trim()
  .replace(/\D/g, "")

export const registrarComprobanteTransferenciaSchema = {
  name: "registrar_comprobante_transferencia",
  description:
    "Registra un comprobante de transferencia bancaria que el cliente envió por el chat (imagen o PDF descrito en el historial). Úsala SIEMPRE que el cliente mande un comprobante de pago de su cotización. Extrae del comprobante lo que se vea: monto transferido, banco y fecha. La tool asocia el comprobante a la cotización vigente, avisa al equipo de finanzas y devuelve el mensajeParaProspecto: si el comprobante era legible, ese mensaje YA incluye el acceso al onboarding para que el cliente configure su cuenta de inmediato. Copia el mensajeParaProspecto TAL CUAL, con el link incluido. IMPORTANTE sobre montoDetectado: es lo que decide si el cliente queda habilitado al toque o tiene que esperar la revisión del equipo — pásalo solo si lo LEÍSTE en el comprobante; si no se alcanza a leer, pasa 0 (nunca lo inventes ni lo deduzcas del precio de la cotización). Y nunca afirmes tú que el pago quedó confirmado: se confirma la recepción, no el dinero.",
  input_schema: {
    type: "object" as const,
    properties: {
      montoDetectado: {
        type: "number" as const,
        description:
          "Monto en CLP que muestra el comprobante (solo dígitos, sin puntos). Si la imagen no deja leer el monto, pasa 0.",
      },
      bancoOrigen: { type: "string" as const, description: "Banco emisor si se ve en el comprobante." },
      fechaDetectada: { type: "string" as const, description: "Fecha de la transferencia si se ve." },
      detalle: {
        type: "string" as const,
        description: "Resumen en una frase de lo que muestra el comprobante (destinatario, hora, nro de operación).",
      },
      pagoDeclarado: {
        type: "boolean" as const,
        description:
          "true cuando el cliente DECLARA que pagó ('el pago está listo', 'ya transferí') pero NO ha enviado el comprobante. Registra el aviso para que finanzas verifique el abono, sin afirmar confirmación.",
      },
    },
    required: ["montoDetectado"],
  },
}

type Input = {
  montoDetectado?: number
  bancoOrigen?: string
  fechaDetectada?: string
  detalle?: string
  pagoDeclarado?: boolean
}

// ── MÉXICO (22-jul, decisión Lalo): sin MercadoPago MX, el pago inicial va por
// transferencia BANORTE. Al recibir el comprobante, Vicky NO solo confirma la
// recepción: entrega DE INMEDIATO el acceso al auto-onboarding y presenta a
// la ejecutiva (Yahel Segura). El pago sigue quedando EN VERIFICACIÓN con
// finanzas — el link no confirma dinero; si el comprobante resultara falso,
// el equipo corta el onboarding a mano.
const COTIZADORA_API_BASE = (process.env.COTIZADORA_API_BASE || "https://cotizacion.geovictoria.com").trim()
const VICKY_COTIZADORA_SECRET = (process.env.VICKY_COTIZADORA_SECRET || "").trim()
const EJECUTIVA_MX = {
  nombre: "Yahel Segura",
  whatsapp: "+52 55 3763 6604",
  email: "ysegura@geovictoria.com",
}

export async function obtenerLinkOnboarding(quoteId: string): Promise<string> {
  try {
    const r = await fetch(`${COTIZADORA_API_BASE}/api/quote-acceptance/onboarding-link`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(VICKY_COTIZADORA_SECRET ? { "x-vicky-secret": VICKY_COTIZADORA_SECRET } : {}),
      },
      body: JSON.stringify({ quoteId }),
      cache: "no-store",
    })
    const data = (await r.json().catch(() => ({}))) as { ok?: boolean; onboardingUrl?: string }
    return r.ok && data.ok && data.onboardingUrl ? data.onboardingUrl : ""
  } catch {
    return ""
  }
}

async function crearNotaEnCotizacion(quoteId: string, contenido: string): Promise<boolean> {
  try {
    const token = await getZohoAccessToken()
    // Endpoint de related records (25-jul): POST /{módulo}/{id}/Notes. El
    // formato anterior (POST /Notes con Parent_Id objeto) fallaba SIEMPRE en
    // silencio con el módulo custom — ninguna cotización tenía la nota del
    // comprobante (verificado en JEANSCO/COT265).
    const res = await fetch(
      `${ZOHO_API_DOMAIN}/crm/v3/${QUOTE_MODULE}/${encodeURIComponent(quoteId)}/Notes`,
      {
        method: "POST",
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          data: [
            {
              Note_Title: "Comprobante de transferencia recibido por WhatsApp",
              Note_Content: contenido,
            },
          ],
        }),
        cache: "no-store",
      },
    )
    if (!res.ok) {
      const detalle = await res.text().catch(() => "")
      console.error(`[comprobante] nota Zoho falló ${res.status}: ${detalle.slice(0, 300)}`)
    }
    return res.ok
  } catch (err) {
    console.error("[comprobante] nota Zoho excepción:", err)
    return false
  }
}

export async function registrarComprobanteTransferencia(
  contact: string,
  input: Input,
  // "mx": monto en MXN y, tras registrar, entrega el link de auto-onboarding y
  // presenta a la ejecutiva (flujo transferencia BANORTE). Default: CL.
  pais: "cl" | "mx" = "cl",
): Promise<{ ok: boolean; mensajeParaProspecto: string; notaCreada?: boolean; avisoInterno?: boolean }> {
  const monto = Math.max(0, Math.round(Number(input.montoDetectado) || 0))
  const montoFmt =
    monto > 0
      ? pais === "mx"
        ? `$${monto.toLocaleString("es-MX")} MXN`
        : `$${monto.toLocaleString("es-CL")}`
      : "monto no legible"

  const pointers = await getQuotePointers(contact).catch(() => [])
  const pointer = pointers[0] || null

  const declarado = input.pagoDeclarado === true

  // ── VALIDACIÓN BLANDA (decisión Lalo 26-jul, MVP/piloto de revenue) ──
  //
  // Antes: el cliente mandaba el comprobante y esperaba hasta 24 horas hábiles a
  // que finanzas verificara el abono en el banco ANTES de poder configurar nada.
  // Ese bloqueo humano contradice el posicionamiento central de Vicky (la
  // inmediatez es su ventaja frente a un vendedor humano) y es justo el punto
  // donde el cliente ya pagó y se queda esperando.
  //
  // Ahora: si Vicky pudo LEER el comprobante, se le entrega el acceso al
  // onboarding de inmediato. La verificación bancaria sigue corriendo en
  // paralelo, pero como AUDITORÍA — no como bloqueo. Si el abono no aparece, el
  // equipo corta el onboarding a mano (mismo patrón que MX desde el 22-jul).
  //
  // El único criterio duro: el comprobante tiene que ser LEGIBLE (monto > 0).
  // Si el monto no se pudo leer — imagen borrosa, PDF que el visor no abrió, o
  // pago solo DECLARADO sin comprobante — NO se habilita: ahí no hay nada que
  // validar, ni siquiera blandamente, y se mantiene el mensaje de verificación.
  //
  // Lo que NO cambia: la cotización nunca se marca como pagada desde acá, y
  // Vicky jamás afirma que el pago quedó confirmado.
  const comprobanteLegible = !declarado && monto > 0
  const habilitaBlanda = comprobanteLegible && !!pointer

  const lineas = [
    declarado
      ? `Cliente DECLARÓ pago por WhatsApp — sin comprobante (${new Date().toISOString()})`
      : `Comprobante de transferencia recibido por WhatsApp (${new Date().toISOString()})`,
    `Contacto: +${contact}`,
    pointer ? `Cotización vigente: quote_id ${pointer.quoteId} · ${pointer.empresa || "-"} · RUT ${pointer.rut || "-"}` : "SIN cotización formal vigente asociada al contacto",
    `Monto según comprobante: ${montoFmt}`,
    pointer?.totalClp ? `Total registrado en la cotización: $${Math.round(pointer.totalClp).toLocaleString("es-CL")} (referencial — verificar pago inicial exacto)` : "",
    input.bancoOrigen ? `Banco origen: ${input.bancoOrigen}` : "",
    input.fechaDetectada ? `Fecha transferencia: ${input.fechaDetectada}` : "",
    input.detalle ? `Detalle: ${input.detalle}` : "",
    habilitaBlanda
      ? "⚠️ VALIDACIÓN BLANDA: el comprobante era legible, así que al cliente YA se le entregó el acceso al onboarding sin esperar la verificación bancaria. Si el abono NO aparece, hay que cortar el onboarding a mano."
      : "",
    "ACCIÓN: verificar el abono en el banco y confirmar el pago (la cotización NO fue marcada como pagada automáticamente).",
  ].filter(Boolean)
  const contenidoNota = lineas.join("\n")

  // 1. Nota en la cotización de Zoho (la traza durable para finanzas).
  const notaCreada = pointer ? await crearNotaEnCotizacion(pointer.quoteId, contenidoNota) : false

  // 2. Aviso interno por WhatsApp (best-effort: puede fallar fuera de ventana).
  const avisoInterno = await sendBotmakerMessage(
    NOTIFY_TO,
    `💰 COMPROBANTE DE TRANSFERENCIA\n${contenidoNota}`,
  ).catch(() => false)

  console.log(
    `[comprobante] contact=${contact} monto=${monto} quote=${pointer?.quoteId || "-"} nota=${notaCreada} aviso=${avisoInterno}`,
  )

  // 3bis. Pago DECLARADO sin comprobante (caso Transportes Viig, 22-jul): el
  // cliente dijo "el pago está listo" y Vicky afirmó una confirmación que no
  // existía. Ahora: se registra el AVISO para que finanzas verifique, se le
  // agradece y se le pide el comprobante para acelerar — sin afirmar nada.
  if (declarado) {
    const mensajeParaProspecto =
      `¡Gracias por avisarme! 🙌 Dejé tu pago en verificación con nuestro equipo de finanzas — apenas confirmen el abono te escribo por aquí y coordinamos los siguientes pasos. ` +
      `Si tienes el comprobante a mano, mándamelo por este mismo chat y aceleramos la confirmación 😊`
    return { ok: true, mensajeParaProspecto, notaCreada, avisoInterno }
  }

  // 3. Confirmación al cliente.
  //
  // VALIDACIÓN BLANDA: con el comprobante legible, el acceso al onboarding sale
  // AHORA. No se le pide al cliente que espere la verificación bancaria — esa
  // corre en paralelo como auditoría. Nunca se afirma que el pago está
  // confirmado: se confirma la RECEPCIÓN y se le habilita la configuración.
  if (habilitaBlanda && pointer) {
    const linkOnboarding = await obtenerLinkOnboarding(pointer.quoteId)
    if (!linkOnboarding) {
      // Sin link no hay habilitación posible: el equipo debe mandarlo a mano.
      sendBotmakerMessage(
        NOTIFY_TO,
        `⚠️ Comprobante ${pais.toUpperCase()} de +${contact}: no se pudo generar el link de auto-onboarding (quote ${pointer.quoteId}). Enviarlo a mano.`,
      ).catch(() => {})
    }

    if (pais === "mx") {
      // MX suma la presentación de la ejecutiva (única excepción a "sin
      // ejecutivo antes del pago": acá el cliente ya pagó).
      const mensajeParaProspecto = linkOnboarding
        ? `¡Recibí tu comprobante por ${montoFmt}! 🙌 Quedó asociado a tu cotización y ya te dejo habilitada la configuración de tu cuenta — no tienes que esperar nada.\n\n` +
          `Aquí tienes tu acceso al auto-onboarding: ahí configuras tu empresa y cargas a tus colaboradores en unos 15 minutos.\n${linkOnboarding}\n\n` +
          `Y te presento a ${EJECUTIVA_MX.nombre}, tu ejecutiva comercial: ella te acompaña de aquí en adelante.\n📱 WhatsApp: ${EJECUTIVA_MX.whatsapp}\n✉️ ${EJECUTIVA_MX.email}\n\nCualquier duda del proceso, me escribes por aquí 😊`
        : `¡Recibí tu comprobante por ${montoFmt}! 🙌 Quedó asociado a tu cotización y ya te estoy habilitando la configuración de tu cuenta — te paso el acceso por aquí en unos minutos.\n\n` +
          `Te presento a ${EJECUTIVA_MX.nombre}, tu ejecutiva comercial: ella te acompaña de aquí en adelante.\n📱 WhatsApp: ${EJECUTIVA_MX.whatsapp}\n✉️ ${EJECUTIVA_MX.email}\n\nCualquier duda, me escribes por aquí 😊`
      return { ok: true, mensajeParaProspecto, notaCreada, avisoInterno }
    }

    // CL: recepción + habilitación inmediata, acompañada por Vicky.
    const mensajeParaProspecto = linkOnboarding
      ? `Recibí tu comprobante por ${montoFmt} 🙌 Quedó asociado a tu cotización y ya te dejo habilitada la configuración de tu cuenta — no tienes que esperar nada.\n\n` +
        `Aquí tienes tu acceso: en unos 15 minutos dejas configurada tu empresa y cargados a tus trabajadores.\n${linkOnboarding}\n\n` +
        `Cualquier duda mientras lo llenas, me escribes por acá y lo vemos juntos 😊`
      : `Recibí tu comprobante por ${montoFmt} 🙌 Quedó asociado a tu cotización y ya te estoy habilitando la configuración de tu cuenta — te paso el acceso por acá en unos minutos. Cualquier duda, me escribes 😊`
    return { ok: true, mensajeParaProspecto, notaCreada, avisoInterno }
  }

  // Sin habilitación blanda: comprobante ilegible, o sin cotización formal
  // asociada al contacto. Acá NO hay nada que validar, así que se mantiene el
  // mensaje de verificación con el plazo transparente (decisión Lalo 25-jul).
  const mensajeParaProspecto = pointer
    ? `Recibí tu comprobante 🙌 Ya quedó asociado a tu cotización — no alcancé a leer el monto, así que lo está revisando nuestro equipo (toma máximo 24 horas hábiles). Apenas quede confirmado te escribo por aquí para partir con la configuración de tu cuenta. Si quieres acelerarlo, mándame el comprobante de nuevo con la imagen más nítida 😊`
    : `Recibí tu comprobante${monto > 0 ? ` por ${montoFmt}` : ""} 🙌 Lo dejé en manos del equipo para asociarlo a tu cotización — la verificación toma máximo 24 horas hábiles. Apenas se confirme te escribo por aquí para partir con la configuración de tu cuenta. ¡Gracias!`

  return { ok: true, mensajeParaProspecto, notaCreada, avisoInterno }
}
