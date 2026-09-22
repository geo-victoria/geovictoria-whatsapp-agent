/**
 * TELEMETRÍA DEL ÚLTIMO METRO (Rodrigo 17-ago): pings de la página de
 * aceptación (quote-acceptance) y de pago.html — los pasos 1-5 del funnel de
 * pago que hasta hoy solo vivían en logs efímeros de 24 h. Cada evento queda
 * en vic_kv como `pf_<quoteId>_<evento>` con el PRIMER timestamp (INSERT sin
 * upsert: la unicidad de la llave arbitra — una reapertura no pisa el primer
 * registro). El evento `comprobante_wsp` lo escribe la tool
 * registrar_comprobante_transferencia (lado agente), no esta ruta.
 *
 * Público a propósito (las páginas corren en el navegador del cliente, sin
 * secretos que proteger): CORS *, whitelist dura de eventos, quoteId numérico
 * y best-effort — un fallo acá JAMÁS afecta el flujo de pago. El body llega
 * como texto plano (sendBeacon con string = request simple, sin preflight).
 * Lo consume el panel "Funnel de pago" del dash (vic-funnel).
 */

import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const maxDuration = 10

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

const EVENTOS = new Set([
  "abrio",
  "terminos",
  "acepto",
  "pago_abierto",
  "metodo_tarjeta",
  "metodo_transferencia",
  "salida_mp",
  "transfer_wsp_click",
])

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: CORS })
}

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const raw = (await req.text()).slice(0, 500)
    const body = JSON.parse(raw) as { quoteId?: unknown; evento?: unknown; device?: unknown }
    const quoteId = String(body.quoteId || "").replace(/\D/g, "")
    const evento = String(body.evento || "")
    const device = String(body.device || "") === "movil" ? "movil" : "desktop"
    if (!quoteId || quoteId.length < 5 || quoteId.length > 25 || !EVENTOS.has(evento)) {
      return NextResponse.json({ ok: false }, { status: 400, headers: CORS })
    }
    if (SUPABASE_URL && SUPABASE_KEY) {
      // INSERT sin upsert (patrón cron-lock): el primer evento gana y el 409
      // del duplicado se ignora en silencio.
      await fetch(`${SUPABASE_URL}/rest/v1/vic_kv`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          key: `pf_${quoteId}_${evento}`,
          value: `${new Date().toISOString()}|${device}`,
          expires_at: new Date(Date.now() + 180 * 24 * 3600e3).toISOString(),
        }),
      }).catch(() => {})
    }
    return NextResponse.json({ ok: true }, { headers: CORS })
  } catch {
    return NextResponse.json({ ok: false }, { status: 400, headers: CORS })
  }
}
