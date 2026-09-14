/**
 * EL TOQUE NO PUEDE MENTIR SOBRE EL TIEMPO (13-sep, caso +56932011618).
 *
 * La clienta escribió "analizaré la cotización y dentro de las 24 horas daré
 * una respuesta", Vicky contestó "Perfecto! Quedamos así entonces 😊" y a los
 * DOCE MINUTOS le salió "Camila, pasaron los días y no vi que hayas revisado
 * el link…", y a la hora "ese precio ya venció".
 *
 * El texto lo escribe el modelo, y el prompt lo empujaba: su primera línea
 * decía que el cliente "dejó de responder hace días". Con eso el modelo
 * afirmaba días aunque hubieran pasado minutos, y retiraba una oferta que
 * seguía viva. Dos arreglos: el prompt recibe el tiempo REAL, y este cinturón
 * determinista descarta el texto generado si igual afirma un tiempo o un
 * vencimiento que no ocurrió (el toque no se pierde: sale el texto fijo).
 */

// OJO TILDES: `\b` de JS no reconoce "ó" como carácter de palabra, así que
// /venci[óo]\b/ NUNCA matchea "venció" (la cicatriz del 10-sep en
// pago-declarado, otra vez). Se normaliza el texto antes de mirar y los
// patrones se escriben SIN tildes.
function sinTildes(t: string): string {
  return String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
}

/** Afirmaciones de tiempo transcurrido — falsas si pasó poco. */
const RE_TIEMPO_LARGO =
  /\b(pasaron|paso|han pasado|ha pasado)\s+(los\s+)?(dias?|semanas?|meses?|tiempo)\b|\bhace\s+(varios\s+)?(dias?|semanas?|meses?|tiempo|rato)\b|\bdias\s+(sin|que no)\b|\bultimos\s+dias\b/

/** Afirmaciones de que algo VENCIÓ o caducó. */
const RE_VENCIMIENTO =
  /\b(vencio|vencida?|vencidos?|vencidas?|caduco|caducad[oa]|expiro|expirad[oa]|ya no (esta |se )?(disponible|vigente)|dejo de (estar )?(vigente|disponible))\b/

/** Bajo esto, "pasaron los días" es simplemente falso. */
export const HORAS_PARA_HABLAR_DE_DIAS = 24

export type VeredictoTiempo = {
  ok: boolean
  motivo?: "tiempo_transcurrido" | "vencimiento"
  frase?: string
}

/**
 * ¿El texto generado afirma algo sobre el tiempo que los hechos no respaldan?
 *
 * @param minutosDesdeCliente minutos desde el último mensaje del cliente.
 *        `null` = no se pudo medir → no se juzga (fail-open: el cinturón no
 *        puede bloquear toques por no saber la hora).
 * @param ofertaVigente si hay una oferta viva (descuento con vigencia), decir
 *        que venció es falso aunque haya pasado tiempo.
 */
export function afirmaTiempoFalso(
  texto: string,
  minutosDesdeCliente: number | null,
  ofertaVigente = false,
): VeredictoTiempo {
  const t = sinTildes(texto)
  if (!t.trim()) return { ok: true }

  if (minutosDesdeCliente != null && minutosDesdeCliente < HORAS_PARA_HABLAR_DE_DIAS * 60) {
    const m = t.match(RE_TIEMPO_LARGO)
    if (m) return { ok: false, motivo: "tiempo_transcurrido", frase: m[0] }
  }
  // El vencimiento se juzga distinto: no depende de cuánto pasó sino de si la
  // oferta sigue viva. Con oferta vigente, decir que venció es mentir para
  // apurar — exactamente lo que hizo a la hora en el caso de Camila.
  if (ofertaVigente) {
    const m = t.match(RE_VENCIMIENTO)
    if (m) return { ok: false, motivo: "vencimiento", frase: m[0] }
  }
  return { ok: true }
}

/** Cómo se le dice al modelo cuánto pasó, en palabras que puede usar. */
export function descripcionTiempo(minutosDesdeCliente: number | null): string {
  if (minutosDesdeCliente == null) return "no se pudo medir cuánto tiempo pasó"
  const min = Math.max(0, Math.round(minutosDesdeCliente))
  if (min < 60) return `${min} minuto${min === 1 ? "" : "s"}`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} hora${h === 1 ? "" : "s"}`
  const d = Math.round(h / 24)
  return `${d} día${d === 1 ? "" : "s"}`
}
