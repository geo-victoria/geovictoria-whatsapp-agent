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

/**
 * Blinda los contactos COMERCIALES (Eddyluz Mujica y Anderson Díaz) para que NUNCA se
 * filtre en casos de SOPORTE.
 *
 * Casuística real (2 casos, 27-jun): a clientes que pedían soporte ("no me abre
 * la app", "no veo una de mis empresas"), Vicky entregó el WhatsApp de Anderson
 * (+56 9 3937 2058) rotulado como "equipo de soporte". Razón: ese número vive en
 * el prompt para el traspaso comercial post-cotización, y el modelo lo tomaba de
 * memoria cuando el cliente insistía pidiendo un contacto — el número REAL de
 * soporte NO está en el prompt, así que era el único teléfono que tenía a mano.
 *
 * Señal limpia: el número de Anderson SOLO es legítimo cuando hubo una cotización
 * (es el cierre del flujo comercial). Si no hubo cotización, cualquier aparición
 * es una fuga: la reemplazamos por el WhatsApp REAL de soporte, que es el canal
 * correcto para esos casos. Determinista, se aplica al texto de salida.
 */
// Teléfonos comerciales en sus formatos típicos de salida (con/sin +56,
// con/sin el 9). Núcleos distintivos: "3937 ... 2058" (Anderson, deals
// anteriores al relevo del 27-jul) y "3932 ... 1687" (Eddyluz, deals nuevos).
// El relevo NO retira el blindaje viejo: el número de Anderson sigue vivo en
// historiales y el modelo puede repetirlo desde ahí.
const ANDERSON_TEL_RE = /(?:\+?\s*56)?[\s)]*(?:9[\s).-]*)?3937[\s).-]*2058/gi
const EDDYLUZ_TEL_RE = /(?:\+?\s*56)?[\s)]*(?:9[\s).-]*)?3932[\s).-]*1687/gi
// Fuente de verdad del canal de soporte: MENSAJE_ESCALAMIENTO_HUMANO en
// lib/tools/consultar-agente-soporte.ts. Si cambia allá, actualizar aquí.
const SOPORTE_WHATSAPP = "+56 9 4401 3873"

export function blindarContactoComercial(
  texto: string,
  permitidoComercial: boolean,
): string {
  if (!texto || permitidoComercial) return texto
  return texto.replace(ANDERSON_TEL_RE, SOPORTE_WHATSAPP).replace(EDDYLUZ_TEL_RE, SOPORTE_WHATSAPP)
}
