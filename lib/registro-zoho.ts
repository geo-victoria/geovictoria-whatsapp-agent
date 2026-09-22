/**
 * REGISTRO DE TODO LO QUE VICKY CREA EN ZOHO (orden de Lalo, 15-ago).
 *
 * Hasta hoy el rastro estaba repartido y a medias: el lead en un candado de
 * `vic_kv` (147 de 1238 conversaciones), la cotización en
 * `vic_v3_quote_pointers`, el trato solo en las emisiones chilenas, y la
 * cuenta y el contacto en ninguna parte. Reconstruir el vínculo obligaba a
 * cruzar por teléfono — y el teléfono en Zoho está escrito de cuatro formas
 * distintas ("+56964525048", "56964525048", "+569 6452 5048",
 * "+56 9 6249 2757"), así que el cruce fallaba justo en los casos que
 * importaban.
 *
 * Ahora hay una sola tabla: `vic_zoho_registros`. SOLO IDS (Lalo: "pero solo
 * los id, no toda la data") — la data vive en Zoho. Lo que sí queda claro es
 * DE QUÉ es cada id: la columna `modulo` distingue lead, trato, cotización,
 * cuenta y contacto.
 *
 * Best-effort absoluto: si esto falla, el flujo que lo llamó sigue igual.
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

export type ModuloZoho = "Leads" | "Deals" | "Cotizaciones_GeoVictoria" | "Accounts" | "Contacts"

/** Una cosa creada en Zoho: módulo + id. */
export type PiezaZoho = { modulo: ModuloZoho; id?: string | null }

/**
 * Anota lo creado. Idempotente por (modulo, zoho_id): repetir la llamada no
 * duplica ni pisa lo anterior, así que se puede invocar sin miedo desde
 * varios caminos que toquen el mismo registro.
 */
export async function registrarEnZoho(
  contact: string,
  piezas: PiezaZoho[],
  opts: { origen?: string } = {},
): Promise<number> {
  try {
    const clean = (contact || "").replace(/\D/g, "")
    const filas = piezas
      .filter((p) => p && p.id && String(p.id).trim())
      .map((p) => ({
        contact: clean,
        modulo: p.modulo,
        zoho_id: String(p.id).trim(),
        origen: opts.origen || null,
      }))
    if (!clean || !filas.length || !SUPABASE_URL || !SUPABASE_KEY) return 0
    const r = await fetch(`${SUPABASE_URL}/rest/v1/vic_zoho_registros?on_conflict=modulo,zoho_id`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        // ignore-duplicates: el primero que lo anotó manda — su `origen` es
        // el verdadero, y una reconciliación posterior no debe reescribirlo.
        Prefer: "resolution=ignore-duplicates,return=minimal",
      },
      body: JSON.stringify(filas),
      cache: "no-store",
    })
    if (!r.ok) {
      console.warn(`[registro-zoho] ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`)
      return 0
    }
    return filas.length
  } catch (e) {
    console.warn("[registro-zoho] excepción:", e instanceof Error ? e.message : e)
    return 0
  }
}

/** Lo ya registrado de un contacto, por módulo. */
export async function registrosDeContacto(
  contact: string,
): Promise<Array<{ modulo: string; zoho_id: string; origen?: string }>> {
  try {
    const clean = (contact || "").replace(/\D/g, "")
    if (!clean || !SUPABASE_URL) return []
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_zoho_registros?contact=eq.${clean}&select=modulo,zoho_id,origen`,
      {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
        cache: "no-store",
      },
    )
    return r.ok ? await r.json() : []
  } catch {
    return []
  }
}
