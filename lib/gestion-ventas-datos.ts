/**
 * CLASIFICAR VENTAS EN AUTÓNOMA / ASISTIDA (lectura de datos).
 *
 * La REGLA vive en lib/gestion-venta.ts (pura y testeada); acá está el acceso
 * a datos, compartido por el dash (columna Pagada del /inbound) y por el
 * informe de ventas en CLP, para que los dos den el MISMO número.
 *
 * Orden de costo: caché en vic_kv por cotización → espejo en bulk desde
 * Supabase (solo sesiones de telemarketing) → notas del deal en Zoho para lo
 * que quede, con tope por llamada.
 */

import { claveGestion, refrescarGestion, sesionesTelemarketing, esNotaDeTelemarketing, type GestionVenta } from "./gestion-venta"
import { getZohoAccessToken } from "./zoho-token"

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const digits = (s: string): string => String(s || "").replace(/\D/g, "")

/**
 * AUTÓNOMA vs ASISTIDA por venta (Lalo 10-sep, para el segundo paréntesis de
 * la columna Pagada): **autónoma = sin ACTIVIDAD del ejecutivo, aunque la
 * conversación se haya traspasado** — "puede haber traspaso y que el ejecutivo
 * no haya hecho nada". Asistida = traspaso MÁS actividad real.
 *
 * Criterio idéntico al de `hayGestionEnDeal` y al del correo de PAGADA, para
 * que dash, correo y asignación de la venta no se contradigan. Orden de costo:
 * (1) caché en vic_kv por cotización, (2) espejo del vendedor en bulk desde
 * Supabase, (3) notas del deal en Zoho solo para lo que quede sin resolver,
 * con tope por render. Lo que no se pudo verificar queda "sd", nunca autónoma.
 */
export type VentaAClasificar = {
  quoteId: string
  /** Teléfono del contacto, solo dígitos. */
  tel: string
  /** Deal asociado; sin él no hay notas que leer y la venta queda "sd". */
  dealId: string
  /** Fecha del pago o de la aceptación en ms (decide el refresco de caché). */
  fechaMs: number
}

export async function gestionDeVentas(
  pagadas: VentaAClasificar[],
  opts: { maxZoho?: number } = {},
): Promise<Map<string, GestionVenta>> {
  const out = new Map<string, GestionVenta>()
  const filas = pagadas.filter((q) => String(q.quoteId || "").trim())
  if (!filas.length || !SUPABASE_URL || !SUPABASE_KEY) return out
  const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  const ahora = Date.now()
  // (1) Caché por cotización — una consulta por lote de 80 claves.
  const cache = new Map<string, { g?: string; at?: string }>()
  const ids = [...new Set(filas.map((q) => q.quoteId))]
  for (let i = 0; i < ids.length; i += 80) {
    const keys = ids.slice(i, i + 80).map((id) => `"${claveGestion(id)}"`).join(",")
    const r = await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?key=in.(${keys})&select=key,value`, { headers: h, cache: "no-store" }).catch(() => null)
    if (!r?.ok) continue
    const rows = ((await r.json().catch(() => [])) as Array<{ key: string; value: string }>) || []
    for (const row of rows) {
      try { cache.set(String(row.key).replace(/^venta_gestion_v\d+_/, ""), JSON.parse(String(row.value || "{}"))) } catch { /* fila corrupta */ }
    }
  }
  // (2) Espejo del vendedor en bulk: su WhatsApp o una llamada contestada son
  // actividad aunque la nota-espejo todavía no haya llegado a Zoho (el cron
  // que las sincroniza corre cada ~15 min). SOLO sesiones de TELEMARKETING
  // (Lalo 10-sep): el WhatsApp de Aleydis o Aracelli es gestión POSTVENTA de
  // una venta autónoma, no asistencia — se filtra en código y no con
  // `session_id=not.in.(…)`, que en Postgres descartaría también los NULL.
  const sesionesOk = sesionesTelemarketing()
  const tels = [...new Set(filas.map((q) => q.tel).filter((t) => t.length >= 9))]
  const conEspejo = new Set<string>()
  for (let i = 0; i < tels.length; i += 100) {
    const lista = tels.slice(i, i + 100).map((t) => `"${t}"`).join(",")
    const [rm, rl] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/vic_wa_espejo_mensajes?telefono_chat=in.(${lista})&from_me=eq.true&es_grupo=eq.false&select=telefono_chat,session_id&limit=5000`, { headers: h, cache: "no-store" }).catch(() => null),
      fetch(`${SUPABASE_URL}/rest/v1/vic_wa_espejo_llamadas?telefono=in.(${lista})&estado=eq.accept&select=telefono,session_id&limit=2000`, { headers: h, cache: "no-store" }).catch(() => null),
    ])
    const deTlmk = (ses: unknown) => sesionesOk.has(String(ses || "").trim().toLowerCase())
    if (rm?.ok) for (const f of ((await rm.json().catch(() => [])) as Array<{ telefono_chat?: string; session_id?: string }>) || []) {
      if (deTlmk(f.session_id)) conEspejo.add(digits(String(f.telefono_chat || "")))
    }
    if (rl?.ok) for (const f of ((await rl.json().catch(() => [])) as Array<{ telefono?: string; session_id?: string }>) || []) {
      if (deTlmk(f.session_id)) conEspejo.add(digits(String(f.telefono || "")))
    }
  }
  // (3) Notas del deal, solo lo que quede sin resolver.
  const maxZoho = Math.max(0, opts.maxZoho ?? 40)
  let leidas = 0
  let H: Record<string, string> | null = null
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  const guardar = async (id: string, g: GestionVenta) => {
    if (g === "sd") return
    await fetch(`${SUPABASE_URL}/rest/v1/vic_kv`, {
      method: "POST",
      headers: { ...h, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ key: claveGestion(id), value: JSON.stringify({ g, at: new Date(ahora).toISOString() }) }),
      cache: "no-store",
    }).catch(() => null)
  }
  for (const q of filas) {
    const id = q.quoteId
    const tel = q.tel
    if (tel && conEspejo.has(tel)) { out.set(id, "asistida"); continue }
    const c = cache.get(id) || null
    const pagoMs = q.fechaMs
    if (c?.g && !refrescarGestion(c, pagoMs, ahora)) { out.set(id, c.g as GestionVenta); continue }
    const dealId = String(q.dealId || "").trim()
    if (!dealId || leidas >= maxZoho) { out.set(id, (c?.g as GestionVenta) || "sd"); continue }
    if (!H) {
      const token = await getZohoAccessToken().catch(() => "")
      if (!token) { out.set(id, (c?.g as GestionVenta) || "sd"); continue }
      H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
    }
    leidas++
    // Notas del deal con el criterio ANGOSTO: solo telemarketing. No se usa
    // hayGestionEnDeal (cualquier humano) porque esa función decide otra cosa
    // —si la venta se le quita al dueño— y ahí el criterio ancho protege a
    // quien sí trabajó el caso.
    const rn = await fetch(`${api}/crm/v3/Deals/${dealId}/Notes?fields=Note_Title,Created_By&per_page=100`, { headers: H, cache: "no-store" }).catch(() => null)
    let g: GestionVenta = "sd"
    if (rn?.ok || rn?.status === 204) {
      const notas = rn.status === 204
        ? []
        : (((await rn.json().catch(() => ({}))) as { data?: Array<{ Note_Title?: string | null; Created_By?: { id?: string } | null }> }).data || [])
      g = notas.some(esNotaDeTelemarketing) ? "asistida" : "autonoma"
    }
    out.set(id, g)
    void guardar(id, g)
  }
  return out
}
