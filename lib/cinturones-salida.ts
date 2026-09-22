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
  cinturon?: "precio_deformado" | "precio_sin_tool" | "pregunta_prohibida" | "actualizada_sin_tool" | "descuento_aplicado_sin_tool" | "descuento_ofrecido_sin_tool" | "link_formal_sin_tool" | "objecion_precio_sin_tool" | "correo_enviado_sin_tool" | "formal_no_coincide_sin_tool"
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
  /cotizaci[oó]n\s+(ya\s+)?((qued[oó]|est[aá]|sali[oó])\s+)?(actualizada|modificada|corregida)|actualic[eé]\s+(tu|la)\s+cotizaci[oó]n|te\s+(env[ií]o|mando|mand[eé]|acabo\s+de\s+mandar)\s+la\s+cotizaci[oó]n\s+actualizada|nueva\s+versi[oó]n\s+de\s+(tu|la)\s+cotizaci[oó]n|ya\s+(la\s+)?actualic[eé]/i

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
// OJO (4ª vez): `\b` de JS no reconoce la tilde — `apliqu[eé]\b` JAMÁS matchea
// "apliqué". Por eso el cierre de la palabra va con lookahead, no con \b.
export const ANUNCIA_DESCUENTO_APLICADO_RE =
  /\b(apliqu[eé]|aplicad[oa]s?|aplicamos)(?![a-záéíóú])[^.\n!]{0,60}\b(\d{1,2}\s*%|descuento|dcto)|\b(\d{1,2}\s*%|descuento)\b[^.\n!]{0,40}\b(aplicad[oa]s?|ya\s+(qued[oó]|est[aá]|tiene|va))|\b(ya\s+)?(tiene|qued[oó]|est[aá]|va|sali[oó])\s+(ya\s+)?(actualizada\s+)?(con\s+)?(el|un|tu|ese|este)\s+(\d{1,2}\s*%|descuento)|est[aá]\s+con\s+(ese|el|tu)\s+(\d{1,2}\s*%|descuento)/i

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

/**
 * DESCUENTO OFRECIDO SIN TOOL (21-sep noche, batería CO tras la escalera
 * colombiana): "Puedo ofrecerte un 10 % de descuento… quedaría en $172.620/mes
 * · Pago inicial $191.800" con CERO tools — el modelo calculó la rebaja él
 * mismo y se equivocó en el pago inicial (la Activación también baja). El
 * porcentaje y el precio rebajado los decide la tool (consultar_descuento_
 * referencial antes de la formal / consultar_siguiente_descuento después):
 * ofrecerlos de memoria es inventar un precio. Un % que YA salió en un turno
 * anterior de Vicky (lo repite, lo confirma) no se persigue.
 */
export const OFRECE_DESCUENTO_RE =
  /\b(\d{1,2})\s*%\s*(de\s+)?(descuento|dcto|rebaja)|\b(descuento|dcto|rebaja)\s+(de|del)\s+(\d{1,2})\s*%|\b(puedo|podr[ií]a|te)\s+(ofrecer(te)?|dejar(te)?|aplicar(te)?|dar(te)?)\s+(un\s+)?(\d{1,2})\s*%/i

const TOOLS_QUE_OFRECEN_DESCUENTO = new Set([
  "consultar_descuento_referencial",
  "consultar_siguiente_descuento",
  "aplicar_siguiente_descuento",
  "cotizar_referencial",
  "generar_link_cotizadora",
  "actualizar_cotizacion",
])

const FORZAR_TOOL_OFRECER_DESCUENTO =
  "\n\n# Instrucción de sistema (este turno)\n" +
  "Tu borrador anterior OFRECIÓ un porcentaje de descuento con un precio calculado por ti y NINGUNA tool " +
  "lo calculó en este turno. El % y el precio rebajado los decide la tool: llama AHORA " +
  "consultar_descuento_referencial (si todavía no hay cotización formal) o consultar_siguiente_descuento " +
  "(si ya la hay) y entrega SU mensajeParaProspecto tal cual. Si la tool dice que no hay más margen, dilo con franqueza."

const CONTENCION_OFRECER_DESCUENTO: Record<PaisCinturon, string> = {
  cl: "Te entiendo con el presupuesto. Antes de hablar de porcentajes, déjame revisar qué margen tengo para tu caso y te lo confirmo por acá con el número exacto, no necesitas hacer nada más 🙌",
  co: "Te entiendo con el presupuesto. Antes de hablar de porcentajes, déjame revisar qué margen tengo para tu caso y te lo confirmo por acá con el número exacto, no necesitas hacer nada más 🙌",
  mx: "Te entiendo con el presupuesto. Antes de hablar de porcentajes, déjame revisar qué margen tengo para tu caso y te lo confirmo por acá con el número exacto, no necesitas hacer nada más 🙌",
  pe: "Te entiendo con el presupuesto. Antes de hablar de porcentajes, déjame revisar qué margen tengo para tu caso y te lo confirmo por acá con el número exacto, no necesitas hacer nada más 🙌",
}

/** Porcentajes de descuento que YA aparecieron en turnos anteriores de Vicky. */
function porcentajesYaOfrecidos(historialAsistente: string[] | undefined): Set<number> {
  const out = new Set<number>()
  for (const t of historialAsistente || []) {
    for (const x of String(t || "").matchAll(/(\d{1,2})\s*%/g)) out.add(Number(x[1]))
  }
  return out
}

/**
 * LINK DE COTIZACIÓN FORMAL SIN TOOL (21-sep noche, E2E anualidad Perú): tras
 * un cotizar_referencial correcto el modelo respondió con el TEXTO DE ENTREGA
 * de la formal ("¡Lista tu cotización, Ana! 🎉 Revísala aquí:
 * https://cotizacion.geovictoria.com/q/ana-prueba") — un link INVENTADO a una
 * cotización que no existe, y sin el precio que la tool sí había calculado.
 * Regla: un link de cotización (/q/ o quote-acceptance) o la frase de entrega
 * solo pueden salir si una tool de emisión corrió en el turno, o si ese
 * mismo link ya se le envió antes al cliente (repetírselo es legítimo). Si en
 * el turno hubo cotizar_referencial, el texto bueno YA existe: sale su
 * mensajeParaProspecto sin reintento.
 */
export const LINK_COTIZACION_RE = /https?:\/\/[^\s)>"']*cotizacion\.geovictoria\.com\/(q\/|quote-acceptance)[^\s)>"']*/gi
export const FRASE_ENTREGA_FORMAL_RE = /lista\s+tu\s+cotizaci[oó]n|rev[ií]sala\s+aqu[ií]/i

export function linksFormalSinRespaldo(reply: string, historialAsistente: string[]): string[] {
  const enReply = Array.from(String(reply || "").matchAll(LINK_COTIZACION_RE)).map((m) => m[0])
  if (!enReply.length) return []
  const conocidos = new Set<string>()
  for (const h of historialAsistente || []) {
    for (const m of String(h || "").matchAll(LINK_COTIZACION_RE)) conocidos.add(m[0].replace(/[.,;:!?]+$/, ""))
  }
  return enReply.map((u) => u.replace(/[.,;:!?]+$/, "")).filter((u) => !conocidos.has(u))
}

const FORZAR_TOOL_EMISION =
  "\n\n# Instrucción de sistema (este turno)\n" +
  "Tu borrador anterior entregó un LINK de cotización o anunció 'lista tu cotización' sin que " +
  "ninguna tool de emisión (generar_link_cotizadora / actualizar_cotizacion / " +
  "aplicar_siguiente_descuento / anualizar_cotizacion) haya corrido en este turno. PROHIBIDO " +
  "inventar links o dar por emitida una cotización. Si ya tienes los datos del cierre, llama " +
  "AHORA generar_link_cotizadora y entrega SU mensajeParaProspecto tal cual; si te faltan " +
  "datos, entrega el precio que calculó la tool de este turno (si la hubo) y pide solo lo que falta."

const CONTENCION_EMISION: Record<PaisCinturon, string> = {
  cl: "Todavía no tengo emitida tu cotización formal — apenas la genere te llega el link por este mismo chat 🙌",
  co: "Todavía no tengo emitida tu cotización formal — apenas la genere te llega el link por este mismo chat 🙌",
  mx: "Todavía no tengo emitida tu cotización formal — apenas la genere te llega el link por este mismo chat 🙌",
  pe: "Todavía no tengo emitida tu cotización formal — apenas la genere te llega el link por este mismo chat 🙌",
}

/**
 * "TE LA ENVIÉ AL CORREO" SIN TOOL (22-sep, Lalo probando la línea +51: dio su
 * correo DESPUÉS de emitida la formal y Vicky respondió "Ya te envié la
 * cotización a egomez@… también" — la cotización quedó sin Email_Contacto y
 * con CERO correos en Zoho). En Chile la regla vivía solo en el prompt
 * (anti-teatro del 01-sep, caso METAL ORGÁNICO) y la descripción larga de la
 * tool; en PE/CO la descripción corta perdió justo esa frase. Acá se hace
 * cumplir para los cuatro países: afirmar que un correo SALIÓ exige que en el
 * turno haya corrido reenviar_cotizacion_correo (o una emisión, que manda su
 * propio correo). Preguntar "¿te la mando al correo?" no es afirmar.
 */
// Tildes sin \b (cicatriz repetida): fronteras con lookahead/lookbehind de letra.
export const AFIRMA_CORREO_ENVIADO_RE =
  /(?:ya\s+(?:te|le)\s+(?:la\s+|lo\s+)?(?:envi[eé]|mand[eé]|reenvi[eé])(?![a-záéíóú])[^.\n!?]{0,80}?(?:correo|e-?mail|casilla|bandeja|[\w.+-]+@[\w-]+\.[a-z]{2,})|(?<!que\s)(?<![a-záéíóú])(?:te|le)\s+(?:la\s+|lo\s+)?(?:envié|mandé|reenvié)(?![a-záéíóú])[^.\n!?]{0,80}?(?:correo|e-?mail|casilla|bandeja|[\w.+-]+@[\w-]+\.[a-z]{2,})|(?:ya\s+)?(?:sali[oó]|se\s+fue|qued[oó]\s+enviad[ao]|fue\s+enviad[ao]|est[aá]\s+enviad[ao])(?![a-záéíóú])[^.\n!?]{0,40}?(?:correo|e-?mail|casilla|bandeja)|(?:te|le)\s+(?:llega|llegar[aá]|lleg[oó])(?![a-záéíóú])[^.\n!?]{0,40}?(?:al|por|a\s+tu|en\s+tu)\s+(?:correo|e-?mail|casilla|bandeja))/i

const TOOLS_QUE_MANDAN_CORREO = new Set([
  "reenviar_cotizacion_correo",
  "generar_link_cotizadora",
  "actualizar_cotizacion",
  "aplicar_siguiente_descuento",
  "anualizar_cotizacion",
])

const FORZAR_TOOL_CORREO =
  "\n\n# Instrucción de sistema (este turno)\n" +
  "Tu borrador anterior AFIRMÓ que la cotización ya salió al correo del cliente y NINGUNA tool la envió en este turno: " +
  "ningún correo salió. La ÚNICA forma de que llegue a un correo es llamar reenviar_cotizacion_correo con " +
  "esCorreoDelCliente=true, destinatarioEmail = el correo que dio el cliente y quote_id = la cotización formal vigente. " +
  "Llámala AHORA y entrega SU mensajeParaProspecto tal cual. Si no puedes enviarla, dilo con franqueza: no la des por enviada."

const CONTENCION_CORREO: Record<PaisCinturon, string> = {
  cl: "Anoté tu correo, pero todavía no salió la cotización por esa vía — te la mando ahí en un momento. Mientras tanto la tienes en el link de este chat, donde puedes revisarla y aceptarla 🙌",
  co: "Anoté tu correo, pero todavía no salió la cotización por esa vía — te la mando ahí en un momento. Mientras tanto la tienes en el link de este chat, donde puedes revisarla y aceptarla 🙌",
  mx: "Anoté tu correo, pero todavía no salió la cotización por esa vía — te la mando ahí en un momento. Mientras tanto la tienes en el link de este chat, donde puedes revisarla y aceptarla 🙌",
  pe: "Anoté tu correo, pero todavía no salió la cotización por esa vía — te la mando ahí en un momento. Mientras tanto la tienes en el link de este chat, donde puedes revisarla y aceptarla 🙌",
}

/** ¿Ya hubo un envío por correo respaldado en turnos anteriores (el mensaje canónico de la tool lleva 📧)? */
function correoYaRespaldadoAntes(historialAsistente: string[] | undefined): boolean {
  return (historialAsistente || []).some((h) => /📧/.test(String(h || "")))
}

export type EntradaSalida = {
  reply: string
  toolCalls: readonly LlamadaTool[] | undefined
  /** Textos que Vicky YA le envió a este contacto (respaldan repetir un precio). */
  historialAsistente: string[]
  pais: PaisCinturon
  /** En la fase de onboarding no hay venta: estos cinturones no aplican. */
  enOnboarding?: boolean
  /** El mensaje del cliente en este turno (para juzgar la objeción de precio). */
  userMessage?: string
}

/**
 * OBJECIÓN DE PRECIO SIN TOOL (22-sep, batería CL vs PE, E2 "es muy caro,
 * ¿tienen descuento?"): Chile 3/3 llamaba la tool de descuento porque su
 * webhook fuerza un reintento; Perú 0/4 (pedía RUC y correo antes del precio,
 * repreguntaba la modalidad). La regla del núcleo ("una objeción = UNA llamada
 * a la tool de descuento") es global: acá se hace cumplir para todos.
 */
export const OBJECION_PRECIO_RE =
  /\b(car[oa]s?|car[ií]sim[oa]s?|descuento|dcto|rebaj[ae]s?|rebajar|m[aá]s barat[oa]|muy alto|precio alto|promoci[oó]n|no me alcanza|presupuesto|mucha plata|muy elevado)\b/i
const TOOLS_QUE_RESPONDEN_OBJECION = new Set([
  "consultar_descuento_referencial",
  "consultar_siguiente_descuento",
  "aplicar_siguiente_descuento",
  "generar_link_cotizadora",
  "actualizar_cotizacion",
  "anualizar_cotizacion",
  "derivar_a_soporte",
  "derivar_a_ejecutivo",
])
const FORZAR_TOOL_OBJECION =
  "\n\n# Instrucción de sistema (este turno)\n" +
  "El cliente acaba de OBJETAR EL PRECIO o pedir descuento, y tu borrador no llamó ninguna tool de descuento. " +
  "Regla del flujo: una objeción = UNA llamada a la tool de descuento en ESTE turno. Si aún no hay cotización formal, " +
  "llama consultar_descuento_referencial (si todavía no mostraste precio, primero cotizar_referencial con la dotación y el marcaje " +
  "que ya conoces y en el mismo turno la de descuento); si ya hay formal, consultar_siguiente_descuento. Copia su " +
  "`mensajeParaProspecto` TAL CUAL. PROHIBIDO pedir datos de cierre, repreguntar la modalidad o la operación antes de responder la objeción."

/**
 * LA FORMAL NO COINCIDE CON LO QUE ELIGIÓ (22-sep, caso Rodrigo COT ALICORP):
 * el cliente eligió "la 2" (solo app), la formal salió con reloj, mandó la
 * captura y Vicky respondió DOS veces "tu cotización formal tiene la opción 2,
 * puedes verificarlo" sin llamar ninguna tool — afirmando el contenido de un
 * documento que nunca leyó. Cuando el cliente dice que la cotización no es lo
 * que pidió, la única respuesta honesta es DEJARLA como la pidió
 * (actualizar_cotizacion en el mismo turno); afirmar lo que contiene sin
 * tocarla es teatro.
 */
export const RECLAMO_FORMAL_RE =
  /(me\s+est[aá]s?\s+cobrando|me\s+cobra(?:ste|ron)?|no\s+es\s+lo\s+que\s+(?:eleg[ií]|ped[ií]|dije|quer[ií]a|escog[ií])|te\s+dije\s+(?:la\s+)?(?:\d|opci[oó]n|primera|segunda|otra)|(?:eleg[ií]|escog[ií]|ped[ií])\s+la\s+(?:\d|primera|segunda|otra)|aparece\s+(?:otra|la\s+otra|con\s+reloj|el\s+reloj|otro\s+(?:precio|valor|monto))|no\s+coincide|(?:cotizaci[oó]n|link|pdf|precio)\s+(?:est[aá]|sali[oó]|qued[oó]|viene|vino)\s+(?:mal|equivocad[oa]|incorrect[oa]|err[oó]ne[oa]|con\s+reloj|con\s+otro)|est[aá]\s+(?:mal|equivocad[oa]|incorrect[oa])\s+(?:la\s+)?(?:cotizaci[oó]n|el\s+precio|el\s+monto|el\s+link))/i
const TOOLS_QUE_CORRIGEN_FORMAL = new Set([
  "actualizar_cotizacion",
  "generar_link_cotizadora",
  "aplicar_siguiente_descuento",
  "anualizar_cotizacion",
  "derivar_a_soporte",
  "derivar_a_ejecutivo",
])
const FORZAR_TOOL_CORREGIR_FORMAL =
  "\n\n# Instrucción de sistema (este turno)\n" +
  "El cliente dice que la COTIZACIÓN FORMAL NO COINCIDE con lo que eligió (otra opción, otro precio, un reloj que no pidió). " +
  "Tú NO has leído la cotización: PROHIBIDO afirmar qué contiene, decir que 'está correcta' o mandarlo a verificar el link. " +
  "Lo que corresponde es dejarla EXACTAMENTE como la pidió: llama actualizar_cotizacion en ESTE turno con la configuración que el cliente eligió " +
  "según el historial (dotación, con o sin reloj, ubicación), copia su `mensajeParaProspecto` TAL CUAL y agradécele el aviso. " +
  "Si no puedes reconstruir lo que eligió, pregúntale UNA cosa concreta en vez de discutir."
const CONTENCION_FORMAL_NO_COINCIDE: Record<PaisCinturon, string> = {
  cl: "Tienes razón en revisarlo — voy a dejar la cotización exactamente con la opción que elegiste y te la mando corregida en un momento 🙌",
  co: "Tienes razón en revisarlo — voy a dejar la cotización exactamente con la opción que elegiste y te la envío corregida en un momento 🙌",
  mx: "Tienes razón en revisarlo — voy a dejar la cotización exactamente con la opción que elegiste y te la mando corregida en un momento 🙌",
  pe: "Tienes razón en revisarlo — voy a dejar la cotización exactamente con la opción que elegiste y te la mando corregida en un momento 🙌",
}

/** ¿El cliente reclamó que la formal no es lo que eligió y el turno no la corrigió con una tool? */
export function reclamoFormalSinTool(userMessage: string | undefined, toolsOk: string[]): boolean {
  const u = String(userMessage || "").trim()
  if (!u || u.length > 300) return false
  if (!RECLAMO_FORMAL_RE.test(u)) return false
  return !toolsOk.some((t) => TOOLS_QUE_CORRIGEN_FORMAL.has(t))
}

/** ¿El cliente objetó el precio en este turno y el borrador no lo resolvió con una tool? */
export function objecionSinTool(userMessage: string | undefined, toolsOk: string[]): boolean {
  const u = String(userMessage || "").trim()
  if (!u || u.length > 200) return false
  if (!OBJECION_PRECIO_RE.test(u)) return false
  // "descuento" dentro de una pregunta de cierre ("¿el descuento aplica al reloj?") con formal
  // vigente también merece la tool: el criterio es simple a propósito.
  return !toolsOk.some((t) => TOOLS_QUE_RESPONDEN_OBJECION.has(t))
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

  const toolsOk = (e.toolCalls || []).filter((c) => c?.ok).map((c) => c.name)
  // (1b) La formal no coincide con lo que el cliente eligió y el turno no la
  // corrigió: reintento con la orden de actualizar_cotizacion; si insiste en
  // afirmar el contenido sin tocarla, contención honesta + aviso. Va ANTES del
  // precio sin tool: acá el precio que repite suele ser el que ya mostró, y el
  // daño es afirmar el contenido de un documento que no leyó.
  if (reclamoFormalSinTool(e.userMessage, toolsOk)) {
    return {
      accion: "reintento",
      directiva: FORZAR_TOOL_CORREGIR_FORMAL,
      siFallaReintento: "contener",
      contencion: CONTENCION_FORMAL_NO_COINCIDE[e.pais] || CONTENCION_FORMAL_NO_COINCIDE.cl,
      motivos: ["formal_no_coincide_sin_tool"],
      cinturon: "formal_no_coincide_sin_tool",
    }
  }

  // (2) Un monto que nadie calculó. Lo trae Chile desde el caso del tramo fijo
  // (un cliente bajó de 6 personas a 5 por una cifra que el modelo compuso).
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

  // (2b) Objeción de precio sin tool: reintento forzado; si el reintento
  // tampoco la llama, sale el borrador (una pregunta de más es menos grave que
  // dejar al cliente sin respuesta) y queda el aviso.
  if (objecionSinTool(e.userMessage, toolsOk)) {
    return {
      accion: "reintento",
      directiva: FORZAR_TOOL_OBJECION,
      siFallaReintento: "dejar_pasar",
      motivos: ["objeción de precio del cliente sin tool de descuento en el turno"],
      cinturon: "objecion_precio_sin_tool",
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

  // (3b') "Ya te la envié al correo" sin que ninguna tool la enviara. Reintento
  // con la orden de llamar reenviar_cotizacion_correo; si insiste, contención
  // honesta. Un envío respaldado en un turno anterior (📧 en el historial)
  // legitima repetirlo.
  if (
    AFIRMA_CORREO_ENVIADO_RE.test(reply) &&
    !toolsOk.some((n) => TOOLS_QUE_MANDAN_CORREO.has(n)) &&
    !correoYaRespaldadoAntes(e.historialAsistente)
  ) {
    return {
      accion: "reintento",
      directiva: FORZAR_TOOL_CORREO,
      siFallaReintento: "contener",
      contencion: CONTENCION_CORREO[e.pais] || CONTENCION_CORREO.cl,
      motivos: ["correo_enviado_sin_tool"],
      cinturon: "correo_enviado_sin_tool",
    }
  }

  // (3c) Porcentaje de descuento OFRECIDO sin que ninguna tool lo calculara
  // (batería CO 21-sep): el modelo inventa el % y el precio rebajado. Solo
  // porcentajes NUEVOS en la conversación — repetir uno ya ofrecido no es
  // inventar.
  if (!toolsOk.some((n) => TOOLS_QUE_OFRECEN_DESCUENTO.has(n))) {
    const m = OFRECE_DESCUENTO_RE.exec(reply)
    if (m) {
      const pct = Number((/(\d{1,2})\s*%/.exec(m[0]) || [])[1] || 0)
      if (pct > 0 && pct <= 40 && !porcentajesYaOfrecidos(e.historialAsistente).has(pct)) {
        return {
          accion: "reintento",
          directiva: FORZAR_TOOL_OFRECER_DESCUENTO,
          siFallaReintento: "contener",
          contencion: CONTENCION_OFRECER_DESCUENTO[e.pais] || CONTENCION_OFRECER_DESCUENTO.cl,
          motivos: ["descuento_ofrecido_sin_tool"],
          cinturon: "descuento_ofrecido_sin_tool",
        }
      }
    }
  }

  // (3d) Link de cotización formal o frase de entrega SIN tool de emisión
  // (va después de 3/3b/3c: si el texto además anuncia "actualizada" o un
  // descuento, ese cinturón es más específico y manda).
  // Con cotizar_referencial en el turno el texto bueno es el de la tool; sin
  // ella, reintento y contención honesta (un link inventado no "se deja pasar").

  if (!toolsOk.some((n) => TOOLS_QUE_ACTUALIZAN.has(n))) {
    const linksSinRespaldo = linksFormalSinRespaldo(reply, e.historialAsistente)
    const fraseEntrega = FRASE_ENTREGA_FORMAL_RE.test(reply)
    if (linksSinRespaldo.length || fraseEntrega) {
      const motivos = [...linksSinRespaldo.map((u) => `link_sin_tool:${u}`), ...(fraseEntrega ? ["frase_entrega_sin_tool"] : [])]
      if (canonico) {
        return { accion: "reemplazo", reply: canonico, motivos, cinturon: "link_formal_sin_tool" }
      }
      return {
        accion: "reintento",
        directiva: FORZAR_TOOL_EMISION,
        siFallaReintento: "contener",
        contencion: CONTENCION_EMISION[e.pais] || CONTENCION_EMISION.cl,
        motivos,
        cinturon: "link_formal_sin_tool",
      }
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
