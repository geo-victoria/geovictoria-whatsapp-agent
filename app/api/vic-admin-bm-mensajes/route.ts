import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const runtime = "nodejs"
export const maxDuration = 60

/**
 * SONDA de la API de mensajes de Botmaker (SOLO LECTURA, admin).
 *
 * Existe para responder con DATOS una pregunta que hoy contestamos por
 * suposición: cuando `sendBotmakerTemplate` recibe un 202 ("encargo aceptado"),
 * ¿queda rastro de que el mensaje realmente SALIÓ? Sin mirar la forma real de
 * la respuesta no se puede construir el verificador de entregas encima.
 *
 * `?contact=569…` filtra a un contacto · `?horas=` mueve la ventana (default 24)
 * · `?crudo=1` devuelve los items tal cual para inspeccionar los campos.
 */
export async function GET(req: Request): Promise<Response> {
  const sp = new URL(req.url).searchParams
  const key = (sp.get("key") || req.headers.get("x-cron-secret") || "").trim()
  const secreto = (process.env.FOLLOWUP_CRON_SECRET || "").trim() || (await getFollowupCronSecret().catch(() => "")) || ""
  if (!key || !secreto || key !== secreto) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })

  const token = (process.env.BOTMAKER_ACCESS_TOKEN || process.env.BM_ACCESS_TOKEN || "").trim()
  if (!token) return NextResponse.json({ ok: false, error: "sin BOTMAKER_ACCESS_TOKEN" }, { status: 503 })

  // SONDA GENÉRICA DE SOLO LECTURA (`?ruta=/v2.0/...`): sirve para descubrir qué
  // expone la API de Botmaker sin desplegar un endpoint por cada intento — en
  // particular si la configuración de WEBHOOKS es accesible con el token que ya
  // tenemos, que evitaría pedir credenciales del panel. Solo GET, y la ruta
  // debe empezar con /v2.0/ (nada de escribir ni de salir del host).
  const ruta = (sp.get("ruta") || "").trim()
  if (ruta) {
    if (!/^\/v[0-9.]+\//.test(ruta)) {
      return NextResponse.json({ ok: false, error: "ruta debe empezar con /v2.0/" }, { status: 400 })
    }
    const r = await fetch(`https://api.botmaker.com${ruta}`, {
      headers: { "access-token": token, Accept: "application/json" },
      cache: "no-store",
    })
    const texto = await r.text().catch(() => "")
    let json: unknown = null
    try { json = JSON.parse(texto) } catch { /* no era JSON */ }
    return NextResponse.json({ ok: r.ok, status: r.status, ruta, json: json ?? undefined, texto: json ? undefined : texto.slice(0, 1500) })
  }

  const contacto = (sp.get("contact") || "").replace(/\D/g, "")
  const horas = Math.min(Math.max(Number(sp.get("horas")) || 24, 1), 168)
  const desde = new Date(Date.now() - horas * 3600e3).toISOString()

  const items: Array<Record<string, unknown>> = []
  // `?extra=clave=valor&otra=1` se pega tal cual a la query — existe para
  // cazar el parámetro que habilita la búsqueda de largo plazo (Botmaker
  // responde 400 LONG_TERM_SEARCH_PARAM_REQUIRED más allá de ~72 h) sin
  // redeployar por cada intento.
  const extra = (sp.get("extra") || "").trim()
  let url = `https://api.botmaker.com/v2.0/messages?chat-platform=whatsapp&limit=250&from=${encodeURIComponent(desde)}&pag=true${extra ? `&${extra}` : ""}`
  const t0 = Date.now()
  for (let page = 0; page < 12 && url && Date.now() - t0 < 40_000; page++) {
    const r = await fetch(url, { headers: { "access-token": token, Accept: "application/json" }, cache: "no-store" })
    if (!r.ok) return NextResponse.json({ ok: false, error: `botmaker ${r.status}`, detalle: (await r.text().catch(() => "")).slice(0, 400) }, { status: 502 })
    const data = (await r.json().catch(() => ({}))) as { items?: Array<Record<string, unknown>>; nextPage?: string }
    items.push(...(Array.isArray(data.items) ? data.items : []))
    url = String(data.nextPage || "")
    if (!Array.isArray(data.items) || data.items.length === 0) break
  }

  const delContacto = contacto
    ? items.filter((m) => String((m.chat as { contactId?: string } | undefined)?.contactId || "") === contacto)
    : items

  // Qué valores toma `from` (¿hay uno para lo que sale de nosotros?) y qué
  // claves trae cada item — eso es lo que decide si se puede verificar entrega.
  const porFrom: Record<string, number> = {}
  const claves = new Set<string>()
  for (const m of items) {
    porFrom[String(m.from ?? "?")] = (porFrom[String(m.from ?? "?")] || 0) + 1
    for (const k of Object.keys(m)) claves.add(k)
  }

  return NextResponse.json({
    ok: true,
    ventanaHoras: horas,
    total: items.length,
    porFrom,
    claves: [...claves].sort(),
    delContacto: delContacto.length,
    muestra: sp.get("crudo") === "1" ? delContacto.slice(0, 8) : delContacto.slice(0, 8).map((m) => ({
      from: m.from,
      creationTime: m.creationTime,
      contactId: (m.chat as { contactId?: string } | undefined)?.contactId,
      channelId: (m.chat as { channelId?: string } | undefined)?.channelId,
    })),
  })
}
