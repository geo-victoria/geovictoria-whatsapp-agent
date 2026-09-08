/**
 * Detector DETERMINISTA de rechazo o cierre por parte del cliente (08-sep,
 * campaña remk_300: el loop siguió tocando a gente que ya había dicho "no
 * gracias" / "quedamos hasta aquí" / "ya contratamos", y una clienta terminó
 * pidiendo que dejaran de escribirle).
 *
 * Puro: sin red. Lo usan el cron de toques (antes de mandar cualquier toque
 * se mira el ÚLTIMO mensaje del cliente) y quien quiera cerrar un loop al
 * vuelo. Un rechazo NO es opt-out (eso sigue siendo `voz_no_llamar_` y el
 * detector de opt-out del webhook): solo apaga la PROACTIVIDAD comercial —
 * Vicky sigue respondiendo si el cliente vuelve a escribir.
 */

const PATRONES: RegExp[] = [
  /\bno[,.]?\s*(muchas\s+)?gracias\b/i,
  /\bno\s+(me\s+|nos\s+)?interesa/i,
  /\bno\s+estoy\s+interesad/i,
  /\bno\s+estamos\s+interesad/i,
  /\bya\s+(lo\s+|la\s+)?(contrat|compr|resolv|adquir)/i,
  /\bya\s+tenemos\s+(otro|un|proveedor|sistema)/i,
  /\bya\s+no\s+(lo\s+|la\s+)?(necesit|quiero|requier)/i,
  /\bno\s+(lo\s+|la\s+)?(necesito|necesitamos|quiero|queremos|vamos\s+a\s+(tomar|contratar|seguir))/i,
  /\bquedamos\s+hasta\s+aqu[ií]/i,
  /\bhasta\s+aqu[ií]\s+(no\s+m[aá]s|llegamos|queda)/i,
  /\bdej(a|en|ar)\s+de\s+(escribir|llamar|contactar|molestar|insistir)/i,
  /\bno\s+(me\s+)?(escriban|escribas|llamen|llames|contacten|contactes|insistan|molesten)/i,
  /\bme\s+desvincul/i,
  /\bya\s+no\s+(trabajo|estoy|administro|pertenezco)/i,
  /\bno\s+(lo\s+)?vamos\s+a\s+(seguir|avanzar|continuar)/i,
  /\bdescartad[oa]s?\b/i,
  /\besto\s+(ser[ií]a|es)\s+spam/i,
  /\bnos\s+quedamos\s+con\s+(otro|otra|la\s+competencia)/i,
  /\belegimos\s+(otro|otra)/i,
  /\bpor\s+ahora\s+no\b/i,
  /\bno\s+por\s+ahora\b/i,
]

/** Mensajes cortos que solos ya son un "no" ("no", "no gracias", "nop"). */
const SOLO_NO = /^\s*(no+|nop|nel|nope|no\s+gracias|gracias[,.]?\s*no)\s*[.!]*\s*$/i

export function esRechazoCliente(texto: string): boolean {
  const t = String(texto || "").trim()
  if (!t) return false
  if (t.startsWith("[REGISTRO INTERNO")) return false
  if (SOLO_NO.test(t)) return true
  return PATRONES.some((re) => re.test(t))
}

/** Último mensaje "de verdad" del cliente en un historial (ignora registros
 * internos y adjuntos transcritos). */
export function ultimoMensajeCliente(
  historial: Array<{ role: string; content?: string | null }>,
): string {
  for (let i = historial.length - 1; i >= 0; i--) {
    const m = historial[i]
    if (m.role !== "user") continue
    const c = String(m.content || "")
    if (c.startsWith("[REGISTRO INTERNO")) continue
    return c
  }
  return ""
}

/** El texto que devolvió un generador de toques ¿es razonamiento interno del
 * modelo en vez de un mensaje al cliente? (caso 08-sep: salió "No hay
 * mensaje que escribir en este caso. El cliente se desvinculó…"). */
export function pareceTextoInterno(texto: string): boolean {
  const t = String(texto || "")
  return (
    /\bNO_ENVIAR\b/.test(t) ||
    /\bno\s+hay\s+mensaje\b/i.test(t) ||
    /\bno\s+(corresponde|deber[ií]a|debo|procede)\s+(enviar|escribir|mandar|retomar)/i.test(t) ||
    /\bel\s+cliente\s+(se\s+desvincul|cerr[oó]|fue\s+claro|ya\s+(dijo|indic[oó]|declin))/i.test(t) ||
    /\bno\s+existe\s+(un\s+)?(dolor|duda|pendiente)/i.test(t) ||
    /\bcerr[oó]\s+(expl[ií]citamente\s+)?la\s+conversaci[oó]n/i.test(t) ||
    /\b(en\s+este\s+caso|por\s+lo\s+tanto)\b.*\b(no\s+enviar|sin\s+mensaje)/i.test(t)
  )
}
