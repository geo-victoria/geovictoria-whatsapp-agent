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
