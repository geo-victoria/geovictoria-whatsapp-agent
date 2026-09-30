/**
 * CANJE SEGURO del grant de ZohoFiles (30-sep, Lalo "actualicemos scope de
 * manera segura").
 *
 * El token principal (ZOHO_REFRESH_TOKEN) nació sin ZohoFiles y un scope no se
 * amplía editándolo: hay que emitir un grant NUEVO con la UNIÓN de scopes. Ese
 * grant nace como un CÓDIGO de un solo uso en api-console.zoho.com (Self
 * Client → Generate Code); acá se canjea con el client id/secret que ya viven
 * en Vercel, se verifica que el scope concedido sea la unión completa, se
 * PRUEBA una subida real a /crm/v3/files (un .txt de 20 bytes) y recién ahí
 * el refresh token se guarda en vic_kv `zoho_files_refresh_token`. Nunca se
 * devuelve ni se loguea; el principal no se toca ni se revoca (Zoho admite
 * varios refresh tokens vivos por cliente).
 *
 *   POST ?key=<cron>  body: { code, redirect_uri?, dry? }
 *   → { ok, scope[], faltan[], prueba_files: "ok"|"fallo:…", guardado }
 *
 * `dry:true` canjea y prueba pero NO guarda (el código igual se consume).
 */
import { NextResponse } from "next/server"
import { getFollowupCronSecret, setKvValue } from "@/lib/supabase-persistence-v3"
import { KV_FILES_REFRESH } from "@/lib/zoho-files-token"

export const dynamic = "force-dynamic"
export const maxDuration = 30

/** Los 9 del principal (leídos el 30-sep con vic-admin-zoho-scope) + ZohoFiles. */
export const SCOPES_REQUERIDOS = [
  "ZohoCRM.bulk.ALL",
  "ZohoCRM.coql.READ",
  "ZohoCRM.modules.ALL",
  "ZohoCRM.notifications.ALL",
  "ZohoCRM.org.ALL",
  "ZohoCRM.send_mail.all.CREATE",
  "ZohoCRM.settings.ALL",
  "ZohoCRM.templates.email.READ",
  "ZohoCRM.users.ALL",
  "ZohoFiles.files.ALL",
]

const env = (n: string) => (process.env[n] || "").trim()
const norm = (s: string) => s.trim().toLowerCase()

function cubre(concedidos: string[], requerido: string): boolean {
  const r = norm(requerido)
  const [mod, ...rest] = r.split(".")
  return concedidos.some((c) => {
    const n = norm(c)
    if (n === r) return true
    // "ZohoCRM.modules.ALL" cubre "ZohoCRM.modules.READ"; "ZohoFiles.files.ALL" cubre CREATE/READ.
    const [cm, ...crest] = n.split(".")
    if (cm !== mod) return false
    if (crest[crest.length - 1] === "all" && crest.slice(0, -1).join(".") === rest.slice(0, -1).join(".")) return true
    return false
  })
}

export async function POST(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const secreto = await getFollowupCronSecret()
  const dado = req.headers.get("x-cron-secret") || url.searchParams.get("key") || ""
  if (!secreto || dado !== secreto) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const body = (await req.json().catch(() => ({}))) as { code?: string; redirect_uri?: string; dry?: boolean }
  const code = String(body.code || "").trim()
  if (!code) return NextResponse.json({ ok: false, error: "falta code" }, { status: 400 })
  if (!env("ZOHO_CLIENT_ID") || !env("ZOHO_CLIENT_SECRET")) return NextResponse.json({ ok: false, error: "sin ZOHO_CLIENT_ID/SECRET en el entorno" }, { status: 500 })

  const domain = env("ZOHO_ACCOUNTS_DOMAIN") || "https://accounts.zoho.com"
  const form = new URLSearchParams({ grant_type: "authorization_code", client_id: env("ZOHO_CLIENT_ID"), client_secret: env("ZOHO_CLIENT_SECRET"), code })
  if (body.redirect_uri) form.set("redirect_uri", String(body.redirect_uri))
  const res = await fetch(`${domain}/oauth/v2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form, cache: "no-store" })
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>
  const refresh = String(j.refresh_token || "")
  const access = String(j.access_token || "")
  const scope = String(j.scope || "").split(/[ ,]+/).filter(Boolean).sort()
  if (!res.ok || !access) {
    return NextResponse.json({ ok: false, error: "canje rechazado por Zoho", detalle: j.error || j, pista: "el código dura 3-10 min y es de un solo uso; el client debe ser el MISMO del token principal" }, { status: 502 })
  }
  const faltan = SCOPES_REQUERIDOS.filter((r) => !cubre(scope, r))

  // Prueba real: subir 20 bytes a Zoho Files. Si el scope no alcanza, acá se ve.
  let prueba = "no_probada"
  try {
    const api = env("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"
    const fd = new FormData()
    fd.append("file", new Blob([Buffer.from("prueba scope ZohoFiles\n")], { type: "text/plain" }), "prueba-scope.txt")
    const up = await fetch(`${api}/crm/v3/files`, { method: "POST", headers: { Authorization: `Zoho-oauthtoken ${access}` }, body: fd, cache: "no-store" })
    const uj = (await up.json().catch(() => ({}))) as { data?: Array<{ code?: string; details?: { id?: string } }>; code?: string }
    prueba = up.ok && uj?.data?.[0]?.details?.id ? "ok" : `fallo:${uj?.data?.[0]?.code || uj?.code || up.status}`
  } catch (e) {
    prueba = `fallo:${e instanceof Error ? e.message : String(e)}`
  }

  const apto = !faltan.length && prueba === "ok" && Boolean(refresh)
  let guardado = false
  if (apto && !body.dry) {
    await setKvValue(KV_FILES_REFRESH, refresh)
    guardado = true
  }
  console.log(`[zoho-canje] scope=${scope.length} faltan=${faltan.length} prueba=${prueba} refresh=${refresh ? "sí" : "no"} guardado=${guardado}`)
  return NextResponse.json({
    ok: apto,
    scope,
    faltan,
    prueba_files: prueba,
    refresh_recibido: Boolean(refresh),
    guardado,
    nota: !refresh
      ? "Zoho no devolvió refresh_token: el código venía de un grant sin 'access_type=offline' o ya fue canjeado."
      : apto
        ? (body.dry ? "dry: no se guardó" : "guardado en vic_kv; el principal sigue intacto")
        : "NO se guardó: falta scope o la subida de prueba falló",
  })
}
