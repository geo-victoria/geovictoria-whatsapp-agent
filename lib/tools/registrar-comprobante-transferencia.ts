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
 * Qué hace:
 *   1. Asocia el comprobante a la cotización formal VIGENTE del contacto
 *      (puntero multi-RUT más reciente).
 *   2. Deja una NOTA en la cotización de Zoho con el detalle detectado.
 *   3. Avisa al equipo por WhatsApp (best-effort, ventana de 24h mediante).
 *   4. Devuelve mensajeParaProspecto: recepción confirmada, pago EN
 *      VERIFICACIÓN — sin afirmar jamás que el pago quedó confirmado.
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
    "Registra un comprobante de transferencia bancaria que el cliente envió por el chat (imagen o PDF descrito en el historial). Úsala SIEMPRE que el cliente mande un comprobante de pago de su cotización. Extrae del comprobante lo que se vea: monto transferido, banco y fecha. La tool asocia el comprobante a la cotización vigente, avisa al equipo de finanzas y devuelve mensajeParaProspecto para confirmar la RECEPCIÓN (el pago queda EN VERIFICACIÓN — nunca afirmes tú que el pago ya está confirmado). Copia el mensajeParaProspecto TAL CUAL.",
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
    const res = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/Notes`, {
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
            Parent_Id: { module: { api_name: QUOTE_MODULE }, id: quoteId },
          },
        ],
      }),
      cache: "no-store",
    })
    return res.ok
  } catch {
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
  // MX: recepción + acceso INMEDIATO al auto-onboarding + presentación de la
  // ejecutiva (decisión Lalo 22-jul: cero fricción tras el comprobante; la
  // verificación del abono sigue corriendo por finanzas en paralelo).
  if (pais === "mx" && pointer) {
    const linkOnboarding = await obtenerLinkOnboarding(pointer.quoteId)
    const mensajeParaProspecto = linkOnboarding
      ? `¡Recibí tu comprobante${monto > 0 ? ` por ${montoFmt}` : ""}! 🙌 Quedó asociado a tu cotización y en verificación con nuestro equipo.\n\n` +
        `Para que no pierdas ni un día, aquí tienes tu acceso al auto-onboarding — ahí configuras tu empresa y cargas a tus colaboradores en unos 15 minutos:\n${linkOnboarding}\n\n` +
        `Y te presento a ${EJECUTIVA_MX.nombre}, tu ejecutiva comercial: ella te acompaña de aquí en adelante.\n📱 WhatsApp: ${EJECUTIVA_MX.whatsapp}\n✉️ ${EJECUTIVA_MX.email}\n\nCualquier duda del proceso, me escribes por aquí 😊`
      : `¡Recibí tu comprobante${monto > 0 ? ` por ${montoFmt}` : ""}! 🙌 Quedó asociado a tu cotización y en verificación con nuestro equipo.\n\n` +
        `Te presento a ${EJECUTIVA_MX.nombre}, tu ejecutiva comercial: ella te acompaña de aquí en adelante y te enviará el acceso a la configuración inicial.\n📱 WhatsApp: ${EJECUTIVA_MX.whatsapp}\n✉️ ${EJECUTIVA_MX.email}\n\nCualquier duda, me escribes por aquí 😊`
    if (!linkOnboarding) {
      // El equipo debe saber que el link no salió (para mandarlo a mano).
      sendBotmakerMessage(
        NOTIFY_TO,
        `⚠️ Comprobante MX de +${contact}: no se pudo generar el link de auto-onboarding (quote ${pointer.quoteId}). Enviarlo a mano.`,
      ).catch(() => {})
    }
    return { ok: true, mensajeParaProspecto, notaCreada, avisoInterno }
  }

  // CL (v1): recepción confirmada, pago EN VERIFICACIÓN — nunca afirmar pago.
  const mensajeParaProspecto = pointer
    ? `Recibí tu comprobante${monto > 0 ? ` por ${montoFmt}` : ""} 🙌 Ya quedó asociado a tu cotización y en verificación con nuestro equipo de finanzas. Te confirmo por aquí apenas el pago esté procesado — normalmente dentro del mismo día hábil. ¡Gracias!`
    : `Recibí tu comprobante${monto > 0 ? ` por ${montoFmt}` : ""} 🙌 Lo dejé en manos del equipo para asociarlo a tu cotización y confirmarte. Te aviso por aquí apenas esté procesado. ¡Gracias!`

  return { ok: true, mensajeParaProspecto, notaCreada, avisoInterno }
}
