/**
 * System prompt V3 para Vicky.
 *
 * El catálogo de productos disponibles se inyecta dinámicamente desde
 * `/lib/catalogo`. Cuando se habilita o deshabilita un producto cambiando
 * el flag `disponibleParaVicky`, el prompt se actualiza automáticamente
 * sin tocar este archivo.
 *
 * La fecha actual se inyecta vía getSystemPromptV3() en cada request, para
 * que Vicky no aluciné años antiguos al interpretar fechas relativas.
 */

import {
  getModulosDisponiblesParaVicky,
  getHardwareDisponiblesParaVicky,
} from "@/lib/catalogo"
import type { TierPrecio } from "@/lib/catalogo"
import { calendarioProximosDias } from "@/lib/calendar"
import { textoNucleo } from "@/lib/prompt-nucleo/texto"
import { aplicarUmbral } from "@/lib/prompt-nucleo/armar"
import { FICHA_CL } from "@/lib/prompt-nucleo/ficha"

function formatTiersForPrompt(tiers: TierPrecio[]): string {
  return tiers
    .map((t) => {
      const modalidadStr =
        t.modalidad === "fijo" ? `${t.precioUF} UF fijo` : `${t.precioUF} UF por usuario`
      return `${t.minUsuarios}-${t.maxUsuarios}: ${modalidadStr}`
    })
    .join(" · ")
}

export function formatCatalogoParaPrompt(): string {
  const modulos = getModulosDisponiblesParaVicky()
  const hardware = getHardwareDisponiblesParaVicky()

  const lineasModulos = modulos
    .map((m) => {
      const tiersStr = formatTiersForPrompt(m.tiers)
      const minimo = m.minUsuariosTotal ? ` (requiere mín ${m.minUsuariosTotal} trabajadores)` : ""
      return `  - ${m.id}: ${m.nombre}${minimo} — Tiers: ${tiersStr}. ${m.descripcion}`
    })
    .join("\n")

  const lineasHardware =
    hardware.length === 0
      ? "  (ningún dispositivo de marcaje habilitado actualmente)"
      : hardware
          .map((h) => {
            const modalidades = h.modalidadesDisponibles
              .map((m) => {
                if (m === "arriendo") return `arriendo ${h.arriendoUF} UF/mes`
                return `venta ${h.ventaUF} UF`
              })
              .join(" o ")
            return `  - ${h.id}: ${h.displayName} — ${modalidades}. Cantidad sugerida: ${h.cantidadSugerida}. ${h.descripcion}`
          })
          .join("\n")

  return `# Catálogo disponible

## Módulos de software (todos calculan mensual en UF, IVA aparte)

${lineasModulos}

## Hardware de marcaje (opcional, costo adicional)

${lineasHardware}

⚠️ IMPORTANTE: Solo puedes ofrecer productos que aparezcan en estas dos listas. Si un prospecto te pregunta por un módulo o dispositivo que no está aquí, deriva con un ejecutivo (usa derivar_a_soporte motivo "fuera_de_scope"). Los tiers de precio son información interna para tu razonamiento — NO los menciones al prospecto. Tampoco menciones rangos de usuarios ni "brackets".`
}

function formatFechaActualParaPrompt(): string {
  const now = new Date()
  const tz = "America/Santiago"
  const isoUTC = now.toISOString()
  const fechaLegible = now.toLocaleString("es-CL", {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
  return `# Anclaje temporal (CRÍTICO para agendar reuniones)

HOY ES: ${fechaLegible} (Chile)
FECHA ISO UTC ACTUAL: ${isoUTC}
CALENDARIO PRÓXIMOS DÍAS (día de la semana REAL de cada fecha — úsalo TAL CUAL, nunca calcules el día tú): ${calendarioProximosDias("America/Santiago")}

Cuando el cliente proponga un día relativo ("mañana", "el jueves", "la próxima semana"), interprétalo en base a la fecha indicada arriba — NO en base a tu conocimiento de entrenamiento, que puede estar desactualizado. Al mencionar una fecha al cliente (ofrecer horarios, confirmar reuniones o seguimientos), el día de la semana SIEMPRE sale del CALENDARIO de arriba o de la etiqueta que devuelva la tool — si dices "lunes" y era martes, el cliente llega el día equivocado. Antes de invocar consultar_disponibilidad_horario, calcula la fecha ISO 8601 correcta tomando como base el HOY indicado arriba y devuelve un ISO con el AÑO ACTUAL real (${now.getFullYear()}), no un año anterior.

Cal.com tiene configurado su propio "minimum booking notice" (mínima anticipación) en el Event Type — si el cliente propone algo muy próximo en el tiempo, la tool devolverá alternativas o "sin disponibilidad" según lo que Cal.com permita. No filtres por tu cuenta — pasa la fecha tal cual el cliente la propuso (ajustada al año actual) y deja que la tool decida.

---

`
}

/**
 * Devuelve el system prompt con la fecha actual y el teléfono del canal
 * inyectados. Usar en route.ts en cada request para que Vicky tenga
 * anclaje temporal preciso y conozca el teléfono del cliente sin
 * preguntárselo.
 *
 * @param contact - Número del cliente normalizado a dígitos (ej. "56944668823").
 *                  Vendrá del campo `contact` del webhook de Botmaker.
 */
export function getSystemPromptV3(contact?: string, umbralPreciosCL?: number): string {
  // El ajuste de umbral (Lalo 08-ago) vive en lib/prompt-nucleo/armar para
  // que los cuatro países usen el MISMO; acá solo se delega.
  const base = aplicarUmbral(SYSTEM_PROMPT_V3, umbralPreciosCL)
  return (
    formatFechaActualParaPrompt() +
    formatTelefonoCanalParaPrompt(contact) +
    base
  )
}

/**
 * Item B (retomar cotización existente / anti-amnesia). Bloque inyectable al
 * inicio del prompt cuando el contacto YA tiene una cotización formal generada
 * antes (puntero durable en vic_v3_quote_pointers). Sin este contexto, tras
 * perder el historial (borrado o ventana de 40 msjs) Vicky "olvida" la
 * cotización y vuelve a pedir datos para cotizar de cero (bug de Rodrigo).
 */
export function formatCotizacionExistenteParaPrompt(p?: {
  quoteId?: string
  acceptanceUrl?: string
  totalUf?: number | null
  totalClp?: number | null
}): string {
  if (!p || !p.quoteId) return ""
  const montos: string[] = []
  if (typeof p.totalUf === "number" && p.totalUf > 0) {
    montos.push(`${p.totalUf} UF`)
  }
  if (typeof p.totalClp === "number" && p.totalClp > 0) {
    montos.push(`aprox. $${Math.round(p.totalClp).toLocaleString("es-CL")} CLP`)
  }
  const montoLinea = montos.length ? ` (total ${montos.join(" / ")})` : ""
  const linkLinea = p.acceptanceUrl
    ? `\nLink de aceptación de esa cotización (úsalo si te lo piden o para retomar): ${p.acceptanceUrl}`
    : ""
  return (
    `ESTADO DE ESTE CONTACTO — LÉELO ANTES DE ACTUAR:\n` +
    `Este contacto YA tiene una cotización formal generada anteriormente${montoLinea}.${linkLinea}\n` +
    `Por lo tanto NO partes de cero con este cliente:\n` +
    `- NO le vuelvas a pedir datos que ya entregó (empresa, RUT, cantidad de trabajadores, módulos) ni rehagas el preform desde el principio.\n` +
    `- NO generes otra cotización nueva. Si quiere ajustes o más descuento, trabaja SOBRE esa cotización (consultar_siguiente_descuento / aplicar_siguiente_descuento).\n` +
    `- El link de arriba NO se ofrece por iniciativa propia: la entrega ya salió con su link corto en el molde, y pegarlo de nuevo lo manda DOS VECES (Eduardo 17-ago, caso Rodrigo: recibió la plantilla y acto seguido el link acortado). Reenvíaselo como texto SOLO si el cliente lo pide explícitamente ("mándame el link de nuevo", "no me llega"), nunca como parte de una entrega ni de un saludo.\n` +
    `- Solo si pide explícitamente algo DISTINTO (otra cantidad de usuarios, otros módulos, otra empresa) puedes cotizar de nuevo, y confírmalo con él antes.\n` +
    `Si retoma sin contexto (ej. "hola", "sigo interesado"), salúdalo reconociendo que ya tiene su cotización y ofrécele retomarla, no arranques una venta desde cero.\n\n`
  )
}

/**
 * Versión MULTI del bloque anterior (caso Génesis): el contacto tiene varias
 * cotizaciones formales vivas, una por razón social. Se listan TODAS para que
 * Vicky no las mezcle, no pierda ninguna y pueda reenviar el link correcto.
 */
export function formatCotizacionesMultiplesParaPrompt(
  pointers: Array<{
    quoteId: string
    acceptanceUrl?: string
    totalUf?: number | null
    totalClp?: number | null
    rut?: string
    empresa?: string
  }>,
): string {
  if (!pointers || pointers.length === 0) return ""
  const lineas = pointers
    .map((p, i) => {
      const partes = [`${i + 1}. ${p.empresa || "Empresa " + (i + 1)}${p.rut ? ` (RUT ${p.rut})` : ""} — quote_id ${p.quoteId}`]
      if (typeof p.totalClp === "number" && p.totalClp > 0) {
        partes.push(`total aprox. $${Math.round(p.totalClp).toLocaleString("es-CL")} CLP`)
      }
      if (p.acceptanceUrl) partes.push(`link: ${p.acceptanceUrl}`)
      return partes.join(" · ")
    })
    .join("\n")
  return (
    `ESTADO DE ESTE CONTACTO — LÉELO ANTES DE ACTUAR:\n` +
    `Este contacto tiene VARIAS cotizaciones formales vivas (una por razón social). NO las mezcles:\n${lineas}\n` +
    `Reglas con varias cotizaciones:\n` +
    `- Cada empresa/RUT tiene SU cotización y SU link: al reenviar o negociar, identifica primero de CUÁL empresa habla el cliente y usa el quote_id/link correcto.\n` +
    `- Cambios de configuración → actualizar_cotizacion con el quote_id de ESA empresa. Descuentos → consultar/aplicar_siguiente_descuento con el quote_id de ESA empresa.\n` +
    `- Si el cliente quiere cotizar una razón social ADICIONAL (RUT nuevo), puedes generarla con generar_link_cotizadora (una por mensaje).\n` +
    `- Si pide "todas las cotizaciones", entrégale un resumen ordenado con cada empresa y su link.\n\n`
  )
}

/**
 * Formatea el número del canal como bloque inyectable al inicio del prompt.
 * El número viene como dígitos puros del webhook (ej. "56944668823") y se
 * presenta a Vicky en formato E.164 con + delante.
 */
function formatTelefonoCanalParaPrompt(contact?: string): string {
  const digits = (contact || "").replace(/\D/g, "")
  if (!digits) return ""
  return `Teléfono del cliente (este es el número desde el que te está escribiendo por WhatsApp): +${digits}\n\n`
}

// EL TEXTO VIVE EN EL NÚCLEO (21-sep, "un solo prompt con variables por país"):
// lib/prompt-nucleo/texto.ts es el prompt de Chile extraído tal cual, y
// tests/prompt-nucleo-identidad prueba que armado con FICHA_CL es IDÉNTICO,
// carácter por carácter, al prompt que producción servía antes del cambio.
// Chile consume el núcleo para que el núcleo no envejezca: una regla nueva se
// escribe UNA vez ahí y los cuatro países la heredan en el mismo deploy.
export const SYSTEM_PROMPT_V3 = textoNucleo(FICHA_CL, formatCatalogoParaPrompt())
