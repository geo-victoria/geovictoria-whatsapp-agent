/**
 * NOMBRE DEL EQUIPO EN MÉXICO (Lalo 24-sep, tras la prueba de Rodrigo: "nunca
 * debe decir 'reloj' solamente, o dice 'reloj checador' o 'checador' solo").
 *
 * El núcleo del prompt es el texto de Chile y dice "reloj" decenas de veces;
 * por más que la ficha nombre el equipo como "reloj checador", el modelo
 * copia "el reloj" a secas ("con app y reloj entonces. ¿En qué ciudad estará
 * el reloj?"). Esta capa es DETERMINISTA y corre sobre todo texto que sale a
 * un cliente mexicano: "reloj" suelto → "checador" (mismo género, cero
 * reescritura), "reloj de control (físico)" → "reloj checador", y "reloj
 * checador" queda intacto. Opera FUERA de URLs (regla dura del canario) y no
 * toca ids como `reloj_mx` (el guion bajo corta el borde de palabra).
 *
 * PURO: sin imports.
 */

const URL_RE = /https?:\/\/\S+/g

function conMayuscula(original: string, nuevo: string): string {
  return original[0] === original[0].toUpperCase() ? nuevo[0].toUpperCase() + nuevo.slice(1) : nuevo
}

function reemplazarTramo(t: string): string {
  return t
    // "reloj de control físico" / "reloj control" → "reloj checador"
    .replace(/\breloj(es)?\s+(?:de\s+)?control(?:\s+f[ií]sico)?\b/gi, (m, pl: string | undefined) =>
      conMayuscula(m, pl ? "relojes checadores" : "reloj checador"),
    )
    // "reloj" suelto (no seguido de "checador") → "checador"
    .replace(/\breloj(es)?\b(?![_\w])(?!\s+checador)/gi, (m, pl: string | undefined) =>
      conMayuscula(m, pl ? "checadores" : "checador"),
    )
}

export function nombreEquipoMX(texto: string): string {
  if (!texto || !/reloj/i.test(texto)) return texto
  let salida = ""
  let ultimo = 0
  for (const url of texto.matchAll(URL_RE)) {
    const i = url.index ?? 0
    salida += reemplazarTramo(texto.slice(ultimo, i)) + url[0]
    ultimo = i + url[0].length
  }
  return salida + reemplazarTramo(texto.slice(ultimo))
}
