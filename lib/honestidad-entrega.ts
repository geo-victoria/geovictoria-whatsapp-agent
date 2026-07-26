/**
 * Honestidad sobre la entrega de correos.
 *
 * CASOS REALES QUE ORIGINAN ESTE MÓDULO (26-jul-2026, revisión de las
 * conversaciones): Vicky le afirmó a clientes que su cotización YA HABÍA
 * LLEGADO, mientras el cliente le decía lo contrario.
 *
 *   +56983757162 (22-jul) — Vicky: "la cotización ya fue enviada
 *     automáticamente a admin@simpro.cl cuando la generé. Revisa tu bandeja…"
 *     Cliente: "no llegó".
 *   +56922041679 (20-jul) — Vicky: "La cotización ya te llegó al correo
 *     gfuentes@wgservicios.cl cuando la generé." Cliente: "No ha llegado nada".
 *
 * POR QUÉ ES UNA MENTIRA DEL SISTEMA, NO DEL MODELO: el envío va por la acción
 * send_mail de Zoho CRM, y lo único que ese registro guarda es
 * status: [{type: "sent"}] — verificado el 26-jul con 5 envíos de prueba. No
 * existe "delivered" ni "bounced" en ninguna parte. Es decir: nadie, ni Vicky
 * ni nosotros, puede saber si un correo llegó. Afirmarlo es inventar.
 *
 * QUÉ HACE ESTE MÓDULO: degrada las afirmaciones de RECEPCIÓN a afirmaciones
 * de ENVÍO — que sí son verdaderas y comprobables. "Ya te llegó" → "la envié".
 * Y corrige el consejo de búsqueda: el correo de Vicky pasa autenticación
 * (SPF/DMARC verificados), así que rara vez cae en spam; cae en Promociones de
 * Gmail o en Otros de Outlook, que es donde el cliente no mira.
 *
 * Módulo puro: solo transforma texto.
 */

/**
 * Afirmaciones de que el correo LLEGÓ / FUE RECIBIDO, con su reemplazo honesto.
 * El orden importa: las formas más largas van primero para que no las parta
 * una regla más corta.
 */
// Los límites van con \p{L} y NO con \b: en JS, "\b" es ASCII, así que
// "llegó\b" no matchea nunca (la ó no es word char y no abre frontera después).
// Mismo criterio que lib/voseo-v3.ts.
const L = "\\p{L}"
const re = (patron: string) => new RegExp(`(?<!${L})(?:${patron})(?!${L})`, "giu")

/**
 * Todos los reemplazos usan "salió" y NUNCA un pronombre de objeto ("te la
 * envié"). Motivo, encontrado el 26-jul antes de que llegara a producción: el
 * mensaje de entrega más frecuente del sistema dice "También te llegó el PDF
 * de respaldo a tu correo" — con el objeto DESPUÉS del verbo. Reemplazarlo por
 * "te la envié" producía "También te la envié el PDF", con la concordancia
 * rota. "Salió" convierte la cosa enviada en sujeto, así que funciona con el
 * objeto antes o después y sin género:
 *
 *   "La cotización ya te llegó al correo"  → "La cotización ya salió al correo"
 *   "También te llegó el PDF a tu correo"  → "También salió el PDF a tu correo"
 *
 * Una frase rota daña más la credibilidad que la sobreafirmación que corrige:
 * ante la duda, el reemplazo tiene que ser gramatical SIEMPRE.
 */
const AFIRMACIONES: Array<[RegExp, string]> = [
  [re("ya\\s+est[aá]\\s+en\\s+tu\\s+(?:bandeja|correo|casilla)"), "ya salió a tu correo"],
  [
    re("(?:deber[ií]a|debe)\\s+estar\\s+en\\s+tu\\s+(?:bandeja|correo|casilla)"),
    "salió a tu correo",
  ],
  // "el correo llegó" / "la cotización llegó" — NO toca "el reloj llegó".
  [re("(?:el\\s+correo|la\\s+cotizaci[oó]n|el\\s+mail)\\s+(?:ya\\s+)?lleg[oó]"), "eso salió"],
  // "ya te llegó" / "te llegó" — el sujeto sigue siendo lo enviado.
  [re("ya\\s+(?:te|le|les)\\s+lleg[oó]"), "ya salió"],
  [re("(?:te|le|les)\\s+lleg[oó]"), "salió"],
  // "ya la recibiste" / "ya lo recibió"
  [re("ya\\s+l[oa]s?\\s+recib(?:iste|i[oó]|ieron)"), "ya salió"],
]

/** Consejo de búsqueda incompleto: solo spam. */
const SOLO_SPAM =
  /\b(?:revisa|revisá|mira|busca|chequea|fíjate|fijate)\b[^.\n]{0,60}\b(?:spam|correo no deseado|no deseados?)\b/giu

/** ¿El texto ya menciona las pestañas donde realmente cae? */
const YA_MENCIONA_PESTANAS = /promocion|social(?:es)?\b|\botros\b|\bfocused\b|no priorit/iu

/**
 * Degrada afirmaciones de recepción a afirmaciones de envío.
 * Idempotente: aplicarla dos veces da lo mismo que aplicarla una.
 */
export function honestarEntregaCorreo(texto: string): string {
  if (!texto) return texto
  let out = texto
  for (const [re, repl] of AFIRMACIONES) {
    out = out.replace(re, (match) =>
      // Conserva la mayúscula inicial si la afirmación abría la frase.
      match[0] === match[0].toUpperCase() && match[0] !== match[0].toLowerCase()
        ? repl.charAt(0).toUpperCase() + repl.slice(1)
        : repl,
    )
  }
  return out
}

/**
 * Completa el consejo de búsqueda: mandar a revisar SOLO spam es mandar al
 * lugar equivocado. Con SPF y DMARC en regla el correo no suele marcarse como
 * spam — se clasifica como promocional. (Confirmado el 26-jul: la prueba a
 * egomez@geovictoria.com llegó a la pestaña "Otros" de Outlook, no a spam.)
 */
export function corregirDondeBuscar(texto: string): string {
  if (!texto || YA_MENCIONA_PESTANAS.test(texto)) return texto
  return texto.replace(
    SOLO_SPAM,
    (match) => `${match}, y también en Promociones si usas Gmail o en Otros si usas Outlook`,
  )
}

/** Las dos correcciones, en el orden en que deben aplicarse. */
export function honestarMencionesDeCorreo(texto: string): string {
  return corregirDondeBuscar(honestarEntregaCorreo(texto))
}
