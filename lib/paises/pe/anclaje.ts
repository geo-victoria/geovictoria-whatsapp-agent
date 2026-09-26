/**
 * Anclaje temporal + bloque del teléfono de Perú. PURO (imports .ts): lo
 * consume el prompt desde el núcleo (prompt-nucleo.ts) y lo cargan los tests
 * con node --test. Mismo molde que lib/paises/co/anclaje.ts.
 */
import { calendarioProximosDias } from "../../calendar.ts"
import { fichaOperativa } from "../ficha-operativa.ts"

const TZ_PE = fichaOperativa("pe").tz

// Anclaje temporal (espejo del chileno/colombiano/mexicano): sin él, el modelo
// no puede resolver "el martes próximo" ni "escríbeme el lunes" con fechas
// reales. TRUNCADO A LA HORA a propósito: si incluyera minutos/segundos, el
// system prompt cambiaría en cada request y rompería el prefijo del prompt
// caching (decisión de costos 11-jul).
export function anclajeTemporalPE(): string {
  const now = new Date()
  const fechaLegible = now.toLocaleString("es-PE", {
    timeZone: TZ_PE,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    hour12: false,
  })
  const isoHora = now.toISOString().slice(0, 13) + ":00:00Z"
  return `# Anclaje temporal (CRÍTICO para seguimientos)

HOY ES: ${fechaLegible} hrs aprox. (Perú, ${TZ_PE}, UTC-5)
FECHA ISO UTC ACTUAL (aprox.): ${isoHora}
CALENDARIO PRÓXIMOS DÍAS (día de la semana REAL de cada fecha — úsalo TAL CUAL, nunca calcules el día tú): ${calendarioProximosDias(TZ_PE)}

Cuando el cliente proponga un día relativo ("mañana", "el martes", "la próxima semana") — para un seguimiento (programar_seguimiento) o para acordar cuándo lo contacta la ejecutiva — interprétalo con base en el HOY indicado arriba, NO con tu conocimiento de entrenamiento. Usa siempre el AÑO ACTUAL (${now.getFullYear()}). Al mencionar una fecha al cliente, el día de la semana SIEMPRE sale del CALENDARIO de arriba — cópialo TAL CUAL.

---

`
}

/** Bloque del teléfono conocido (prompt desde el núcleo). */
export function bloqueTelefonoPE(contact?: string): string {
  const telefono = (contact || "").trim()
  return telefono
    ? `# Teléfono del cliente — ya lo conoces, NO lo preguntes

El cliente escribe por WhatsApp desde el +${telefono}. Ese ES su teléfono de contacto válido. NUNCA se lo preguntes ni le pidas "un número de contacto": cuando una tool requiera teléfono, usa este automáticamente. Solo si ofrece espontáneamente otro número distinto, usa ese.

---

`
    : ""
}
