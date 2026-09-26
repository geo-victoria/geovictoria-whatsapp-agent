/**
 * PROMPT DE MÉXICO DESDE EL NÚCLEO (24-sep): el mismo texto que Chile
 * (lib/prompt-nucleo/texto.ts) con la ficha mexicana como parámetros. Es el
 * ÚNICO prompt del país: el propio se retiró el 26-sep y el turno lo arma el
 * orquestador único con el perfil del país.
 */
import { armarPromptBase } from "../../prompt-nucleo/armar.ts"
import { FICHA_MX } from "./ficha.ts"
import { CATALOGO_MODULOS_MX, CATALOGO_HARDWARE_MX } from "./catalogo.ts"
import { anclajeTemporalMX, bloqueTelefonoMX } from "./anclaje.ts"

/** Catálogo MX para el prompt, SIN montos: la tool es la única fuente de precio. */
export function formatCatalogoParaPromptMX(): string {
  const lineasModulos = CATALOGO_MODULOS_MX.filter((m) => m.disponibleParaVicky !== false)
    .map((m) => `  - ${m.id}: ${m.nombre} — tarifa fija mensual hasta 15 personas, por persona desde 16 (el monto exacto lo entrega cotizar_referencial; neto + IVA 16 %). ${m.descripcion || ""}`.trimEnd())
    .join("\n")
  const hardware = CATALOGO_HARDWARE_MX.filter((h) => h.disponibleParaVicky !== false)
  const lineasHardware =
    hardware.length === 0
      ? "  (ningún dispositivo de marcaje habilitado actualmente)"
      : hardware
          .map((h) => {
            const mods = (h.modalidadesDisponibles || []).map((m) => (m === "arriendo" ? "renta mensual (envío incluido; instalación técnica incluida en CDMX y Zona Metropolitana, precio cerrado por zona en el resto)" : "compra (pago único; envío e instalación según zona)")).join(" o ")
            return `  - ${h.id}: Reloj checador — ${mods}; el monto en MXN (+ IVA 16 %) lo entrega cotizar_referencial. Cantidad sugerida: ${h.cantidadSugerida}. ${h.descripcion || ""}`.trimEnd()
          })
          .join("\n")
  return `# Catálogo disponible (México)

## Módulos de software (mensual en pesos mexicanos, + IVA)

${lineasModulos}

## Hardware de marcaje (opcional, costo adicional)

${lineasHardware}

⚠️ IMPORTANTE: Solo puedes ofrecer productos que aparezcan en estas dos listas. Si un prospecto te pregunta por un módulo o dispositivo que no está aquí, deriva con el ejecutivo (usa derivar_a_soporte motivo "fuera_de_scope"). Los precios SIEMPRE salen de la tool — jamás los enuncies de memoria.`
}

export function promptBaseMXNucleo(umbralPrecios?: number): string {
  return armarPromptBase(FICHA_MX, formatCatalogoParaPromptMX(), umbralPrecios)
}

/** Prompt del país: el núcleo armado con su ficha (único prompt desde el 26-sep). */
export function getSystemPromptMXNucleo(contact?: string, umbralPrecios?: number): string {
  return anclajeTemporalMX() + bloqueTelefonoMX(contact) + promptBaseMXNucleo(umbralPrecios)
}
