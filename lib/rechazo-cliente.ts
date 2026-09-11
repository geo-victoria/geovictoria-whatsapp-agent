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
  /\bya\s+no\s+(trabajo|estoy|admi?nistr|pertenezco)/i,
  /\bno\s+(lo\s+)?vamos\s+a\s+(seguir|avanzar|continuar)/i,
  /\bdescartad[oa]s?\b/i,
  /\besto\s+(ser[ií]a|es)\s+spam/i,
  /\bnos\s+quedamos\s+con\s+(otro|otra|la\s+competencia)/i,
  /\belegimos\s+(otro|otra)/i,
  /\bpor\s+ahora\s+no\b/i,
  /\bno\s+por\s+ahora\b/i,
  // 09-sep (caso Marisol/Bruma → Grey, y "Nada gracias" → Anderson): cierres
  // corteses que el detector no leía y que el reloj de etapa convirtió en
  // traspasos, reviviendo deals perdidos.
  /\bgracias\s+de\s+todas\s+(formas|maneras)\b/i,
  /\bgracias\s+de\s+todos\s+modos\b/i,
  /\bya\s+(lo\s+|la\s+)?(solucion|arregl|resolvimos|resolv[ií]|vimos\s+con)/i,
  /^\s*nada[,.]?\s*(muchas\s+)?gracias\b/i,
  /\bya\s+no\s+(lo\s+|la\s+)?(necesito|necesitamos|ocupo|ocupamos)/i,
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

/**
 * AUTORESPUESTA del número (08-sep, campaña remk_300): "Gracias por
 * comunicarte con Lolalash. Para agendar hora…", "En este momento no estamos
 * disponibles por este medio…" — el número contesta solo y NADIE leyó. Sin
 * este detector el loop la tomaba como respuesta viva y seguía tocando
 * (Lolalash recibió dos toques más el mismo día), y el reloj de etapa llegó
 * a revivir un deal perdido a partir de un contestador automático.
 */
const AUTORESPUESTA: RegExp[] = [
  /\bgracias\s+por\s+(comunicarte|comunicarse|contactarte|contactarnos|contactar|escribirnos|escribir|tu\s+mensaje|su\s+mensaje)\b/i,
  /\bmensaje\s+autom[aá]tico\b/i,
  /\brespuesta\s+autom[aá]tica\b/i,
  /\b(en\s+este\s+momento|por\s+el\s+momento|actualmente)\s+no\s+(estamos|podemos|nos\s+encontramos)\b/i,
  /\bfuera\s+de\s+(nuestro\s+)?horario\b/i,
  /\bnuestro\s+horario\s+de\s+atenci[oó]n\b/i,
  /\b(te|le|les)\s+(responderemos|contactaremos|atenderemos|escribiremos)\s+(a\s+la\s+brevedad|en\s+breve|lo\s+antes\s+posible|pronto|a\s+la\s+mayor\s+brevedad)\b/i,
  /\b(c[oó]mo|en\s+qu[eé])\s+(podemos|puedo)\s+ayudar(te|le|los|les)\b\s*\??\s*$/i,
  /\bhaznos\s+saber\s+(c[oó]mo|en\s+qu[eé])\s+podemos\s+ayudarte\b/i,
  /\bpara\s+agendar\s+(hora|cita)\b/i,
  /\bbienvenid[oa]s?\s+a\b[\s\S]{0,80}\b(c[oó]mo|en\s+qu[eé])\s+(te|le)\s+(podemos|puedo)\s+ayudar/i,
]

export function esAutorespuesta(texto: string): boolean {
  const t = String(texto || "").trim()
  if (!t) return false
  if (t.startsWith("[REGISTRO INTERNO") || t.startsWith("[El cliente envió")) return false
  return AUTORESPUESTA.some((re) => re.test(t))
}

/** El generador de toques escribe DENTRO de un marco que ya parte con
 * "Hola, todo bien?" — si el modelo saluda igual, el cliente recibe
 * "Hola, todo bien? Hola, todo bien? …" (5 casos el 08-sep). Se quita el
 * saludo inicial del texto generado, dejando la primera letra en mayúscula. */
export function quitarSaludoInicial(texto: string): string {
  const t = String(texto || "").trim()
  const sin = t
    .replace(
      /^(¡?\s*hola+[\s,!.]*)?(¿?\s*(todo\s+bien|c[oó]mo\s+est[aá]s|qu[eé]\s+tal|buen[oa]s\s+(d[ií]as|tardes|noches))\s*[?!.,]*\s*)*/i,
      "",
    )
    .trim()
  if (!sin || sin === t) return t
  return sin.charAt(0).toUpperCase() + sin.slice(1)
}

/** Último mensaje "de verdad" del cliente en un historial (ignora registros
 * internos y adjuntos transcritos). */
/** Mensajes de cortesía que no dicen nada nuevo ("gracias", "ok", "te
 * agradezco", "👍"): al buscar la ÚLTIMA POSTURA del cliente se saltan, porque
 * después de "ya lo resolvimos" viene casi siempre un "gracias de todas
 * formas" y mirar solo ese último mensaje hacía invisible el rechazo. */
const CORTESIA = /^\s*(muchas\s+gracias|gracias|te\s+agradezco|se\s+agradece|ok(ey|a|as)?|vale|dale|listo|perfecto|bueno|ya|genial|buen[ao]s?\s+(d[ií]as?|tardes|noches)|hasta\s+luego|chao|adi[oó]s|saludos|igualmente)[\s!.,;:]*(\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u200d|\uFE0F|\s)*$/iu
const SOLO_EMOJI = /^[\s\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\uFE0F]+$/u

/** Señales de que el mensaje ANTERIOR de Vicky fue un toque o una pregunta
 * de interés — ahí un "no" pelado sí es rechazo. Fuera de ese contexto
 * ("¿hay algo más en que pueda ayudarte?" → "no") no lo es. */
const PREGUNTA_INTERES = /(sigues?\s+interesad|siguen\s+interesad|retomamos|quer[ií]a\s+saber\s+si|te\s+interesa|les\s+interesa|avanzamos|seguimos\s+con|todo\s+bien\?)/i

/**
 * Postura del cliente en CONTEXTO (09-sep): recorre los mensajes del cliente
 * de atrás hacia adelante saltando cortesías vacías, y evalúa el primero con
 * contenido. Un "no" pelado cuenta solo si Vicky acababa de preguntarle por
 * su interés (toque / reactivación), no si respondía "¿algo más?".
 * Devuelve "no_interesa" | "autorespuesta" | null.
 */
export function posturaRechazoCliente(
  historial: Array<{ role: string; content?: string | null }>,
): "no_interesa" | "autorespuesta" | null {
  let vistos = 0
  for (let i = historial.length - 1; i >= 0 && vistos < 4; i--) {
    const m = historial[i]
    if (m.role !== "user") continue
    const c = String(m.content || "").trim()
    if (!c || c.startsWith("[REGISTRO INTERNO")) continue
    vistos++
    if (esAutorespuesta(c)) return "autorespuesta"
    if (CORTESIA.test(c) || SOLO_EMOJI.test(c)) continue
    if (SOLO_NO.test(c) && !/gracias/i.test(c)) {
      // "no" pelado: mirar qué preguntó Vicky justo antes.
      let previo = ""
      for (let j = i - 1; j >= 0; j--) {
        if (historial[j].role === "assistant") { previo = String(historial[j].content || ""); break }
      }
      return PREGUNTA_INTERES.test(previo) ? "no_interesa" : null
    }
    return esRechazoCliente(c) ? "no_interesa" : null
  }
  return null
}

/**
 * ¿El cliente respondió POSITIVAMENTE a un toque de campaña? (Lalo 11-sep:
 * "el deal debería revivir siempre y cuando el cliente responda positivamente,
 * si no dejarlo como está y la nota de la campaña debe quedar asociada").
 *
 * Nace de dos casos reales de la campaña remk_300: un CONTESTADOR AUTOMÁTICO
 * revivió el deal de "comité agua potable las quemas", y el reloj de traspaso
 * revivió los deals perdidos de tres clientes que ya habían dicho que no. Un
 * "gracias" solo tampoco es una respuesta positiva: es cortesía.
 *
 * Devuelve "positiva" | "rechazo" | "autorespuesta" | "sin_respuesta".
 */
export function respuestaPositivaDeCampana(
  historial: Array<{ role: string; content?: string | null }>,
): "positiva" | "rechazo" | "autorespuesta" | "sin_respuesta" {
  const postura = posturaRechazoCliente(historial)
  if (postura === "no_interesa") return "rechazo"
  if (postura === "autorespuesta") return "autorespuesta"
  const ultimo = ultimoMensajeCliente(historial).trim()
  if (!ultimo) return "sin_respuesta"
  if (CORTESIA.test(ultimo) || SOLO_EMOJI.test(ultimo)) return "sin_respuesta"
  return "positiva"
}

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
