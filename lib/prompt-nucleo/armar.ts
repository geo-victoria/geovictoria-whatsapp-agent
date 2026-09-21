/**
 * Arma el prompt de un país desde el núcleo + su ficha, con el ajuste de
 * umbral de venta autónoma (Lalo 08-ago) copiado de getSystemPromptV3: son
 * replace de cadenas EXACTAS del núcleo — si una línea del núcleo cambia sin
 * actualizar esto, el replace no matchea (degradación suave; el guard
 * determinista del agent-loop sigue firme) y tests/umbral-autonomia lo ancla.
 *
 * PURO: sin red ni `@/`.
 */
import type { FichaPrompt } from "./ficha.ts"
import { textoNucleo } from "./texto.ts"

export function aplicarUmbral(base: string, umbralPreciosCL?: number): string {
  if (umbralPreciosCL && umbralPreciosCL < 50) {
    const u = String(umbralPreciosCL)
    base = base
      .replace(
        "- Si tiene 1-50 → puede cotizar (Modo Cotización).",
        `- Si tiene 1-${u} → puede cotizar (Modo Cotización).`,
      )
      .replace(
        '- Si tiene 50+ → no cotiza, pregunta "Prefieres reunión o callback?".',
        `- Si tiene MÁS de ${u} → NO entra a cotizar ni promete "armarte el valor": aplica el FLUJO 21+ de la regla "UMBRAL DE PRECIOS" del inicio (RUT → operación → parafraseo → "¿te llama un ejecutivo o agendamos reunión?" → derivar con derivar_a_soporte).`,
      )
      .replace(
        "Aplica cuando: el usuario pidió cotizar Y tiene entre 1 y 50 trabajadores.",
        `Aplica cuando: el usuario pidió cotizar Y tiene entre 1 y ${u} trabajadores. Con MÁS de ${u} NO entres a este modo (ni a su checklist): aplica la regla "UMBRAL DE PRECIOS" del inicio — deriva y acompaña sin precios.`,
      )
      .replace(
        "Cuando el camino es cotizar (1-50 trabajadores), sigue este orden:",
        `Cuando el camino es cotizar (1-${u} trabajadores), sigue este orden:`,
      )
      // El selector de CAMINOS y el párrafo "ÚNICO tope de scope" eran los
      // que seguían ganando en la E2E: el modelo elegía camino "Cotizar"
      // por el 1-50 de estas líneas aunque el flujo ya dijera 1-N.
      .replace(
        "2. Cotizar — generar una cotización formal con PDF. Solo para empresas de 1 a 50 trabajadores.",
        `2. Cotizar — generar una cotización formal con PDF. Solo para empresas de 1 a ${u} trabajadores (tu UMBRAL DE PRECIOS en esta conversación; con más de ${u}, el precio lo entrega un ejecutivo — regla del inicio).`,
      )
      .replace(
        "El ÚNICO tope de scope es la cantidad de TRABAJADORES (1 a 50).",
        `El ÚNICO tope de scope es la cantidad de TRABAJADORES (1 a ${u} en esta conversación — regla UMBRAL DE PRECIOS del inicio).`,
      )
      .replace(
        "Una empresa de 43 trabajadores en 50 sucursales se cotiza igual que una en 1 oficina",
        `Una empresa de ${u} trabajadores en 50 sucursales se cotiza igual que una en 1 oficina`,
      )
      .replace(
        "si las personas están dentro de 1-50, cotizas, tenga los puntos que tenga.",
        `si las personas están dentro de 1-${u}, cotizas, tenga los puntos que tenga; sobre ${u}, derivas y acompañas sin precios (regla del inicio), tenga los puntos que tenga.`,
      )
      .replace(
        "Si el total sumado está entre 1 y 50, cotiza normal:",
        `Si el total sumado está entre 1 y ${u}, cotiza normal:`,
      )
      .replace(
        "Solo si el total sumado supera 50 trabajadores deriva (derivar_a_soporte motivo \"fuera_de_rango_trabajadores\"), igual que cualquier caso sobre 50.",
        `Si el total sumado supera ${u} trabajadores deriva (derivar_a_soporte motivo "fuera_de_rango_trabajadores"), igual que cualquier caso sobre ${u}.`,
      )
      .replace(
        '- El rango de empleados del formulario (ej. "20 - 49") te dice que califica (≤50) pero NO basta para cotizar: confirma el número EXACTO con una sola pregunta natural ("vi que son entre 20 y 49 — ¿cuántos exactamente, para armarte el valor de inmediato?"). Si el exacto resulta >50, deriva a ejecutivo como siempre.',
        `- El rango de empleados del formulario (ej. "20 - 49") NO basta: confirma el número EXACTO con una sola pregunta natural ("vi que son entre 20 y 49 — ¿cuántos exactamente?"). Si el exacto supera ${u} (tu UMBRAL DE PRECIOS), entra al FLUJO 21+ de la regla del inicio (RUT → operación → parafraseo → llamada de ejecutivo o reunión).`,
      )
      .replace(
        "— calcula un estimado mensual. Solo funciona para 1-50 trabajadores.",
        `— calcula un estimado mensual. Solo funciona para 1-${u} trabajadores (tu umbral: el sistema RECHAZA la llamada sobre ${u}).`,
      )
  }
  return base
}

export function armarPromptBase(f: FichaPrompt, catalogoTxt: string, umbral?: number): string {
  return aplicarUmbral(textoNucleo(f, catalogoTxt), umbral)
}
