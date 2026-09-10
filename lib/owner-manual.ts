/**
 * ¿EL DUEÑO ACTUAL LO PUSO UNA PERSONA O LO PUSO NUESTRO CÓDIGO?
 *
 * Nacida el 10-sep con la conciliación SDR (orden de Lalo: re-sortear los
 * casos que Vicky mal-entregó a las SDR, sin tocar NUNCA una asignación que
 * decidió un humano). Los dos casos que obligaron a esto son gemelos en todo
 * lo demás — ambos con nota escrita por Aleydis, ambas etapa 4, ambos deals
 * de Vicky con la dotación ya conocida — y solo el TIMELINE los distingue:
 *
 *   OMEGA   (…556033): Owner Vicky → Aleydis el 02-sep, done_by GeoVictoria
 *                      Admin = el movimiento MANUAL que ordenó Lalo. NO tocar.
 *   Cancino (…339242): Owner Vicky → Aleydis el 31-ago, done_by Vicky
 *                      GeoVictoria = nuestro propio código. Re-sorteable.
 *
 * Regla: todo lo que escribe la app aparece con `done_by` = el usuario del
 * OAuth (Vicky GeoVictoria); cualquier otro actor (una persona en la UI de
 * Zoho, o el conector admin con el que se hacen las correcciones a mano) es
 * una decisión humana. Sin evento de Owner en el timeline el registro NACIÓ
 * con ese dueño (herencia/tómbola de nuestro flujo) → tampoco es manual.
 *
 * FAIL-SAFE: si el timeline no se puede leer, se responde "manual" — ante la
 * duda jamás se pisa al dueño.
 */

/** Usuario del OAuth de la app: todo lo que escribimos aparece a su nombre. */
export const ACTOR_APP_ID = "3525045000484500876"

export type EventoTimeline = {
  action?: string
  audited_time?: string
  done_by?: { id?: string; name?: string } | null
  field_history?: Array<{ api_name?: string; _value?: { old?: unknown; new?: unknown } }> | null
}

export type VeredictoOwner = {
  manual: boolean
  /** Quién hizo el último cambio de dueño (nombre de Zoho), si lo hubo. */
  actor?: string
  at?: string
  motivo: "sin_evento" | "app" | "humano" | "ilegible"
}

/** PURA: decide sobre los eventos ya leídos (lo que testean los tests). */
export function veredictoOwnerDesdeTimeline(eventos: EventoTimeline[], actorApp = ACTOR_APP_ID): VeredictoOwner {
  const conOwner = eventos.filter((e) =>
    (e.field_history || []).some((f) => String(f?.api_name || "").toLowerCase() === "owner"),
  )
  if (!conOwner.length) return { manual: false, motivo: "sin_evento" }
  // El timeline llega del más reciente al más antiguo; ordenar igual por si acaso.
  const orden = [...conOwner].sort((a, b) => String(b.audited_time || "").localeCompare(String(a.audited_time || "")))
  const ultimo = orden[0]
  const porApp = String(ultimo.done_by?.id || "") === actorApp
  return {
    manual: !porApp,
    actor: ultimo.done_by?.name || undefined,
    at: ultimo.audited_time || undefined,
    motivo: porApp ? "app" : "humano",
  }
}

/**
 * Lee el timeline del registro y responde si el dueño lo puso una persona.
 * `modulo` = "Deals" | "Leads". Necesita el api domain y los headers ya
 * armados (el cron los tiene) para no volver a pedir token.
 */
export async function ownerLoPusoUnHumano(
  modulo: "Deals" | "Leads",
  recordId: string,
  api: string,
  headers: Record<string, string>,
): Promise<VeredictoOwner> {
  try {
    // v3 responde API_NOT_SUPPORTED en __timeline: va por v8 (cicatriz 18-ago).
    const r = await fetch(`${api}/crm/v8/${modulo}/${recordId}/__timeline?per_page=100`, { headers, cache: "no-store" })
    if (!r.ok || r.status === 204) return { manual: true, motivo: "ilegible" }
    const j = (await r.json().catch(() => ({}))) as { __timeline?: EventoTimeline[] }
    if (!Array.isArray(j.__timeline)) return { manual: true, motivo: "ilegible" }
    return veredictoOwnerDesdeTimeline(j.__timeline)
  } catch {
    return { manual: true, motivo: "ilegible" }
  }
}
