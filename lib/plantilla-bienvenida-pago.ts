/**
 * Plantilla HSM de RESPALDO para la bienvenida post-pago estándar (CL).
 *
 * CASO CAFETERÍA ARAGÓN (27-ago): el cliente pagó por el canal del EJECUTIVO
 * (nunca conversó con Vicky), la ventana de 24 h no existía y el texto libre
 * de `cerrarYTraspasarPostPago` murió en silencio — el cliente quedó sin
 * bienvenida y sin link de onboarding. El kickoff del agente de onboarding ya
 * tenía este respaldo (lib/onboarding-envio.ts); la rama estándar no.
 *
 * El cuerpo dice lo MISMO que el texto libre de la rama estándar, en versión
 * corta: bienvenida + link del auto-onboarding + quién acompaña. Variables de
 * UNA línea (Meta rechaza saltos de línea dentro de parámetros).
 *
 * Creada vía vic-admin-wa-template (27-ago): UTILITY, locale es, bot
 * "Vicky Chile". OJO: nombre de plantilla borrada queda bloqueado 4 semanas —
 * si hay que cambiar el cuerpo, nombre NUEVO y actualizar esta constante.
 */

export const PLANTILLA_BIENVENIDA_PAGO_CL = {
  /** ruleNameOrId que espera la API de notificaciones de Botmaker. */
  name: "vicky_bienvenida_pago_cl",
  category: "UTILITY" as const,
  locale: "es",
  botName: "Vicky Chile",
  body:
    "¡Felicitaciones y bienvenido a GeoVictoria! 🎉 Tu pago quedó registrado.\n\n" +
    "Para dejar tu empresa configurada y lista para operar, completa tu auto-onboarding (toma ~10 minutos) en este link:\n" +
    "👉 ${link_onboarding}\n\n" +
    "De aquí en adelante te acompaña ${acompanamiento} para coordinar la puesta en marcha. " +
    "Cualquier duda me escribes por aquí 🙌",
} as const

export type ParamsBienvenidaPago = { link_onboarding: string; acompanamiento: string }

/** Params de la plantilla. Sin dato, textos que no dejan huecos raros. */
export function paramsBienvenidaPago(
  linkOnboarding?: string,
  ejecutivo?: { nombre?: string; email?: string } | null,
): ParamsBienvenidaPago {
  const nombre = (ejecutivo?.nombre || "").trim()
  const email = (ejecutivo?.email || "").trim()
  return {
    link_onboarding: (linkOnboarding || "").trim() || "te lo comparto enseguida por este chat",
    acompanamiento: nombre ? (email ? `${nombre} (${email})` : nombre) : "nuestro equipo comercial",
  }
}
