/**
 * LOS CINTURONES DE CHILE, EN LOS CUATRO PAÍSES (21-sep, orden de Lalo: "los
 * cinturones de Chile también hay que usarlos en los países" · "Chile es el
 * modelo a seguir para el comportamiento").
 *
 * EL HALLAZGO QUE LO MOTIVA: el inventario de imports de los cuatro webhooks
 * mostró que `precio-sin-tool` —el cinturón que impide afirmar un precio que
 * ninguna tool calculó— corría SOLO en Chile. En Perú, Colombia y México nada
 * frenaba un precio inventado, y el mismo día vimos al modelo reescribir el
 * mensaje de la tool en la línea peruana.
 *
 * POR QUÉ UN MÓDULO Y NO TRES COPIAS: un cinturón copiado en cuatro webhooks
 * se desalinea igual que un prompt copiado — es la misma enfermedad que nos
 * dejó a Colombia y México en la generación de julio. Lo que vive en UN módulo
 * compartido no puede quedar desalineado: es el mismo código. Los cuatro
 * webhooks llaman `revisarSalida` en un punto y ejecutan su veredicto.
 *
 * QUÉ NO VA ACÁ: los cinturones que dependen del ESTADO del contacto (pago
 * declarado, casuística, cliente existente, soporte inventado) siguen en su
 * módulo y se cablean aparte — este archivo es solo lo que se juzga mirando el
 * TEXTO SALIENTE del turno.
 *
 * PURO: sin red, sin Supabase. El reintento lo ejecuta el webhook, que es el
 * único que conoce su propio system prompt.
 */

import { chequearPreciosDelReply } from "./precio-sin-tool.ts"
import { mensajeCanonicoDe, precioDeformado, type LlamadaTool } from "./precio-deformado.ts"
import { preguntasProhibidasEn, directivaSinPreguntasProhibidas } from "./pregunta-prohibida.ts"

export type PaisCinturon = "cl" | "co" | "mx" | "pe"

export type Veredicto = {
  /** ok = el borrador sale tal cual. */
  accion: "ok" | "reemplazo" | "reintento"
  /** Con `reemplazo`: el texto que debe salir (determinista, sin reintento). */
  reply?: string
  /** Con `reintento`: la instrucción de sistema que se suma al prompt. */
  directiva?: string
  /** Qué hacer si el reintento vuelve igual de mal. */
  siFallaReintento?: "contener" | "dejar_pasar"
  /** Texto de contención (solo cuando siFallaReintento = "contener"). */
  contencion?: string
  /** Para el log y el aviso interno. */
  motivos: string[]
  /** Identificador del cinturón que disparó, para medir cuál actúa más. */
  cinturon?: "precio_deformado" | "precio_sin_tool" | "pregunta_prohibida" | "actualizada_sin_tool" | "descuento_aplicado_sin_tool"
}

const OK: Veredicto = { accion: "ok", motivos: [] }

/**
 * Contención cuando ni el reintento consigue un precio con respaldo. Un precio
 * equivocado a alguien que está por pagar es peor que una demora (criterio del
 * cinturón de URLs, 03-sep).
 */
const CONTENCION: Record<PaisCinturon, string> = {
  cl: "Déjame confirmarte el valor exacto con el sistema para no darte una cifra equivocada — te lo digo en un momento 🙌",
  co: "Déjame confirmarte el valor exacto con el sistema para no darte una cifra equivocada — te cuento en un momento 🙌",
  mx: "Déjame confirmarte el valor exacto con el sistema para no darte una cifra equivocada — te digo en un momento 🙌",
  pe: "Déjame confirmarte el valor exacto con el sistema para no darte una cifra equivocada — te digo en un momento 🙌",
}

const FORZAR_TOOL_PRECIO =
  "\n\n# Instrucción de sistema (este turno)\n" +
  "Tu borrador anterior AFIRMÓ un precio que ninguna tool calculó en este turno y que " +
  "tú nunca le habías dicho a este cliente. PROHIBIDO componer, estimar o extrapolar " +
  "precios: el motor es la única fuente. Si el cliente pregunta por un valor nuevo " +
  "(otra dotación, otra configuración), llama AHORA la tool que corresponde y entrega su " +
  "cifra tal cual. Si el precio no cambió, dilo sin inventar una cifra nueva."

/**
 * "COTIZACIÓN ACTUALIZADA" SIN TOOL (21-sep, caso Lalo en la línea +51 — y
 * antes Guillermo/Genesys COT956 en Chile, 27-ago): el modelo anuncia "ya
 * actualicé tu cotización" o "te la envío actualizada" sin que ninguna tool
 * de emisión haya corrido en el turno, y el cliente queda con el link viejo
 * creyendo que es el nuevo. En Chile vivía SOLO en su webhook; acá juzga a
 * los cuatro países. El regex es el chileno tal cual.
 */
export const ANUNCIA_ACTUALIZADA_RE =
  /cotizaci[oó]n\s+(actualizada|modificada|corregida)|actualic[eé]\s+(tu|la)\s+cotizaci[oó]n|te\s+(env[ií]o|mando|mand[eé]|acabo\s+de\s+mandar)\s+la\s+cotizaci[oó]n\s+actualizada|nueva\s+versi[oó]n\s+de\s+(tu|la)\s+cotizaci[oó]n|ya\s+(la\s+)?actualic[eé]/i

const TOOLS_QUE_ACTUALIZAN = new Set([
  "actualizar_cotizacion",
  "generar_link_cotizadora",
  "aplicar_siguiente_descuento",
  "anualizar_cotizacion",
])

const FORZAR_TOOL_ACTUALIZAR =
  "\n\n# Instrucción de sistema (este turno)\n" +
  "Tu borrador anterior ANUNCIÓ una cotización actualizada/nueva versión que NINGUNA tool " +
  "generó en este turno. Prohibido anunciar cambios que no ocurrieron. Si el cliente pidió " +
  "un cambio en su cotización formal, llama AHORA actualizar_cotizacion (o " +
  "aplicar_siguiente_descuento si fue por precio) y entrega SU mensajeParaProspecto tal cual. " +
  "Si no puedes actualizarla, dilo con franqueza: no la des por actualizada."

const CONTENCION_ACTUALIZADA: Record<PaisCinturon, string> = {
  cl: "Aún no tengo lista la versión actualizada de tu cotización — la estoy generando y te la mando por este mismo chat en un momento, no necesitas confirmarme nada más 🙌",
  co: "Aún no tengo lista la versión actualizada de tu cotización — la estoy generando y te la mando por este mismo chat en un momento, no necesitas confirmarme nada más 🙌",
  mx: "Aún no tengo lista la versión actualizada de tu cotización — la estoy generando y te la mando por este mismo chat en un momento, no necesitas confirmarme nada más 🙌",
  pe: "Aún no tengo lista la versión actualizada de tu cotización — la estoy generando y te la mando por este mismo chat en un momento, no necesitas confirmarme nada más 🙌",
}

/**
 * "DESCUENTO APLICADO" SIN TOOL (21-sep noche, E2E Perú en sitio): el cliente
 * dijo "acepto el 10 %" y el modelo respondió "tu cotización ya quedó con el
 * 10 % aplicado, en el mismo link…" con CERO tools — el link seguía a precio
 * de lista. La regex de "actualizada" no lo atrapaba porque el texto no dice
 * "actualizada", dice "aplicado". El descuento se comitea SOLO con
 * aplicar_siguiente_descuento (o emitiendo con escalón); anunciarlo sin eso es
 * prometer un precio que la página no muestra.
 */
export const ANUNCIA_DESCUENTO_APLICADO_RE =
  /\b(ya\s+)?(tiene|qued[oó]|est[aá]|va|sali[oó]|se\s+fue)\s+(ya\s+)?(con\s+)?(el|un|tu|ese|este)\s+(\d{1,2}\s*%(\s+de\s+descuento)?|descuento)\s+(ya\s+)?(aplicad|incluid|list[oa]\b|actualizad)|(ya\s+)?est[aá]\s+con\s+(ese|el|tu)\s+(\d{1,2}\s*%|descuento)|te\s+apliqu[eé]\s+(el|un)\s+\d{1,2}\s*%|descuento\s+(ya\s+)?(qued[oó]\s+)?aplicad[oa]|(ya\s+)?(le\s+)?apliqu[eé]\s+(el|tu)\s+descuento/i

const TOOLS_QUE_APLICAN_DESCUENTO = new Set(["aplicar_siguiente_descuento", "generar_link_cotizadora", "actualizar_cotizacion"])

const FORZAR_TOOL_DESCUENTO =
  "\n\n# Instrucción de sistema (este turno)\n" +
  "Tu borrador anterior AFIRMÓ que el descuento ya quedó aplicado en la cotización y NINGUNA tool " +
  "lo aplicó en este turno: el link sigue a precio de lista. Si el cliente aceptó el descuento, " +
  "llama AHORA aplicar_siguiente_descuento (con pct_ofrecido = el % que le ofreciste) y entrega " +
  "SU mensajeParaProspecto tal cual. Si no puedes aplicarlo, dilo con franqueza: no lo des por aplicado."

const CONTENCION_DESCUENTO: Record<PaisCinturon, string> = {
  cl: "Todavía no dejé aplicado el descuento en tu cotización — lo hago ahora mismo y te confirmo por acá en un momento, no necesitas hacer nada más 🙌",
  co: "Todavía no dejé aplicado el descuento en tu cotización — lo hago ahora mismo y te confirmo por acá en un momento, no necesitas hacer nada más 🙌",
  mx: "Todavía no dejé aplicado el descuento en tu cotización — lo hago ahora mismo y te confirmo por acá en un momento, no necesitas hacer nada más 🙌",
  pe: "Todavía no dejé aplicado el descuento en tu cotización — lo hago ahora mismo y te confirmo por acá en un momento, no necesitas hacer nada más 🙌",
}

export type EntradaSalida = {
  reply: string
  toolCalls: readonly LlamadaTool[] | undefined
  /** Textos que Vicky YA le envió a este contacto (respaldan repetir un precio). */
  historialAsistente: string[]
  pais: PaisCinturon
  /** En la fase de onboarding no hay venta: estos cinturones no aplican. */
  enOnboarding?: boolean
}

/**
 * Un solo veredicto, por prioridad de daño: primero el precio deformado (que
 * se arregla sin reintento porque el texto bueno ya existe), después el precio
 * sin respaldo, y al final las preguntas que el flujo retiró.
 */
export function revisarSalida(e: EntradaSalida): Veredicto {
  const reply = String(e.reply || "")
  if (!reply.trim() || e.enOnboarding) return OK

  // (1) La tool escribió el mensaje y el modelo lo deformó. No hace falta
  // reintento: el texto correcto es el de la tool.
  const canonico = mensajeCanonicoDe(e.toolCalls)
  if (canonico) {
    const d = precioDeformado(reply, canonico)
    if (d.deformado) {
      return {
        accion: "reemplazo",
        reply: canonico,
        motivos: d.motivos,
        cinturon: "precio_deformado",
      }
    }
  }

  // (2) Un monto que nadie calculó. Lo trae Chile desde el caso del tramo fijo
  // (un cliente bajó de 6 personas a 5 por una cifra que el modelo compuso).
  const toolsOk = (e.toolCalls || []).filter((c) => c?.ok).map((c) => c.name)
  const cp = chequearPreciosDelReply(reply, toolsOk, e.historialAsistente)
  if (cp.hayInventado) {
    return {
      accion: "reintento",
      directiva: FORZAR_TOOL_PRECIO,
      siFallaReintento: "contener",
      contencion: CONTENCION[e.pais] || CONTENCION.cl,
      motivos: cp.inventados.map(String),
      cinturon: "precio_sin_tool",
    }
  }

  // (3) "Actualizada" sin que nada se haya actualizado. Reintento con la
  // orden de llamar la tool; si vuelve igual, contención honesta — dejar
  // pasar sería entregarle al cliente el link viejo como nuevo.
  if (ANUNCIA_ACTUALIZADA_RE.test(reply) && !toolsOk.some((n) => TOOLS_QUE_ACTUALIZAN.has(n))) {
    return {
      accion: "reintento",
      directiva: FORZAR_TOOL_ACTUALIZAR,
      siFallaReintento: "contener",
      contencion: CONTENCION_ACTUALIZADA[e.pais] || CONTENCION_ACTUALIZADA.cl,
      motivos: ["actualizada_sin_tool"],
      cinturon: "actualizada_sin_tool",
    }
  }

  // (3b) "Descuento aplicado" sin que nadie lo aplicara: mismo daño que (3)
  // con otro verbo. Reintento con la orden; si insiste, contención honesta.
  if (ANUNCIA_DESCUENTO_APLICADO_RE.test(reply) && !toolsOk.some((n) => TOOLS_QUE_APLICAN_DESCUENTO.has(n))) {
    return {
      accion: "reintento",
      directiva: FORZAR_TOOL_DESCUENTO,
      siFallaReintento: "contener",
      contencion: CONTENCION_DESCUENTO[e.pais] || CONTENCION_DESCUENTO.cl,
      motivos: ["descuento_aplicado_sin_tool"],
      cinturon: "descuento_aplicado_sin_tool",
    }
  }

  // (4) Preguntas que el flujo chileno retiró. Si el reintento tampoco las
  // saca, el mensaje original SALE: dejar al cliente sin respuesta por una
  // pregunta de más es peor que la pregunta de más. Queda el aviso para medir.
  const pp = preguntasProhibidasEn(reply)
  if (pp.length) {
    return {
      accion: "reintento",
      directiva: directivaSinPreguntasProhibidas(pp),
      siFallaReintento: "dejar_pasar",
      motivos: pp.map((h) => h.id),
      cinturon: "pregunta_prohibida",
    }
  }

  return OK
}

/** ¿El reintento quedó bien? Se re-evalúa con el MISMO juez. */
export function reintentoQuedoBien(e: EntradaSalida): boolean {
  return revisarSalida(e).accion === "ok"
}
