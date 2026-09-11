/**
 * SEÑAL BLANDA del cliente — "te confirmo", "lo veo con mi jefe", "lo presento
 * a gerencia", "me tomaré más tiempo".
 *
 * No es un rechazo (eso lo cubre `posturaRechazoCliente`) ni una fecha de
 * retoma (eso lo cubre `clasificarSenalEspera`, que solo pausa a >3 días). Es
 * el "espérame" corto, y hasta hoy el sistema seguía hablando como si el
 * cliente no hubiera dicho nada.
 *
 * ORDEN DE LALO (11-sep): "lo que duele es cuando recibimos la señal pero
 * seguimos hablando como si el cliente no hubiera dicho nada, y eso es
 * torpeza — por ejemplo decir cómo te fue con el pago después de un 'lo
 * revisamos y te comento', se ve feo". O sea el arreglo NO es callarse: es
 * que el mensaje RECONOZCA lo que el cliente dijo. Medido en la auditoría de
 * insistencia del 11-sep: 45 de 85 casos con señal blanda recibieron después
 * un mensaje que la ignoraba (26 presentaciones de traspaso, 10 chequeos 9 h).
 *
 * Módulo PURO: solo texto, sin red.
 */

export type TipoSenalBlanda = "revision_interna" | "te_confirmo" | "mas_tiempo"

export type SenalBlanda = {
  tipo: TipoSenalBlanda
  /** Lo que escribió el cliente, recortado (para logs y notas internas). */
  cita: string
}

/** "Lo veo con mi jefe / lo presento a gerencia / lo estamos evaluando." */
const REVISION_INTERNA =
  /(lo (?:voy a |vamos a |tengo que )?(?:ver\w*|veo|vemos|revis\w*|consult\w*|coment\w*|present\w*|habl\w*|pregunt\w*)\s+(?:con|a)\s+(?:mi|el|la|los|las|nuestro|nuestra)?\s*(jefe|jefa|gerente|gerencia|direccion|directorio|socio|socia|equipo|contador|contadora|administracion|duena|dueno|jefatura)|lo (?:presento|presentare|enviare|envio|paso|pasare|mandare|mando)\s+(?:a|al|con)\s+(?:la\s+)?(gerencia|direccion|directorio|jefatura|mi jefe|mi jefa|mi socio|mi socia)|(?:lo\s+)?(?:estamos|estoy)\s+(?:evaluando|analizando|revisando|viendo)|(?:esta|queda)\s+en\s+revision|lo veremos internamente|reunion interna)/i

/** "Te confirmo / te comento / cualquier novedad te aviso." */
const TE_CONFIRMO =
  /(te\s+(?:confirmo|comento|aviso|cuento|respondo|escribo)|les\s+(?:confirmo|comento|aviso)|le\s+(?:confirmo|comento|aviso)|cualquier\s+novedad\s+(?:le|les|te)\s+(?:comento|aviso|confirmo)|(?:en cuanto|cuando)\s+(?:me\s+)?(?:respondan|confirmen|sepa|tenga\s+respuesta)\s+(?:le|les|te)\s+(?:aviso|comento|confirmo)|quedo\s+atento\s+y\s+(?:te|le)\s+(?:aviso|comento))/i

/** "Me tomaré más tiempo / necesito unos días." */
const MAS_TIEMPO =
  /(me\s+(?:tomare|voy a tomar|tomo)\s+(?:un poco\s+)?mas\s+tiempo|necesito\s+(?:unos|algunos)\s+dias|dame\s+(?:unos|algunos)\s+dias|lo veo\s+(?:la\s+)?(?:proxima semana|otra semana))/i

const sinTildes = (t: string) =>
  String(t || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")

/**
 * Lee los mensajes del CLIENTE de atrás hacia adelante (máx 4 con contenido) y
 * devuelve la primera señal blanda que encuentre. Los `[REGISTRO INTERNO]` no
 * cuentan: no los escribió el cliente.
 */
export function detectarSenalBlanda(
  historial: Array<{ role: string; content?: string | null }>,
): SenalBlanda | null {
  let vistos = 0
  for (let i = historial.length - 1; i >= 0 && vistos < 4; i--) {
    const m = historial[i]
    if (m.role !== "user") continue
    const crudo = String(m.content || "").trim()
    if (!crudo || crudo.startsWith("[REGISTRO INTERNO")) continue
    vistos++
    const t = sinTildes(crudo)
    const cita = crudo.slice(0, 160)
    if (MAS_TIEMPO.test(t)) return { tipo: "mas_tiempo", cita }
    if (REVISION_INTERNA.test(t)) return { tipo: "revision_interna", cita }
    if (TE_CONFIRMO.test(t)) return { tipo: "te_confirmo", cita }
  }
  return null
}

/**
 * Reconocimiento de UNA frase para abrir el mensaje proactivo. Sin "sé que",
 * sin "entiendo que" repetido: dice lo que el cliente quedó de hacer y le
 * saca la presión. Devuelve "" si no hay señal.
 */
export function reconocimientoSenalBlanda(senal: SenalBlanda | null): string {
  if (!senal) return ""
  if (senal.tipo === "revision_interna") return "Sé que lo estabas revisando internamente, así que sin apuro."
  if (senal.tipo === "mas_tiempo") return "Me dijiste que necesitabas más tiempo, así que sin apuro."
  return "Quedaste en comentarme, así que no te apuro."
}

/**
 * El mensaje proactivo, reconociendo la señal si la hay. `texto` es el mensaje
 * que ya se iba a enviar; el reconocimiento va ADELANTE y la pregunta original
 * queda igual — así el cliente ve que lo escuchamos y no pierde el hilo.
 */
export function conReconocimiento(texto: string, senal: SenalBlanda | null): string {
  const reco = reconocimientoSenalBlanda(senal)
  if (!reco) return texto
  return `${reco} ${String(texto || "").trim()}`.trim()
}
