/**
 * Endpoint ADMIN: GET /api/vic-admin-wa-espejo?session=<id>&key=<CRON_SECRET>
 *
 * Página de vinculación del espejo de WhatsApp de un ejecutivo (worker
 * workers/wa-espejo). Muestra el QR vigente (publicado por el worker en
 * vic_kv `wa_espejo_qr_<session>`) y el estado de la sesión; se refresca sola
 * cada 5 s porque el QR de WhatsApp rota ~cada minuto.
 *
 * Auth: ?key= == CRON_SECRET o header x-cron-secret == vic_kv.followup_cron_secret
 * (mismo modelo que el resto de los endpoints admin; ?key= permite abrirla en
 * el navegador para mostrarle el QR al ejecutivo).
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

async function kvGet(key: string): Promise<string> {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_kv?key=eq.${encodeURIComponent(key)}&select=value,expires_at&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store" },
    )
    const rows = (await r.json().catch(() => [])) as Array<{ value?: string; expires_at?: string | null }>
    const row = rows[0]
    if (!row) return ""
    if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return ""
    return String(row.value || "")
  } catch {
    return ""
  }
}

async function authorized(req: Request): Promise<boolean> {
  const url = new URL(req.url)
  if (CRON_SECRET && (url.searchParams.get("key") || "").trim() === CRON_SECRET) return true
  const xcron = (req.headers.get("x-cron-secret") || "").trim()
  if (xcron) {
    const expected = await getFollowupCronSecret().catch(() => "")
    if (expected && xcron === expected) return true
  }
  return false
}

export async function GET(req: Request): Promise<Response> {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  const url = new URL(req.url)
  const session = (url.searchParams.get("session") || "").trim().replace(/[^a-zA-Z0-9_-]/g, "")
  if (!session) {
    return NextResponse.json({ ok: false, error: "Falta ?session=<WA_SESSION_ID>" }, { status: 400 })
  }

  const [qr, statusRaw] = await Promise.all([
    kvGet(`wa_espejo_qr_${session}`),
    kvGet(`wa_espejo_status_${session}`),
  ])
  let estado = "sin señal del worker"
  let detalle = ""
  try {
    const st = JSON.parse(statusRaw || "{}") as { estado?: string; numero?: string; at?: string }
    if (st.estado) {
      estado = st.estado
      detalle = [st.numero, st.at ? new Date(st.at).toLocaleString("es-CL", { timeZone: "America/Santiago" }) : ""]
        .filter(Boolean)
        .join(" · ")
    }
  } catch {
    /* sin estado aún */
  }

  const cuerpo =
    estado === "conectado"
      ? `<div class="ok">✅ Conectado</div><p class="sub">${detalle}</p><p>El espejo está activo. No hay nada más que hacer.</p>`
      : qr
        ? `<img src="${qr}" alt="QR de vinculación" width="360" height="360"/><p>En el celular del ejecutivo: <b>WhatsApp Business → Dispositivos vinculados → Vincular dispositivo</b> y escanear este código. Se renueva solo.</p>`
        : `<div class="warn">⏳ ${estado}</div><p class="sub">${detalle}</p><p>Sin QR publicado. Si el worker está recién desplegado, espera unos segundos; esta página se refresca sola.</p>`

  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"/>
<meta http-equiv="refresh" content="5"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Espejo WhatsApp — ${session}</title>
<style>
body{font-family:Arial,Helvetica,sans-serif;color:#333;max-width:480px;margin:40px auto;padding:0 16px;text-align:center}
h1{color:#00AFF2;font-size:20px}
.ok{color:#1b7f3a;font-size:22px;font-weight:bold}
.warn{color:#b26a00;font-size:18px;font-weight:bold}
.sub{color:#888;font-size:12px}
img{border:1px solid #ddd;border-radius:8px}
</style></head><body>
<h1>Espejo WhatsApp — sesión "${session}"</h1>
${cuerpo}
</body></html>`
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
}
