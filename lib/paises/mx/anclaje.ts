/**
 * Anclaje temporal + bloque del teléfono de México. PURO (imports .ts):
 * lo consumen el prompt MX clásico y el prompt desde el núcleo, y lo cargan
 * los tests con node --test.
 */
import { calendarioProximosDias } from "../../calendar.ts"
import { fichaOperativa } from "../ficha-operativa.ts"

const TZ_MX_FICHA = fichaOperativa("mx").tz

export function anclajeTemporalMX(): string {
  const now = new Date()
  const fechaLegible = now.toLocaleString("es-MX", {
    timeZone: TZ_MX_FICHA,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    hour12: false,
  })
  const isoHora = now.toISOString().slice(0, 13) + ":00:00Z"
  return `# Anclaje temporal (CRÍTICO para reuniones y seguimientos)

HOY ES: ${fechaLegible} hrs aprox. (México, ${TZ_MX_FICHA}, UTC-6)
FECHA ISO UTC ACTUAL (aprox.): ${isoHora}
CALENDARIO PRÓXIMOS DÍAS (día de la semana REAL de cada fecha — úsalo TAL CUAL, nunca calcules el día tú): ${calendarioProximosDias(TZ_MX_FICHA)}

Cuando el cliente proponga un día relativo ("mañana", "el martes", "la próxima semana") — para una reunión o para un seguimiento (programar_seguimiento) — interprétalo con base en el HOY indicado arriba, NO con tu conocimiento de entrenamiento. Usa siempre el AÑO ACTUAL (${now.getFullYear()}). Al mencionar una fecha al cliente (ofrecer horarios, confirmar reuniones o seguimientos), el día de la semana SIEMPRE sale del CALENDARIO de arriba o de la etiqueta/mensajeParaProspecto que devuelva la tool — cópialo TAL CUAL; si dices "lunes" y era martes, el cliente llega el día equivocado a su reunión.

---

`
}


/** Bloque del teléfono conocido (compartido por el prompt MX clásico y el núcleo). */
export function bloqueTelefonoMX(contact?: string): string {
  const telefono = (contact || "").trim()
  return telefono
    ? `# Teléfono del cliente — ya lo conoces, NO lo preguntes

El cliente escribe por WhatsApp desde el +${telefono}. Ese ES su teléfono de contacto válido. NUNCA se lo preguntes ni le pidas "un número de contacto": cuando una tool requiera teléfono, usa este automáticamente. Solo si ofrece espontáneamente otro número distinto, usa ese.

---

`
    : ""
}
