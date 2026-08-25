/**
 * Fase del contacto: qué agente atiende su conversación.
 *
 * DECISIÓN DE ARQUITECTURA (26-jul-2026, debate monolito vs microservicios):
 * Vicky onboarding es un SEGUNDO AGENTE — prompt, tools y estado propios — en
 * el MISMO repo y deploy. Los dos ejes son independientes: agente es unidad de
 * diseño (objetivo, tools, guardrails); repo/deploy es unidad de operación
 * (equipo dueño, runtime, cadencia de release). El cerebro vive en
 * lib/onboarding/ y es PURO: la frontera de imports la vigila
 * tests/onboarding-frontera.test.ts, para que el día que haga falta extraerlo
 * a servicio propio (segundo consumidor real — chat in-app con fecha — o
 * cambio de equipo dueño) la mudanza sea mecánica. Hasta entonces, in-process
 * detrás de VICKY_ONBOARDING_ENABLED.
 */

export type FaseVicky = "venta" | "onboarding" | "completado"

export function onboardingEnabled(): boolean {
  return (process.env.VICKY_ONBOARDING_ENABLED || "").trim().toLowerCase() === "on"
}

/**
 * Llaves vic_kv. La persistencia es responsabilidad del CANAL (el cerebro
 * recibe y devuelve el borrador, nunca lo guarda); acá solo se definen los
 * nombres para que todos los canales apunten al mismo estado — eso es lo que
 * permitiría "seguir el alta en el chat de la plataforma" el día de mañana.
 */
export const claveFase = (contact: string) => `fase_vicky_${contact}`
export const claveBorrador = (contact: string) => `onboarding_borrador_${contact}`
/** Timestamp ISO de cuándo se solicitó el alta (candado anti doble-solicitud). */
export const claveAltaSolicitada = (contact: string) => `onboarding_alta_solicitada_${contact}`

/**
 * Transiciones permitidas. Deliberadamente pocas:
 *  - venta → onboarding: SOLO el pago abre la fase (misma puerta que cierra el
 *    Loop v2 y presenta al ejecutivo — cerrarYTraspasarPostPago).
 *  - onboarding → completado: SOLO la empresa creada la cierra.
 *  - completado no vuelve atrás: un problema post-alta es soporte, no un
 *    segundo onboarding.
 */
const TRANSICIONES: Record<FaseVicky, readonly FaseVicky[]> = {
  venta: ["onboarding"],
  onboarding: ["completado"],
  completado: [],
}

export function transicionValida(desde: FaseVicky, hacia: FaseVicky): boolean {
  return TRANSICIONES[desde]?.includes(hacia) ?? false
}

/** Type guard para lo que venga de vic_kv: cualquier otra cosa es "venta". */
export function esFase(v: unknown): v is FaseVicky {
  return v === "venta" || v === "onboarding" || v === "completado"
}

/**
 * Fase efectiva desde el valor crudo del kv. null / basura / flag apagado →
 * "venta": el camino de venta es el default seguro y el que existía antes de
 * esta fase, así que un kv corrupto degrada al comportamiento de siempre.
 */
export function faseEfectiva(kvCrudo: string | null | undefined): FaseVicky {
  if (!onboardingEnabled()) return "venta"
  return esFase(kvCrudo) ? kvCrudo : "venta"
}

/** Configuración F2 (nómina/turnos/planificaciones) conversada por chat. */
export const claveConfiguracion = (contact: string) => `onboarding_config_${contact}`
