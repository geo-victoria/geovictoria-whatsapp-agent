/**
 * AUTÓNOMA vs ASISTIDA — DEFINICIÓN DE VICTORIA LUNA (correo 16-sep) con las
 * cuatro decisiones de Lalo del mismo día. PURA: recibe evidencia ya leída y
 * devuelve veredicto + por qué, para que cada fila del pase sea auditable.
 *
 * Victoria: "Para atribuir participación comercial al ejecutivo debe existir
 * (1) una interacción BIDIRECCIONAL con el cliente —respuesta por WhatsApp o
 * correo, llamada contestada o reunión— y (2) una GESTIÓN que haya contribuido
 * al avance de la compra. Un intento de contacto sin respuesta es actividad
 * operativa, no asistencia. No utilizaría el espejo de WhatsApp como criterio.
 * Una nota cuenta cuando registre fecha y canal, resumen concreto, gestión
 * realizada, resultado y próximo paso cuando corresponda; 'en seguimiento' ya
 * no es suficiente."
 *
 * Decisiones de Lalo (16-sep):
 *   1. Las SDR (Aleydis/Aracelli) NO cuentan: su gestión es postventa de una
 *      venta autónoma. Solo el roster de TELEMARKETING (lib/gestion-venta).
 *   2. Ventana: la evidencia es ANTERIOR al pago. Una nota puede escribirse
 *      hasta 24 h después del pago si describe una interacción anterior.
 *   3. Mínimo de la nota: fecha y canal + resumen + gestión. Resultado y
 *      próximo paso suman pero no bloquean.
 *   4. Se re-etiqueta desde el 17-ago.
 *
 * Tres salidas, no dos: "revisar" = hubo interacción bidireccional comprobable
 * (llamada contestada / reunión) pero ninguna nota que documente la gestión.
 * Ahí la regla no puede decidir sola y la fila se mira a mano.
 */

export type RubricaNota = {
  fechaCanal: boolean
  resumen: boolean
  gestion: boolean
  resultado: boolean
  proximoPaso: boolean
  /** La nota describe que el CLIENTE respondió o conversó (no solo un intento). */
  bidireccional: boolean
  /** La nota describe SOLO un intento sin respuesta ("se llama, no contesta"). */
  intentoSinRespuesta: boolean
}

export type NotaEvidencia = {
  id: string
  autorId: string
  autorNombre?: string
  creadaMs: number
  /** Nota-espejo generada por el robot: NO es criterio (Victoria), solo auditoría. */
  esEspejo: boolean
  rubrica: RubricaNota | null
  extracto?: string
}

export type LlamadaEvidencia = { id: string; ownerId: string; inicioMs: number; duracionSeg: number; tipo?: string }
export type ReunionEvidencia = { id: string; ownerId: string; inicioMs: number; titulo?: string }

export type EvidenciaVenta = {
  pagoMs: number
  notas: NotaEvidencia[]
  llamadas: LlamadaEvidencia[]
  reuniones: ReunionEvidencia[]
  /** ids de Zoho del roster de telemarketing (decisión 1). */
  rosterIds: Set<string>
}

export type VeredictoV3 = "asistida" | "autonoma" | "revisar"

export type ResultadoV3 = {
  veredicto: VeredictoV3
  motivo: string
  /** Evidencia que sostiene el veredicto, en texto corto por ítem. */
  evidencia: string[]
  /** Evidencia descartada y por qué (fuera de ventana, SDR, nota insuficiente…). */
  descartada: string[]
}

export const MARGEN_NOTA_MS = 24 * 3_600_000

export function notaCumpleMinimo(r: RubricaNota | null): boolean {
  return Boolean(r && r.fechaCanal && r.resumen && r.gestion && !r.intentoSinRespuesta)
}

const fmt = (ms: number): string => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "?")

export function clasificarGestionV3(e: EvidenciaVenta): ResultadoV3 {
  const evidencia: string[] = []
  const descartada: string[] = []
  const pago = e.pagoMs
  const enVentanaNota = (ms: number) => !Number.isFinite(pago) || ms <= pago + MARGEN_NOTA_MS
  const antesDelPago = (ms: number) => !Number.isFinite(pago) || ms <= pago

  let notaValida = false
  let notaBidireccional = false
  for (const n of e.notas) {
    const quien = n.autorNombre || n.autorId
    if (n.esEspejo) { descartada.push(`nota-espejo ${fmt(n.creadaMs)}: no es criterio (Victoria), solo auditoría`); continue }
    if (!e.rosterIds.has(n.autorId)) { descartada.push(`nota de ${quien} ${fmt(n.creadaMs)}: fuera del roster de telemarketing`); continue }
    if (!enVentanaNota(n.creadaMs)) { descartada.push(`nota de ${quien} ${fmt(n.creadaMs)}: posterior al pago (+24 h) = postventa`); continue }
    if (!n.rubrica) { descartada.push(`nota de ${quien} ${fmt(n.creadaMs)}: sin evaluar`); continue }
    if (n.rubrica.intentoSinRespuesta && !n.rubrica.bidireccional) {
      descartada.push(`nota de ${quien} ${fmt(n.creadaMs)}: intento sin respuesta`)
      continue
    }
    if (!notaCumpleMinimo(n.rubrica)) {
      const falta = [!n.rubrica.fechaCanal && "fecha/canal", !n.rubrica.resumen && "resumen", !n.rubrica.gestion && "gestión"].filter(Boolean).join(", ")
      descartada.push(`nota de ${quien} ${fmt(n.creadaMs)}: no cumple el mínimo (falta ${falta})`)
      continue
    }
    notaValida = true
    if (n.rubrica.bidireccional) notaBidireccional = true
    evidencia.push(`nota de ${quien} ${fmt(n.creadaMs)}${n.rubrica.bidireccional ? " con respuesta del cliente" : ""}${n.extracto ? `: "${n.extracto}"` : ""}`)
  }

  let llamada = false
  for (const l of e.llamadas) {
    if (!e.rosterIds.has(l.ownerId)) { descartada.push(`llamada ${fmt(l.inicioMs)}: fuera del roster`); continue }
    if (!antesDelPago(l.inicioMs)) { descartada.push(`llamada ${fmt(l.inicioMs)}: posterior al pago`); continue }
    if (!(l.duracionSeg > 0)) { descartada.push(`llamada ${fmt(l.inicioMs)}: sin duración (no contestada)`); continue }
    llamada = true
    evidencia.push(`llamada contestada ${fmt(l.inicioMs)} (${l.duracionSeg}s${l.tipo ? `, ${l.tipo}` : ""})`)
  }
  let reunion = false
  for (const r of e.reuniones) {
    if (!e.rosterIds.has(r.ownerId)) { descartada.push(`reunión ${fmt(r.inicioMs)}: fuera del roster`); continue }
    if (!antesDelPago(r.inicioMs)) { descartada.push(`reunión ${fmt(r.inicioMs)}: posterior al pago`); continue }
    reunion = true
    evidencia.push(`reunión ${fmt(r.inicioMs)}${r.titulo ? ` "${r.titulo}"` : ""}`)
  }

  const bidireccional = notaBidireccional || llamada || reunion
  if (notaValida && bidireccional) {
    return { veredicto: "asistida", motivo: "interacción bidireccional + gestión documentada por telemarketing antes del pago", evidencia, descartada }
  }
  if (reunion) {
    // Una reunión realizada es, por sí misma, presentar la propuesta.
    return { veredicto: "asistida", motivo: "reunión con el cliente antes del pago", evidencia, descartada }
  }
  if (llamada && !notaValida) {
    return { veredicto: "revisar", motivo: "llamada contestada pero ninguna nota documenta la gestión", evidencia, descartada }
  }
  if (notaValida && !bidireccional) {
    return { veredicto: "revisar", motivo: "nota con gestión pero sin evidencia de respuesta del cliente", evidencia, descartada }
  }
  return { veredicto: "autonoma", motivo: evidencia.length ? "evidencia insuficiente" : "sin gestión de telemarketing antes del pago", evidencia, descartada }
}

/** RÚBRICA DETERMINISTA (parte pura de lib/nota-rubrica): casos que se resuelven sin modelo. Devuelve null cuando hay que leer. */
const normR = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim()

const TODO_FALSO: RubricaNota = { fechaCanal: false, resumen: false, gestion: false, resultado: false, proximoPaso: false, bidireccional: false, intentoSinRespuesta: false }

/** Casos que se resuelven sin modelo. Devuelve null cuando hay que leer. */
export function rubricaDeterminista(contenido: string): RubricaNota | null {
  const t = normR(contenido || "")
  if (t.length < 12) return { ...TODO_FALSO }
  if (/^(sgto|segui\w*|seguimiento|en seguimiento|en sgto|contactado|llamado|gestionado)[.!\s]*$/.test(t)) return { ...TODO_FALSO }
  const intento = /(se (le )?llama|llamo|llame|intento|se envia (whatsapp|wsp|correo|mail)|se contacta)[^.]{0,60}(no (contesta|responde|atiende)|sin respuesta|buzon|no se logra)/.test(t)
  if (intento && t.length < 140) return { ...TODO_FALSO, intentoSinRespuesta: true }
  return null
}


