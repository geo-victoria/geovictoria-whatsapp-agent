/**
 * UNA SOLA PUERTA DE ENTREGA (Eduardo 17-ago).
 *
 * "La puerta de envío de cotización es solo una, la que configuramos como
 * plantilla." Antes de esto el link se colaba por dos caminos distintos —la
 * entrega de la tool y el bloque "ESTADO DE ESTE CONTACTO"— y el cliente
 * recibía la plantilla con el botón Y el link pegado como texto (caso Rodrigo,
 * 17-ago: Botmaker lo acortó a botm.cc y parecían dos links distintos).
 *
 * Dos intentos de arreglarlo por prompt fallaron, así que esto es un CANDADO:
 * el texto que sale al cliente no puede llevar un link de aceptación, lo diga
 * el modelo o no.
 *
 * PURO: sin red ni base de datos, para poder testearlo.
 */

/** Links de aceptación en cualquiera de sus formas (largo con token o corto /q/). */
const LINKS_ACEPTACION =
  /https?:\/\/[^\s]*(?:quote-acceptance\.html[^\s]*|\/q\/[A-Za-z0-9-]+)/gi

/**
 * Quita del texto los links de aceptación y limpia lo que queda colgando
 * (dos puntos sueltos, líneas vacías, "aquí:" sin nada detrás).
 */
export function quitarLinksDeAceptacion(texto: string): {
  limpio: string
  quitados: number
} {
  const original = String(texto || "")
  const encontrados = original.match(LINKS_ACEPTACION)
  if (!encontrados || !encontrados.length) return { limpio: original, quitados: 0 }

  let limpio = original.replace(LINKS_ACEPTACION, "")
  // Restos típicos: "revisar, aceptar y pagar: " / línea que quedó vacía.
  limpio = limpio
    .split("\n")
    .map((l) => l.replace(/[:\s]+$/u, (m) => (m.includes("\n") ? m : "")))
    .filter((l, i, arr) => l.trim() !== "" || (i > 0 && arr[i - 1].trim() !== ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  return { limpio, quitados: encontrados.length }
}

/** Frases que solo existen como envoltorio del link ("Listo! / Aquí revisas,
 * aceptas y pagas…"). Si el link ya salió en la plantilla, estas líneas
 * quedan huérfanas y hay que botarlas enteras. */
const BOILERPLATE_ENTREGA =
  /revisas,?\s*aceptas?\s*y\s*pagas|aquí\s+puedes\s+revisar,?\s*aceptar|te\s+dejo\s+el\s+link|problema\s+generando\s+tu\s+cotización/i

/**
 * Versión dura para cuando la PLANTILLA ya salió en este turno: además de los
 * links, bota las líneas de entrega huérfanas ("Listo! 🎉 / Aquí revisas…")
 * — caso Rodrigo 17-ago: el candado le quitó el link pero le dejó el texto,
 * y el cliente recibió la entrega dos veces.
 */
export function quitarEntregaCompleta(texto: string): { limpio: string; quitados: number } {
  const base = quitarLinksDeAceptacion(texto)
  const lineas = base.limpio.split("\n")
  const filtradas: string[] = []
  for (const [i, l] of lineas.entries()) {
    if (BOILERPLATE_ENTREGA.test(l)) {
      // La línea "Listo!" inmediatamente anterior es parte del mismo bloque.
      const prev = filtradas[filtradas.length - 1] || ""
      if (/^\s*¡?Listo[a-z]*[!\s🎉🎊✨]*$/iu.test(prev)) filtradas.pop()
      continue
    }
    void i
    filtradas.push(l)
  }
  const limpio = filtradas
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  const quitados = base.quitados + (limpio === base.limpio.trim() ? 0 : 1)
  return { limpio, quitados }
}
