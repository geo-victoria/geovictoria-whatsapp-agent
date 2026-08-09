/**
 * Partición del reply en burbujas de WhatsApp (Rodrigo 09-ago: "cada vez que
 * pones un punto aparte, ponlo como un mensaje aparte. Así se ve más natural
 * y el mensaje es menos largo").
 *
 * Reglas:
 *   1. El marcador [---] (o una línea de solo guiones) sigue siendo un corte
 *      DURO, como siempre.
 *   2. Además, cada PÁRRAFO (separado por línea en blanco) es una burbuja.
 *   3. EXCEPCIÓN: los bloques ESTRUCTURADOS no se fragmentan — un resumen de
 *      precios con sus listas y totales se lee como tabla, no como prosa.
 *      Un párrafo de lista/precios se pega al grupo anterior si ese grupo
 *      también es estructurado, y un encabezado corto que termina en ":" se
 *      pega HACIA ADELANTE con la lista que anuncia ("Pago único:" + items).
 *
 * Determinista a propósito: la lección repetida del proyecto es que el guion
 * de prosa pierde contra el hábito del modelo; el corte se hace en código.
 */

const CORTE_DURO = /\n\s*\[?-{3,}\]?\s*(?:\n|$)/

/** ¿El párrafo es parte de un bloque estructurado (lista o líneas de precio)? */
function esEstructurado(parrafo: string): boolean {
  return parrafo
    .split("\n")
    .some(
      (l) =>
        /^\s*[-•·✔☑*]\s+/.test(l) ||
        /^\s*(Subtotal|IVA\s*\(|Total\s|Equivalente|Al aceptar pagas)/i.test(l),
    )
}

/** ¿Encabezado corto que anuncia lo que viene ("Pago único:", "💡 …:")? */
function esEncabezado(parrafo: string): boolean {
  const lineas = parrafo.split("\n")
  return lineas.length === 1 && /:\s*$/.test(parrafo) && parrafo.length <= 120
}

export function partirEnBurbujas(texto: string): string[] {
  const burbujas: string[] = []
  for (const bloque of String(texto || "").split(CORTE_DURO)) {
    const parrafos = bloque
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean)
    const grupos: string[][] = []
    for (const p of parrafos) {
      const grupo = grupos[grupos.length - 1]
      const anterior = grupo?.[grupo.length - 1]
      const pegar =
        !!anterior &&
        esEstructurado(p) &&
        (esEstructurado(anterior) || esEncabezado(anterior))
      if (pegar) {
        grupo.push(p)
      } else {
        grupos.push([p])
      }
    }
    for (const g of grupos) burbujas.push(g.join("\n\n"))
  }
  return burbujas.filter(Boolean)
}
