/**
 * Plantilla HSM para abrir el onboarding FUERA de la ventana de 24 h.
 *
 * EL HUECO QUE TAPA (26-jul): el pago no ocurre necesariamente mientras el
 * cliente está conversando. Puede recibir la cotización un viernes, pensarlo,
 * y pagar el domingo por la noche — con 48 h de silencio. Ahí la ventana de
 * WhatsApp está cerrada, el push de texto libre MUERE EN SILENCIO, y el
 * cliente que acaba de pagar no recibe nada. Justo el peor momento posible.
 *
 * Cómo funciona: la plantilla NO lleva el alta. Solo reabre la ventana. Cuando
 * el cliente responde, el webhook lo encuentra ya en fase onboarding y el
 * agente toma la conversación con el borrador sembrado — o sea, el mismo
 * camino que si nunca se hubiera cerrado.
 *
 * POR QUÉ NO MENCIONA EL PAGO: sirve para las DOS vías (tarjeta y comprobante)
 * y con comprobante está prohibido afirmar que el pago quedó confirmado — solo
 * se confirma la recepción. Una plantilla neutra evita tener que aprobar dos y
 * evita la afirmación que no podemos sostener. El detalle de cada vía lo da
 * Vicky en texto libre apenas el cliente responde.
 *
 * La variable es la EMPRESA y no el nombre de la persona: la empresa siempre
 * está en el puntero de la cotización; el nombre del contacto no.
 */

export const PLANTILLA_ONBOARDING_CL = {
  /** ruleNameOrId que espera la API de notificaciones de Botmaker. */
  name: "vicky_onboarding_inicio_cl",
  /**
   * UTILITY: es un mensaje post-transacción sobre una cuenta que el cliente
   * acaba de contratar, no promoción. MARKETING tendría peor tasa de
   * aprobación y quedaría sujeto a los límites de mensajes promocionales.
   */
  category: "UTILITY" as const,
  locale: "es",
  /** {{1}} = razón social. Un solo parámetro: menos fricción de aprobación. */
  body:
    "Hola! Soy Vicky de GeoVictoria 🎉\n\n" +
    "Ya podemos crear la cuenta de {{1}} y dejarte entrando a la plataforma en minutos. Solo necesito un par de datos.\n\n" +
    "Respóndeme por aquí y partimos.",
} as const

/** Parámetros de la plantilla. Sin empresa, un genérico que no queda raro. */
export function paramsPlantillaOnboarding(empresa?: string): Record<string, string> {
  return { "1": (empresa || "").trim() || "tu empresa" }
}
