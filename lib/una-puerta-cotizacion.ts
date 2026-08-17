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
