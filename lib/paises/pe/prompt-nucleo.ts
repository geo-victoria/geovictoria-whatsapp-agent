/**
 * PROMPT DE PERÚ DESDE EL NÚCLEO (21-sep): el mismo texto que Chile
 * (lib/prompt-nucleo/texto.ts) con la ficha peruana como parámetros. Se
 * enciende por vic_kv `prompt_nucleo_pe`="on" en el webhook PE; apagado, PE
 * sigue con su prompt propio (lib/paises/pe/prompt.ts).
 *
 * PURO (imports relativos .ts, sin red): tests/ficha-pe.test.ts lo carga con
 * node --test para verificar que el render peruano no arrastre chilenismos.
 */
import { armarPromptBase } from "../../prompt-nucleo/armar.ts"
import { FICHA_PE } from "./ficha.ts"
import { CATALOGO_MODULOS_PE, CATALOGO_HARDWARE_PE } from "./catalogo.ts"
import { anclajeTemporalPE, bloqueTelefonoPE } from "./prompt.ts"

/**
 * Catálogo PE para el prompt. A diferencia del chileno, NO lleva los
 * montos: en Perú la única fuente de precio es la tool (soles netos "+ IGV", reloj
 * al dólar SUNAT del día) y el núcleo ya prohíbe enunciar precios de memoria.
 */
export function formatCatalogoParaPromptPE(): string {
  const modulos = CATALOGO_MODULOS_PE.filter((m) => (m as { disponibleVicky?: boolean }).disponibleVicky !== false)
  const hardware = CATALOGO_HARDWARE_PE.filter((h) => (h as { disponibleVicky?: boolean }).disponibleVicky !== false)
  const lineasModulos = modulos
    .map((m) => `  - ${m.id}: ${m.nombre} — tarifa fija mensual hasta 10 personas, por persona desde 11 (el monto exacto lo entrega cotizar_referencial). ${m.descripcion || ""}`.trimEnd())
    .join("\n")
  const lineasHardware =
    hardware.length === 0
      ? "  (ningún dispositivo de marcaje habilitado actualmente)"
      : hardware
          .map((h) => {
            const mods = (h.modalidadesDisponibles || []).map((m) => (m === "arriendo" ? "arriendo mensual" : "venta (pago único)")).join(" o ")
            return `  - ${h.id}: ${h.displayName} — ${mods}; el monto en soles lo entrega cotizar_referencial. Cantidad sugerida: ${h.cantidadSugerida}. ${h.descripcion || ""}`.trimEnd()
          })
          .join("\n")
  return `# Catálogo disponible (Perú)

## Módulos de software (mensual en soles, netos "+ IGV" como los muestra la tool)

${lineasModulos}

## Hardware de marcaje (opcional, costo adicional)

${lineasHardware}

⚠️ IMPORTANTE: Solo puedes ofrecer productos que aparezcan en estas dos listas. Si un prospecto te pregunta por un módulo o dispositivo que no está aquí, deriva con la ejecutiva (usa derivar_a_soporte motivo "fuera_de_scope"). Los precios SIEMPRE salen de la tool — jamás los enuncies de memoria.`
}

/** El prompt de Perú armado desde el núcleo + FICHA_PE (sin anclaje ni teléfono). */
export function promptBasePENucleo(umbralPrecios?: number): string {
  return armarPromptBase(FICHA_PE, formatCatalogoParaPromptPE(), umbralPrecios)
}

/** Reemplazo 1:1 de getSystemPromptPE cuando el núcleo está encendido. */
export function getSystemPromptPENucleo(contact?: string, umbralPrecios?: number): string {
  return anclajeTemporalPE() + bloqueTelefonoPE(contact) + promptBasePENucleo(umbralPrecios)
}
