/**
 * ¿EL DUEÑO ACTUAL LO PUSO UNA PERSONA O LO PUSO NUESTRO CÓDIGO?
 *
 * Nacida el 10-sep con la conciliación SDR (orden de Lalo: re-sortear los
 * casos que Vicky mal-entregó a las SDR, sin tocar NUNCA una asignación que
 * decidió un humano). Los casos que obligaron a esto son gemelos en todo lo
 * demás —etapa temprana, deal de Vicky, dotación conocida, nota escrita por la
 * SDR— y solo el TIMELINE los distingue:
 *
 *   OMEGA   (…556033): Owner → Aleydis el 02-sep 14:47, done_by GeoVictoria
 *                      Admin = el movimiento MANUAL que ordenó Lalo. NO tocar.
 *   Cancino (…339242): Owner → Aleydis el 31-ago, done_by Vicky GeoVictoria =
 *                      nuestro propio código. Re-sorteable.
 *
 * Todo lo que escribe la app aparece con `done_by` = el usuario del OAuth
 * (Vicky GeoVictoria); cualquier otro actor (una persona en la UI de Zoho, o
 * el conector admin con el que se hacen las correcciones a mano) es decisión
 * humana.
 *
 * CICATRIZ (10-sep, TRAMUS …460301 y ROSSELLÓ …961153): mirar solo el ÚLTIMO
 * evento de Owner no alcanza — a esos dos los movió el conector admin a las
 * 14:47 y a las 16:30 nuestro código RE-ESTAMPÓ el mismo dueño, así que el
 * último evento era de la app y quedaron sin protección (la conciliación los
 * re-sorteó y hubo que devolverlos). Ahora la pregunta es si ALGÚN actor
 * humano puso el dueño que el registro tiene HOY: si sí, es decisión vigente y
 * es intocable; si el humano puso a otro y después el flujo lo movió, esa
 * decisión ya fue superada y no protege nada.
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
  /** Quién puso el dueño vigente (nombre de Zoho), cuando fue una persona. */
  actor?: string
  at?: string
  motivo: "sin_evento" | "app" | "humano" | "humano_superado" | "ilegible"
}

const norm = (s: unknown): string =>
  String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase()

/** PURA: decide sobre los eventos ya leídos (lo que testean los tests). */
export function veredictoOwnerDesdeTimeline(
  eventos: EventoTimeline[],
  ownerActual?: string,
  actorApp = ACTOR_APP_ID,
): VeredictoOwner {
  const conOwner = eventos
    .filter((e) => (e.field_history || []).some((f) => String(f?.api_name || "").toLowerCase() === "owner"))
    // El timeline llega del más reciente al más antiguo; ordenar por si acaso.
    .sort((a, b) => String(b.audited_time || "").localeCompare(String(a.audited_time || "")))
  if (!conOwner.length) return { manual: false, motivo: "sin_evento" }
  const humano = conOwner.find((e) => String(e.done_by?.id || "") !== actorApp)
  if (!humano) return { manual: false, motivo: "app" }
  const puesto = (humano.field_history || []).find((f) => String(f?.api_name || "").toLowerCase() === "owner")?._value?.new
  // Sin dueño actual conocido no se puede comparar: se protege (fail-safe).
  if (ownerActual && puesto && norm(puesto) !== norm(ownerActual)) {
    return { manual: false, motivo: "humano_superado", actor: humano.done_by?.name || undefined, at: humano.audited_time }
  }
  return { manual: true, motivo: "humano", actor: humano.done_by?.name || undefined, at: humano.audited_time }
}

/**
 * Lee el timeline del registro (y su dueño vigente) y responde si el dueño lo
 * puso una persona. `modulo` = "Deals" | "Leads". Recibe el api domain y los
 * headers ya armados (el cron los tiene) para no volver a pedir token.
 */
export async function ownerLoPusoUnHumano(
  modulo: "Deals" | "Leads",
  recordId: string,
  api: string,
  headers: Record<string, string>,
): Promise<VeredictoOwner> {
  try {
    const [rt, ro] = await Promise.all([
      // v3 responde API_NOT_SUPPORTED en __timeline: va por v8 (cicatriz 18-ago).
      fetch(`${api}/crm/v8/${modulo}/${recordId}/__timeline?per_page=100`, { headers, cache: "no-store" }),
      fetch(`${api}/crm/v3/${modulo}/${recordId}?fields=Owner`, { headers, cache: "no-store" }),
    ])
    if (!rt.ok || rt.status === 204) return { manual: true, motivo: "ilegible" }
    const j = (await rt.json().catch(() => ({}))) as { __timeline?: EventoTimeline[] }
    if (!Array.isArray(j.__timeline)) return { manual: true, motivo: "ilegible" }
    const owner =
      ro.status === 200
        ? (((await ro.json().catch(() => ({}))) as { data?: Array<{ Owner?: { name?: string } }> }).data?.[0]?.Owner?.name || "")
        : ""
    return veredictoOwnerDesdeTimeline(j.__timeline, owner || undefined)
  } catch {
    return { manual: true, motivo: "ilegible" }
  }
}
