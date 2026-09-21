/**
 * PROMPT DE COLOMBIA DESDE EL NÚCLEO (21-sep): el mismo texto que Chile
 * (lib/prompt-nucleo/texto.ts) con la ficha colombiana como parámetros. Se
 * enciende por vic_kv `prompt_nucleo_co`="on" en el webhook CO; apagado, CO
 * sigue con su prompt propio (lib/paises/co/prompt.ts).
 */
import { armarPromptBase } from "../../prompt-nucleo/armar.ts"
import { FICHA_CO } from "./ficha.ts"
import { CATALOGO_MODULOS_CO, CATALOGO_HARDWARE_CO } from "./catalogo.ts"
import { anclajeTemporalCO, bloqueTelefonoCO } from "./anclaje.ts"

/** Catálogo CO para el prompt, SIN montos: la tool es la única fuente de precio. */
export function formatCatalogoParaPromptCO(): string {
  const lineasModulos = CATALOGO_MODULOS_CO.filter((m) => m.disponibleParaVicky !== false)
    .map((m) => `  - ${m.id}: ${m.nombre} — tarifa fija mensual hasta 10 personas, por persona desde 11 (el monto exacto lo entrega cotizar_referencial; precio final, sin IVA). ${m.descripcion || ""}`.trimEnd())
    .join("\n")
  const hardware = CATALOGO_HARDWARE_CO.filter((h) => h.disponibleParaVicky !== false)
  const lineasHardware =
    hardware.length === 0
      ? "  (ningún dispositivo de marcaje habilitado actualmente)"
      : hardware
          .map((h) => {
            const mods = (h.modalidadesDisponibles || []).map((m) => (m === "arriendo" ? "alquiler mensual (envío e instalación gratis)" : "compra (pago único; envío e instalación según zona)")).join(" o ")
            return `  - ${h.id}: ${h.displayName} — ${mods}; el monto en COP (con su IVA 19 %) lo entrega cotizar_referencial. Cantidad sugerida: ${h.cantidadSugerida}. ${h.descripcion || ""}`.trimEnd()
          })
          .join("\n")
  return `# Catálogo disponible (Colombia)

## Módulos de software (mensual en pesos colombianos, precio final)

${lineasModulos}

## Hardware de marcaje (opcional, costo adicional)

${lineasHardware}

⚠️ IMPORTANTE: Solo puedes ofrecer productos que aparezcan en estas dos listas. Si un prospecto te pregunta por un módulo o dispositivo que no está aquí, deriva con el ejecutivo (usa derivar_a_soporte motivo "fuera_de_scope"). Los precios SIEMPRE salen de la tool — jamás los enuncies de memoria.`
}

export function promptBaseCONucleo(umbralPrecios?: number): string {
  return armarPromptBase(FICHA_CO, formatCatalogoParaPromptCO(), umbralPrecios)
}

/** Reemplazo 1:1 de getSystemPromptCO cuando el núcleo está encendido. */
export function getSystemPromptCONucleo(contact?: string, umbralPrecios?: number): string {
  return anclajeTemporalCO() + bloqueTelefonoCO(contact) + promptBaseCONucleo(umbralPrecios)
}
