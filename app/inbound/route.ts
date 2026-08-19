/**
 * /inbound — DASH INBOUND INTERNO con URL propia (Lalo 19-ago, "quítalo de
 * la URL de gestión, dale su propia URL lo más corta posible, sin login: la
 * página tiene que cargar rapidísimo").
 *
 * Sirve DIRECTO la foto precalculada del inbound (vic_kv dash_snap_inbound)
 * — cero login, cero Zoho, carga <1s. Acceso por token corto en la URL
 * (?k=, vic_kv inbound_link_key), mismo patrón de los links de cotización:
 * la página trae datos de clientes y no puede quedar pública. Uso: Lalo y
 * Rodrigo guardan el link una vez.
 *
 * - La foto nace de renders máquina (links con la llave del funnel): acá se
 *   le QUITA la llave y se inyecta <base href="/api/vic-funnel"> — cualquier
 *   clic (drill-down, pestañas) navega al dash real, donde la cookie de
 *   admin de ellos autentica. Nadie gana la llave máquina por ver esta página.
 * - ?fresh=1 (botón ⟳): regenera la foto en vivo (análisis incluido) y la
 *   sirve — esa carga sí toma ~15-30 s.
 */

export const dynamic = "force-dynamic"
export const maxDuration = 60

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const FUNNEL_KEY = (process.env.VIC_FUNNEL_KEY || "").trim()

async function kvGet(key: string): Promise<string> {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_kv?key=eq.${encodeURIComponent(key)}&select=value&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store" },
    )
    if (!r.ok) return ""
    const rows = (await r.json().catch(() => [])) as Array<{ value?: string }>
    return String(rows[0]?.value || "")
  } catch {
    return ""
  }
}

function baseUrl(req: Request): string {
  const actual = (process.env.VERCEL_URL || "").trim()
  if (actual) return `https://${actual}`
  return new URL(req.url).origin
}

export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url)
  const k = (searchParams.get("k") || "").trim()
  const esperado = (await kvGet("inbound_link_key")).trim()
  if (!esperado || k !== esperado) {
    return new Response("No encontrado", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } })
  }
  const fresh = searchParams.get("fresh") === "1"
  // fresh (o foto ausente): un render en vivo del funnel regenera la foto
  // (con su pasada de análisis) y de paso la deja fresca para todos.
  const regenerar = async () => {
    try {
      await fetch(`${baseUrl(req)}/api/vic-funnel?key=${encodeURIComponent(FUNNEL_KEY)}&vista=inbound&fresh=1`, {
        cache: "no-store",
        signal: AbortSignal.timeout(50_000),
      })
    } catch {
      /* si no alcanzó, se sirve la foto que haya */
    }
  }
  if (fresh && FUNNEL_KEY) await regenerar()
  let crudo = await kvGet("dash_snap_inbound")
  if (!crudo && FUNNEL_KEY && !fresh) {
    await regenerar()
    crudo = await kvGet("dash_snap_inbound")
  }
  let foto: { at?: string; html?: string } | null = null
  try {
    foto = crudo ? (JSON.parse(crudo) as { at?: string; html?: string }) : null
  } catch {
    foto = null
  }
  if (!foto?.html) {
    return new Response("La foto del panel aún no está lista — intenta de nuevo en un minuto.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "60" },
    })
  }
  // Anti-fuga: fuera la llave máquina de todos los links de la foto.
  let html = foto.html
  if (FUNNEL_KEY) {
    html = html
      .split(`key=${FUNNEL_KEY}&`).join("")
      .split(`?key=${FUNNEL_KEY}`).join("?")
      .split(`&key=${FUNNEL_KEY}`).join("")
      .split(`value="${FUNNEL_KEY}"`).join('value=""')
  }
  // <base>: los links relativos ("?vista=…", "?inbdet=…") navegan al dash
  // real — ahí autentica la cookie de admin de quien haga clic.
  html = html.replace(/<head([^>]*)>/, (_m, a: string) => `<head${a}><base href="/api/vic-funnel">`)
  const edadMs = Date.now() - Date.parse(String(foto.at || ""))
  const mins = Number.isFinite(edadMs) ? Math.max(0, Math.round(edadMs / 60000)) : 0
  const banner = `<div style="position:sticky;top:0;z-index:60;background:#eef7ff;border-bottom:1px solid #cfe6f7;padding:6px 14px;font-size:13px;font-weight:600;color:#0b5e8a">📥 Panel interno · datos de hace ${mins} min (se refresca solo cada hora) · <a href="/inbound?k=${encodeURIComponent(k)}&fresh=1" style="color:#00aff2">⟳ Actualizar ahora</a></div>`
  html = html.replace(/<body([^>]*)>/, (_m, a: string) => `<body${a}>${banner}`)
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
  })
}
