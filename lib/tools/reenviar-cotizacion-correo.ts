/**
 * Tool: reenviar_cotizacion_correo
 *
 * El cliente pide compartir su cotización formal con OTRA persona (su jefe,
 * socio, encargado de RRHH…). Vicky la reenvía por CORREO al tercero, con el
 * cliente en copia. Pedido Lalo 20-jul (caso Hernán / Ingredientes
 * Alimenticios: "te doy el número de mi jefa de RRHH para hacer este tema más
 * expedito").
 *
 * REGLA DE DISEÑO — solo correo: al tercero JAMÁS se le escribe por WhatsApp.
 * No pidió ser contactado por ese canal y no vamos a invadirlo; el correo es
 * el canal no intrusivo. Si el cliente insiste en WhatsApp para el tercero,
 * Vicky le explica eso y le ofrece que el propio cliente reenvíe el PDF.
 */

const COTIZADORA_API_BASE = (
  process.env.COTIZADORA_API_BASE || "https://cotizacion.geovictoria.com"
).trim()
const VICKY_COTIZADORA_SECRET = (process.env.VICKY_COTIZADORA_SECRET || "").trim()

export const reenviarCotizacionCorreoSchema = {
  name: "reenviar_cotizacion_correo",
  description:
    "Reenvía la cotización formal por CORREO. Dos usos: (a) a otra persona que el cliente designe (su jefe, socio, RRHH, finanzas) — cuando pida compartirla con alguien más; (b) al PROPIO cliente, con esCorreoDelCliente=true, cuando entrega SU correo DESPUÉS de emitida la formal o pide recibirla por correo — esta tool es la ÚNICA forma real de que la cotización llegue a un correo: sin llamarla, ningún correo sale. SOLO correo: al tercero NUNCA se le escribe por WhatsApp (no pidió ser contactado por ese canal); si el cliente pide WhatsApp para el tercero, explícale que por respeto solo usamos correo con personas que no han hablado con nosotros, y que él mismo puede reenviar el PDF si prefiere. ANTES de llamarla confirma con el cliente el correo del destinatario (pídelo si no lo ha dado). El cliente queda en copia del correo. Copia el campo mensajeParaProspecto TAL CUAL.",
  input_schema: {
    type: "object" as const,
    properties: {
      quote_id: {
        type: "string" as const,
        description:
          "ID de la cotización formal vigente (el quoteId del contexto/puntero de esta conversación).",
        minLength: 1,
        maxLength: 80,
      },
      destinatarioEmail: {
        type: "string" as const,
        description: "Correo del destinatario, tal como lo dio el cliente.",
        minLength: 5,
        maxLength: 120,
      },
      destinatarioNombre: {
        type: "string" as const,
        description: "Nombre del destinatario (para el saludo del correo), si el cliente lo dio.",
        maxLength: 80,
      },
      solicitanteNombre: {
        type: "string" as const,
        description: "Nombre del cliente que pide compartirla (aparece en el correo: 'X me pidió compartirte…').",
        maxLength: 80,
      },
      solicitanteEmail: {
        type: "string" as const,
        description: "Correo del cliente solicitante, para dejarlo en copia.",
        maxLength: 120,
      },
      esCorreoDelCliente: {
        type: "boolean" as const,
        description:
          "true cuando el destinatario es el PROPIO cliente de la conversación (entregó su correo después de emitida la formal, o pide que se la mandes a su correo). El correo sale como continuación del chat, no como 'alguien me pidió compartirte'.",
      },
    },
    required: ["quote_id", "destinatarioEmail"],
  },
}

export type ReenviarCotizacionCorreoInput = {
  quote_id: string
  destinatarioEmail: string
  destinatarioNombre?: string
  solicitanteNombre?: string
  solicitanteEmail?: string
  esCorreoDelCliente?: boolean
}

export type ReenviarCotizacionCorreoResultado =
  | { ok: true; numero: string; destinatario: string; mensajeParaProspecto: string }
  | { ok: false; error: string }

export async function reenviarCotizacionCorreo(
  args: ReenviarCotizacionCorreoInput,
): Promise<ReenviarCotizacionCorreoResultado> {
  const quoteId = String(args.quote_id || "").trim()
  const email = String(args.destinatarioEmail || "").trim()
  if (!quoteId) return { ok: false, error: "Falta quote_id (puntero de la cotización formal)." }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return {
      ok: false,
      error: `El correo '${email}' no parece válido. Pídele al cliente que lo confirme letra por letra y vuelve a intentar.`,
    }
  }
  if (!VICKY_COTIZADORA_SECRET) {
    return { ok: false, error: "Reenvío no configurado (falta VICKY_COTIZADORA_SECRET)." }
  }
  try {
    const res = await fetch(`${COTIZADORA_API_BASE}/api/quote-acceptance/reenviar-cotizacion`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vicky-secret": VICKY_COTIZADORA_SECRET,
      },
      body: JSON.stringify({
        quoteId,
        destinatarioEmail: email,
        destinatarioNombre: args.destinatarioNombre || "",
        solicitanteNombre: args.solicitanteNombre || "",
        ccSolicitante: args.esCorreoDelCliente ? "" : (args.solicitanteEmail || ""),
        correoPropio: args.esCorreoDelCliente === true,
      }),
      cache: "no-store",
    })
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      numero?: string
      destinatario?: string
      error?: string
    }
    if (!res.ok || !data.ok) {
      return {
        ok: false,
        error: `No se pudo reenviar (${data.error || res.status}). No inventes que se envió: dile al cliente que lo revisas y avisas.`,
      }
    }
    const nombre = args.destinatarioNombre || data.destinatario || email
    if (args.esCorreoDelCliente) {
      return {
        ok: true,
        numero: data.numero || quoteId,
        destinatario: email,
        mensajeParaProspecto:
          `Listo! 📧 Te envié la cotización ${data.numero || ""} a ${email}. ` +
          `Si no la ves en unos minutos, revisa la carpeta de promociones o spam. Igual la tienes en este chat con el link para aceptar y pagar en línea.`,
      }
    }
    return {
      ok: true,
      numero: data.numero || quoteId,
      destinatario: email,
      mensajeParaProspecto:
        `Listo! 📧 Le envié la cotización ${data.numero || ""} a ${nombre} a su correo (${email}), contigo en copia. ` +
        `Desde el PDF puede revisarla y aceptarla en línea cuando lo decidan. Cualquier duda que tenga ella, también la puedo ayudar por correo.`,
    }
  } catch (err) {
    return {
      ok: false,
      error: `Error de red reenviando la cotización: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
