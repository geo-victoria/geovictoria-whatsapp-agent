/**
 * LAS PREGUNTAS QUE CHILE RETIRÓ Y NADIE DEBE VOLVER A HACER.
 *
 * Chile es el modelo de comportamiento (Lalo 21-sep). Su prompt retiró estas
 * preguntas una por una porque cada turno extra es fricción y porque el dato
 * ya se sabe o tiene un default: el arriendo es el default del reloj, la
 * auto-instalación es el default de la instalación, los puntos salen de cómo
 * el cliente describió su operación. Están escritas como prohibición explícita
 * en los prompts —en Perú, en mayúsculas, línea 190— y el modelo las hace
 * igual de forma intermitente: la conversación de Rodrigo del 21-sep preguntó
 * "arriendo o compra" y la REPREGUNTÓ al turno siguiente; una tercera corrida,
 * mismo build, preguntó quién instala.
 *
 * El prompt declara la regla; esto la hace cumplir. Mismo patrón que el
 * cinturón de precios sin tool: se detecta sobre el texto SALIENTE y se fuerza
 * un reintento.
 *
 * PURO: sin red. Lo cablean los cuatro webhooks.
 */

/** Sin tildes ni mayúsculas: los patrones corren sobre texto normalizado. */
function normalizar(t: string): string {
  return String(t || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
}

type Prohibida = { id: string; regla: string; re: RegExp }

/**
 * Cada patrón exige la forma INTERROGATIVA o de elección — mencionar el
 * arriendo o la instalación al informar es legítimo y frecuente ("el arriendo
 * incluye el envío"); lo prohibido es devolverle la decisión al cliente.
 */
const PROHIBIDAS: readonly Prohibida[] = [
  {
    id: "modalidad_reloj",
    regla: "El arriendo es el default del reloj: no se pregunta arriendo o compra",
    re: /(arriendo|arrendar|arrendado)[^.?!]{0,60}\bo\b[^.?!]{0,30}(compra|comprar|comprarlo)[^.?!]{0,40}\?|prefieres[^.?!]{0,40}(arrendar|comprar)[^.?!]{0,40}\?|(lo|la) (prefieres|quieres)[^.?!]{0,30}(en arriendo|arrendado)[^.?!]{0,30}\?/,
  },
  {
    id: "quien_instala",
    regla: "No se pregunta quién instala: auto-instalación por defecto, técnico opcional",
    re: /quien[^.?!]{0,30}(lo |la )?instala[^.?!]{0,40}\?|(instalacion|instalarlo|instalarla)[^.?!]{0,80}(por tu cuenta|la harias|lo harias|tu mismo|ustedes mismos)[^.?!]{0,40}\?|prefieres que[^.?!]{0,60}(servicio tecnico|tecnico)[^.?!]{0,60}\?/,
  },
  {
    id: "cuantos_puntos",
    regla: "Los puntos o sedes salen de la descripción de la operación, no se preguntan",
    re: /en cuantos[^.?!]{0,20}(puntos|sedes|sucursales|lugares|oficinas)[^.?!]{0,40}\?|cuantos[^.?!]{0,20}(puntos de marcaje|puntos fisicos)[^.?!]{0,30}\?/,
  },
]

export type Hallazgo = { id: string; regla: string }

/** Las preguntas prohibidas presentes en un texto saliente. */
export function preguntasProhibidasEn(texto: string): Hallazgo[] {
  const t = normalizar(texto)
  if (!t.trim()) return []
  return PROHIBIDAS.filter((p) => p.re.test(t)).map((p) => ({ id: p.id, regla: p.regla }))
}

/** La instrucción de sistema del reintento, armada con lo que se detectó. */
export function directivaSinPreguntasProhibidas(hallazgos: readonly Hallazgo[]): string {
  if (!hallazgos.length) return ""
  const lista = hallazgos.map((h) => `- ${h.regla}`).join("\n")
  return (
    "\n\n# Instrucción de sistema (este turno)\n" +
    "Tu borrador anterior le hizo al cliente una pregunta que está PROHIBIDA en el flujo:\n" +
    lista +
    "\nReescribe la respuesta SIN esa pregunta: aplica el default que corresponde y sigue " +
    "avanzando hacia el precio. Si necesitabas un dato, pide SOLO el que el flujo permite " +
    "(la ubicación de cada punto) y en UNA frase."
  )
}
