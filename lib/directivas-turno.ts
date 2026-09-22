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

import { directivaRutSinCorreo, type TurnoHistorial } from "./rut-sin-correo.ts"

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

export function directivaMarcaje(message: string, zona = "comuna"): string {
  const zonaArt = zonaConArticulo(zona)
  const msgCorto = (message || "").trim()
  const eligeReloj =
    msgCorto.length <= 40 &&
    /\b(mixt[oa]s?|combinad[oa]s?|combinaci[oó]n|reloj(?:es)?|ambos|ambas|los dos|las dos)\b/i.test(msgCorto)
  const declaraCantidadOSedes = /\d|sucursal|sede|punto|local/i.test(msgCorto)
  return eligeReloj && !declaraCantidadOSedes ? `\n\n[DIRECTIVA DEL TURNO — obligatoria] El cliente acaba de elegir un marcaje que INCLUYE reloj (o dijo 'mixto'). PROHIBIDO preguntarle cuántos relojes o cuántos puntos necesita: ASUME 1 punto y 1 reloj y decláralo en tu mensaje. Si aún no sabes ${zonaArt} de ese punto, tu ÚNICA pregunta de este turno es ${zonaArt}; si ya la sabes, cotiza AHORA con cotizar_referencial (1 punto, autoInstalada: true) presentando el doble valor (con y sin reloj).` : ""
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
  return (
    directivaMarcaje(message, ficha.zona) +
    directivaConsultiva(history) +
    directivaRutSinCorreo(message, history, { documento: ficha.documento })
  )
}
