/**
 * DIRECTIVAS DETERMINISTAS POR TURNO — el mecanismo COMÚN (22-sep, orquestador
 * único, paso 3 del orden del 21-sep).
 *
 * Hasta hoy estas órdenes vivían INLINE en el webhook chileno y los demás
 * países no las tenían: con el MISMO prompt, Chile obedecía el flujo y Perú no,
 * porque lo que obliga al modelo es la orden al FINAL del prompt, en el
 * contexto inmediato del turno (lección del umbral 08-ago, del marcaje 13-ago,
 * del RUT sin correo 31-ago). Batería CL vs PE del 22-sep: E2 divergía 3/3 vs
 * 0/4 y la causa eran estas capas, no el prompt.
 *
 * Módulo PURO (sin red): Chile lo consume con `zona: "comuna"` y el texto es
 * byte a byte el que tenía (tests/directivas-turno.test.ts lo fija).
 */

import { directivaRutSinCorreo, directivaNombreSinCorreo, type TurnoHistorial } from "./rut-sin-correo.ts"

export type Turno = TurnoHistorial

/** Pregunta consultiva ya hecha por Vicky (texto literal de Eduardo 14-ago). */
export const RE_PREGUNTA_OPERACION =
  /(sobre tu operaci[oó]n|c[oó]mo trabaja tu equipo|a qu[eé] se dedican|una sola oficina o varias|cu[eé]ntame un poco (m[aá]s )?de tu operaci[oó]n)/i
/** Menú de modalidades ya mostrado. */
export const RE_MENU_MARCAJE = /formas m[aá]s usadas para marcar|te acomoda m[aá]s para tu operaci[oó]n/i

/**
 * Directiva de la ETAPA CONSULTIVA (Eduardo 14-ago, caso Rodrigo): Vicky ya
 * preguntó por la operación y el cliente respondió → prohibido repreguntar;
 * toca parafrasear y mostrar el menú.
 */
export function directivaConsultiva(history: Turno[]): string {
  const yaPregunto = (history || []).some(
    (h) => h.role === "assistant" && RE_PREGUNTA_OPERACION.test(String(h.content || "")),
  )
  const yaMostroMenu = (history || []).some(
    (h) => h.role === "assistant" && RE_MENU_MARCAJE.test(String(h.content || "")),
  )
  return yaPregunto && !yaMostroMenu ? "\n\n[DIRECTIVA DEL TURNO — obligatoria] YA hiciste la pregunta consultiva sobre la operación y el cliente acaba de responderla. PROHIBIDO volver a preguntar por su operación, su rubro o cómo trabaja su equipo (aunque su respuesta te parezca corta o incompleta): con lo que dijo, PARAFRASEA en una frase y presenta AHORA el menú de modalidades de marcaje que calzan con su caso, cerrando con la pregunta de cuál le acomoda. Si te falta algún dato para cotizar, pídelo DENTRO de ese mismo mensaje, nunca en un turno aparte." : ""
}

/**
 * Directiva COTIZA YA (batería MX vs CL 26-sep): el cliente ya dijo CUÁNTAS
 * personas son y CÓMO quieren marcar, y todavía no vio precio. La regla del
 * núcleo ("si ya tiene dotación + marcaje, COTIZA sin preguntar") no bastaba:
 * en Chile, "somos 6 y queremos solo la app" recibió la pregunta sobre la
 * operación CUATRO veces, aun después de que el cliente dio su RUT y su correo;
 * y "somos 8, queremos la app, ¿cuánto cuesta?" recibió "¿cuál es el nombre de
 * tu empresa?" (prohibido: sale del padrón). Solo para dotaciones que Vicky
 * cotiza (1-20); sobre eso manda el guion del umbral.
 */
const RE_PRECIO_MOSTRADO =
  /(\+\s*(IVA|IGV)\s+al\s+mes|total mensual|resumen mensual|uf\s*\+\s*iva|💰)/i
const RE_MARCAJE_ELEGIDO =
  /\b(app|aplicaci[oó]n|celular(es)?|reloj(es)?|checador(es)?|biom[eé]tric[oa]|huellero|ambos|ambas|mixt[oa]|los dos|las dos)\b/i

/** Dotación declarada por el cliente en un texto (1..500) o null. */
export function dotacionEnTexto(texto: string): number | null {
  const t = String(texto || "").toLowerCase()
  const m =
    /\bsomos\s+(\d{1,3})\b/.exec(t) ||
    /\b(\d{1,3})\s+(personas|trabajadores|colaboradores|empleados|usuarios|funcionarios)\b/.exec(t)
  if (!m) return null
  const n = Number(m[1])
  return n >= 1 && n <= 500 ? n : null
}

export function directivaCotizarYa(message: string, history: Turno[], umbral = 20): string {
  const deCliente = [...(history || []).filter((h) => h.role === "user").map((h) => String(h.content || "")), String(message || "")]
    .filter((t) => !t.startsWith("[REGISTRO INTERNO"))
  const yaPrecio = (history || []).some((h) => h.role === "assistant" && RE_PRECIO_MOSTRADO.test(String(h.content || "")))
  if (yaPrecio) return ""
  let dotacion: number | null = null
  for (const t of deCliente) dotacion = dotacionEnTexto(t) ?? dotacion
  const marcaje = deCliente.some((t) => RE_MARCAJE_ELEGIDO.test(t))
  if (!dotacion || dotacion > umbral || !marcaje) return ""
  // Lalo 26-sep: la pregunta abierta sirve "para que el cliente se explaye"
  // aunque ya haya dado los empleados → va UNA vez, DESPUÉS del precio.
  const yaPregunto = (history || []).some(
    (h) => h.role === "assistant" && RE_PREGUNTA_OPERACION.test(String(h.content || "")),
  )
  return (
    "\n\n[DIRECTIVA DEL TURNO — obligatoria] El cliente YA te dijo cuántas personas son (" +
    dotacion +
    ") y cómo quieren marcar: cotiza AHORA con cotizar_referencial y muéstrale el valor en este mismo mensaje. " +
    "PROHIBIDO preguntar el nombre de su empresa (sale de su documento). " +
    (yaPregunto
      ? "Ya le preguntaste por su operación: PROHIBIDO repetir esa pregunta. "
      : "Después del precio, al final del MISMO mensaje, deja UNA vez la pregunta abierta sobre su operación (a qué se dedican y cómo trabaja su equipo) como invitación a contarte más — nunca antes del precio. ") +
    "Si eligió reloj y todavía no sabes dónde queda el punto, esa ubicación es la ÚNICA pregunta previa permitida."
  )
}

/**
 * Directiva del MARCAJE (biblia 12-ago; caso "Mixto" 13-ago): eligió reloj o
 * mixto en una respuesta corta sin cantidades ni sedes → 1 punto y 1 reloj
 * asumidos, la única pregunta permitida es la ubicación (comuna/distrito/ciudad
 * según el país).
 */
/** Artículo de la unidad geográfica ("la comuna", "el distrito", "la ciudad"). */
function zonaConArticulo(zona: string): string {
  const z = String(zona || "comuna").trim().toLowerCase()
  return /^(distrito|municipio|barrio|departamento)$/.test(z) ? `el ${z}` : `la ${z}`
}

/**
 * Ubicación que el cliente YA dijo en el mismo mensaje en que eligió reloj
 * (E2E 24-sep, CL/CO/MX: "Quiero la app y un reloj, estamos en Providencia" →
 * "¿En qué comuna estará el reloj?"). Devuelve la frase textual o "".
 */
export function ubicacionEnMensaje(message: string): string {
  const m = String(message || "")
  const eligeReloj = /\b(reloj(es)?|equipos?\b|biom[eé]tric[oa]|checador(es)?|ambos|ambas|mixt[oa]|los dos|las dos)/i.test(m)
  if (!eligeReloj) return ""
  const r =
    /\b(?:estamos|estoy|quedamos|queda|est[aá]|somos de|la oficina (?:est[aá]|queda))\s+(?:ubicad[oa]s?\s+)?en\s+(?:la\s+)?(?:comuna|ciudad|distrito)?\s*(?:de\s+)?([^\s,.;!?]+(?:\s+[^\s,.;!?]+){0,2})/i.exec(m) ||
    /\b(?:comuna|ciudad|distrito|municipio)\s+de\s+([^\s,.;!?]+(?:\s+[^\s,.;!?]+){0,2})/i.exec(m) ||
    /\ben\s+([A-ZÁÉÍÓÚÑ][\wáéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][\wáéíóúñ]+){0,2})/.exec(m)
  return r ? r[0].trim() : ""
}

export function directivaMarcaje(message: string, zona = "comuna"): string {
  const zonaArt = zonaConArticulo(zona)
  const ubicacion = ubicacionEnMensaje(message)
  if (ubicacion) {
    return `\n\n[DIRECTIVA DEL TURNO — obligatoria] El cliente eligió un marcaje que incluye reloj Y en el MISMO mensaje dijo dónde está: "${ubicacion}". Esa ES ${zonaArt} del punto (1 punto, 1 reloj). PROHIBIDO volver a preguntar ${zonaArt}: cotiza AHORA con cotizar_referencial (usa como evidenciaUbicacion la frase textual del cliente) y presenta el doble valor (con y sin reloj).`
  }
  const msgCorto = (message || "").trim()
  const eligeReloj =
    msgCorto.length <= 40 &&
    /\b(mixt[oa]s?|combinad[oa]s?|combinaci[oó]n|reloj(?:es)?|ambos|ambas|los dos|las dos)\b/i.test(msgCorto)
  const declaraCantidadOSedes = /\d|sucursal|sede|punto|local/i.test(msgCorto)
  return eligeReloj && !declaraCantidadOSedes ? `\n\n[DIRECTIVA DEL TURNO — obligatoria] El cliente acaba de elegir un marcaje que INCLUYE reloj (o dijo 'mixto'). PROHIBIDO preguntarle cuántos relojes o cuántos puntos necesita: ASUME 1 punto y 1 reloj y decláralo en tu mensaje. Si aún no sabes ${zonaArt} de ese punto, tu ÚNICA pregunta de este turno es ${zonaArt}; si ya la sabes, cotiza AHORA con cotizar_referencial (1 punto, autoInstalada: true) presentando el doble valor (con y sin reloj).` : ""
}

/**
 * DATOS QUE EL CLIENTE YA DIO (Lalo 27-sep, conversaciones reales de Perú):
 * a World Motors le pidió "los distritos exactos" que ya había escrito (Los
 * Olivos y Carabayllo); a Ana le volvió a preguntar cómo marcarían después de
 * que eligió reloj tres veces. Busca en los mensajes ANTERIORES del cliente
 * (no en el actual) su elección de marcaje y la ubicación que dio, y los
 * devuelve como hechos que no se vuelven a pedir.
 */
const RE_ELIGE_MARCAJE =
  /\b(reloj(es)?|huellero(s)?|biom[eé]tric[oa]s?|checador(es)?|app|aplicaci[oó]n|celular(es)?|ambos|ambas|mixt[oa]|los dos|las dos|solo (el )?equipo)\b/i

function ubicacionEnTexto(m: string): string {
  const r =
    /\b(?:estamos|estoy|quedamos|queda|est[aá]n?|somos de|ubicad[oa]s?)\s+(?:ubicad[oa]s?\s+)?en\s+(?:la\s+)?(?:comuna|ciudad|distrito)?\s*(?:de\s+)?([^\s,.;!?]+(?:\s+[^\s,.;!?]+){0,2})/i.exec(m) ||
    /\b(?:comuna|ciudad|distrito|municipio)\s+de\s+([^\s,.;!?]+(?:\s+[^\s,.;!?]+){0,2})/i.exec(m) ||
    /\b(?:sedes?|locales?|sucursal(?:es)?|oficinas?)\b[^.\n]{0,30}\(([^)]{3,60})\)/i.exec(m) ||
    /\ben\s+([A-ZÁÉÍÓÚÑ][\wáéíóúñ]+(?:\s+(?:de\s+)?[A-ZÁÉÍÓÚÑ][\wáéíóúñ]+){0,2})/.exec(m)
  return r ? r[0].trim() : ""
}

export function directivaDatosYaDichos(message: string, history: Turno[], zona = "comuna"): string {
  const previos = (history || [])
    .filter((t) => t.role === "user")
    .map((t) => String(t.content || "").trim())
    .filter((c) => c && !c.startsWith("[El cliente envió") && !/\?\s*$/.test(c))
  if (!previos.length) return ""
  let marcaje = ""
  let ubicacion = ""
  for (let i = previos.length - 1; i >= 0; i--) {
    const c = previos[i]
    if (!marcaje && c.length <= 160 && RE_ELIGE_MARCAJE.test(c)) marcaje = c.replace(/\s+/g, " ").slice(0, 120)
    if (!ubicacion) ubicacion = ubicacionEnTexto(c)
    if (marcaje && ubicacion) break
  }
  const hechos = [
    marcaje ? `cómo quiere marcar: «${marcaje}»` : "",
    ubicacion ? `dónde está (${zonaConArticulo(zona)} o sedes): «${ubicacion}»` : "",
  ].filter(Boolean)
  if (!hechos.length) return ""
  return `\n\n[DATOS QUE EL CLIENTE YA TE DIO — obligatoria] En mensajes anteriores ya te dijo ${hechos.join(" y ")}. PROHIBIDO volver a preguntárselo (ni con otras palabras, ni "para confirmar"): úsalo tal cual. Si el mensaje de ahora lo cambia, manda el mensaje de ahora.`
}

/** Reenganche: primera respuesta del cliente a un toque de reactivación. */
export const CONTEXTO_REENGANCHE =
  "[CONTEXTO — REENGANCHE ACTIVO] Tú (Vicky) reabriste esta conversación con un toque de " +
  "reactivación: le ofreciste al cliente un precio especial por tiempo limitado, y este mensaje " +
  "es su respuesta a ese toque. Aplica la regla 'REENGANCHE POR OFERTA': si el cliente todavía " +
  "NO está en el descuento máximo del plan, ofrécele el máximo de forma proactiva con la tool de " +
  "descuento que corresponda; si YA estaba en el máximo, recuérdale que ese precio caduca pronto. " +
  "ADEMÁS, si el precio que vio llevaba RELOJ control (arriendo), acompaña la oferta con la " +
  "alternativa más económica sin reloj usando los marcajes sin costo adicional (la app: cada persona marca " +
  "desde su propio celular o todo el equipo desde el celular del supervisor): cotízala con " +
  "cotizar_referencial sin hardware y muestra ambos caminos para que elija. " +
  "En todos los casos transmite urgencia (la oferta tiene caducidad). No inventes cifras: usa solo " +
  "los textos que devuelven las tools.\n\n"

export type FichaTurno = {
  /** Unidad geográfica de la ubicación del reloj: comuna (CL), distrito (PE), ciudad (CO/MX). */
  zona: string
  /** Documento tributario de la empresa que gatilla "llegó el documento, emite". */
  documento: "RUT" | "RUC" | "NIT" | "RFC"
}

/**
 * Las directivas del turno que Chile ya aplicaba, en el MISMO orden en que su
 * webhook las concatena (marcaje → consultiva → RUT sin correo). Los demás
 * países pegan este bloque al final del system prompt; Chile sigue armando el
 * suyo con las funciones sueltas (identidad byte a byte).
 */
export function directivasDeTurno(message: string, history: Turno[], ficha: FichaTurno): string {
  // "Cotiza ya" manda sobre la consultiva: con dotación + marcaje no hay menú que mostrar.
  const cotizarYa = directivaCotizarYa(message, history)
  return (
    directivaMarcaje(message, ficha.zona) +
    directivaDatosYaDichos(message, history, ficha.zona) +
    (cotizarYa || directivaConsultiva(history)) +
    directivaRutSinCorreo(message, history, { documento: ficha.documento }) +
    (ficha.documento === "RFC" ? directivaNombreSinCorreo(message, history) : "")
  )
}
