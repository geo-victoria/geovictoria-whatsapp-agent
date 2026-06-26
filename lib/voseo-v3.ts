/**
 * Saneador anti-voseo determinista, compartido entre el webhook de Botmaker y
 * el cron de re-engagement. La regla del prompt ya pide español chileno
 * (tuteo), pero el modelo se escapa de forma intermitente ("Recordá", "Acá").
 * Esta capa normaliza los voseos/argentinismos más comunes en el texto de
 * salida, antes de persistir y enviar, preservando la mayúscula inicial.
 * Usa límites Unicode (\p{L}) porque \b no funciona junto a vocales acentuadas.
 */
const VOSEO_MAP: [RegExp, string][] = [
  [/(?<!\p{L})record[aá](?!\p{L})/giu, "recuerda"],
  [/(?<!\p{L})ac[aá](?!\p{L})/giu, "aquí"],
  [/(?<!\p{L})pod[eé]s(?!\p{L})/giu, "puedes"],
  [/(?<!\p{L})ten[eé]s(?!\p{L})/giu, "tienes"],
  [/(?<!\p{L})quer[eé]s(?!\p{L})/giu, "quieres"],
  [/(?<!\p{L})sab[eé]s(?!\p{L})/giu, "sabes"],
  [/(?<!\p{L})hac[eé]s(?!\p{L})/giu, "haces"],
  [/(?<!\p{L})mir[aá](?!\p{L})/giu, "mira"],
  [/(?<!\p{L})fijate(?!\p{L})/giu, "fíjate"],
  [/(?<!\p{L})avisame(?!\p{L})/giu, "avísame"],
  [/(?<!\p{L})contame(?!\p{L})/giu, "cuéntame"],
  [/(?<!\p{L})disculpá(?!\p{L})/giu, "disculpa"],
  [/(?<!\p{L})dale(?!\p{L})/giu, "ya"],
  // Modismos chilenos demasiado informales para el registro neutro-profesional
  // (el prompt los prohíbe, pero el modelo se escapa: "claro po", "al tiro",
  // "¿cachái?"). Se normalizan antes de enviar.
  [/(?<!\p{L})al\s+tiro(?!\p{L})/giu, "de inmediato"],
  [/(?<!\p{L})altiro(?!\p{L})/giu, "de inmediato"],
  [/(?<!\p{L})cach[aá][iy](?!\p{L})/giu, "sabes"],
  // "po" muletilla al final de frase ("listo po", "claro po,") → se elimina.
  [/\s+po(?=[\s.,!?;:)¿¡]|$)/giu, ""],
  // ── Voseo verbal chileno (terminaciones -ái / -ís / -oi) → tuteo. Lista
  // CURADA por verbo a propósito: una regex genérica de "-ai"/"-is" rompería
  // palabras legítimas (país, seis, crisis, análisis, Dubái, "tenis" el
  // deporte). Por eso cada verbo va explícito y con límites Unicode \p{L}.
  // (Caso real: "Me los pasai?" — sonaba demasiado informal para venta.)
  [/(?<!\p{L})pas[aá]i(?!\p{L})/giu, "pasas"],
  [/(?<!\p{L})tom[aá]i(?!\p{L})/giu, "tomas"],
  [/(?<!\p{L})marc[aá]i(?!\p{L})/giu, "marcas"],
  [/(?<!\p{L})and[aá]i(?!\p{L})/giu, "andas"],
  [/(?<!\p{L})est[aá]i(?!\p{L})/giu, "estás"],
  [/(?<!\p{L})necesit[aá]i(?!\p{L})/giu, "necesitas"],
  [/(?<!\p{L})llam[aá]i(?!\p{L})/giu, "llamas"],
  [/(?<!\p{L})v[aá]i(?!\p{L})/giu, "vas"],
  [/(?<!\p{L})quer[ií]s(?!\p{L})/giu, "quieres"],
  [/(?<!\p{L})pod[ií]s(?!\p{L})/giu, "puedes"],
  [/(?<!\p{L})hac[ií]s(?!\p{L})/giu, "haces"],
  [/(?<!\p{L})sab[ií]s(?!\p{L})/giu, "sabes"],
  [/(?<!\p{L})dec[ií]s(?!\p{L})/giu, "dices"],
  [/(?<!\p{L})tenís(?!\p{L})/giu, "tienes"], // solo acentuado: "tenis" es el deporte
  [/(?<!\p{L})erís(?!\p{L})/giu, "eres"],
  [/(?<!\p{L})soi(?!\p{L})/giu, "eres"],
  [/(?<!\p{L})vení(?!\p{L})/giu, "ven"],
]

export function sanitizarVoseo(texto: string): string {
  if (!texto) return texto
  let out = texto
  for (const [re, repl] of VOSEO_MAP) {
    out = out.replace(re, (match) =>
      match[0] === match[0].toUpperCase()
        ? repl.charAt(0).toUpperCase() + repl.slice(1)
        : repl,
    )
  }
  return out
}

/**
 * Normaliza el formato a la sintaxis de WhatsApp. Decisión de producto: Vicky
 * NO usa negritas (se ve a bot / cargado). Por eso esta función ELIMINA las
 * negritas en vez de convertirlas: quita los asteriscos de los pares `**texto**`
 * y `*texto*`, dejando el texto plano. Los `*` sueltos (p. ej. una viñeta a
 * inicio de línea) se conservan porque no forman par.
 */
export function normalizarFormatoWhatsApp(texto: string): string {
  if (!texto) return texto
  let out = texto.replace(/\*\*(.+?)\*\*/gs, "$1") // **texto** → texto
  out = out.replace(/\*([^*\n]+?)\*/g, "$1") // *texto* → texto
  out = out.replace(/\*\*+/g, "") // restos de ** sueltos
  return out
}

/**
 * Quita los signos de APERTURA `¡` y `¿`. En WhatsApp chileno informal nadie
 * abre con `¡`/`¿`; ponerlos delata al bot (feedback real). Se conservan los de
 * cierre (`!`, `?`). Determinista, se aplica al texto de salida.
 */
export function quitarSignosApertura(texto: string): string {
  if (!texto) return texto
  return texto.replace(/[¡¿]/g, "")
}
