/**
 * ADMIN — ¿qué SCOPE tiene cada credencial de Zoho del agente? (30-sep)
 *
 * Existe para poder AMPLIAR el scope (ZohoFiles para subir la planilla de
 * equipos al ticket ST y la planilla de ingreso a la IMP) sin adivinar qué
 * tiene hoy el refresh token: la respuesta del endpoint de refresco de Zoho
 * trae el campo `scope` con la lista exacta que se concedió al crear el grant.
 * Un scope que no esté acá NO se puede sumar editando nada: hay que emitir un
 * grant nuevo con la unión de los dos conjuntos.
 *
 *   GET ?key=<cron>              → scope del token principal (ZOHO_REFRESH_TOKEN)
 *   GET ?key=<cron>&cual=files   → scope del token de archivos (ZOHO_FILES_REFRESH_TOKEN)
 *   GET ?key=<cron>&cual=bookings→ scope del token de Bookings
 *
 * Devuelve SOLO scope, api_domain y expires_in. El access token acuñado se
 * descarta. Cada llamada gasta UNA renovación del refresh token (Zoho tolera
 * pocas por minuto): es una herramienta de diagnóstico, no de monitoreo.
 */
import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const CREDENCIALES: Record<string, { refresh: string; id: string; secret: string }> = {
  principal: { refresh: "ZOHO_REFRESH_TOKEN", id: "ZOHO_CLIENT_ID", secret: "ZOHO_CLIENT_SECRET" },
  files: { refresh: "ZOHO_FILES_REFRESH_TOKEN", id: "ZOHO_CLIENT_ID", secret: "ZOHO_CLIENT_SECRET" },
  bookings: { refresh: "ZOHO_BOOKINGS_REFRESH_TOKEN", id: "ZOHO_BOOKINGS_CLIENT_ID", secret: "ZOHO_BOOKINGS_CLIENT_SECRET" },
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const secreto = await getFollowupCronSecret()
  const dado = req.headers.get("x-cron-secret") || url.searchParams.get("key") || ""
  if (!secreto || dado !== secreto) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const cual = (url.searchParams.get("cual") || "principal").trim()
  const c = CREDENCIALES[cual]
  if (!c) return NextResponse.json({ ok: false, error: "cual debe ser principal | files | bookings" }, { status: 400 })
  const env = (n: string) => (process.env[n] || "").trim()
  if (!env(c.refresh)) return NextResponse.json({ ok: true, cual, configurado: false, env: c.refresh })
  const domain = env("ZOHO_ACCOUNTS_DOMAIN") || "https://accounts.zoho.com"
  const res = await fetch(`${domain}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: env(c.refresh), client_id: env(c.id), client_secret: env(c.secret), grant_type: "refresh_token" }),
    cache: "no-store",
  })
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>
  const scope = String(j.scope || "")
  return NextResponse.json({
    ok: Boolean(j.access_token),
    cual,
    configurado: true,
    env: c.refresh,
    scope: scope ? scope.split(/[ ,]+/).filter(Boolean).sort() : [],
    api_domain: j.api_domain || null,
    expires_in: j.expires_in || null,
    error: j.access_token ? undefined : j.error || j,
  })
}
