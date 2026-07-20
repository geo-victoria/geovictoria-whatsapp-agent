/**
 * Endpoint ADMIN: GET /api/vic-admin-botmaker-channels
 *
 * Lista los canales del workspace de Botmaker (id, plataforma, número) usando
 * el BOTMAKER_ACCESS_TOKEN del servidor. Uso: obtener el channelId de una
 * línea nueva (ej. la de Colombia) sin buscarlo a mano en la consola, y
 * verificar que comparte workspace/token con la línea chilena.
 *
 * Auth: x-cron-secret == vic_kv.followup_cron_secret (mismo esquema admin).
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const BM_TOKEN = (process.env.BOTMAKER_ACCESS_TOKEN || "").trim()

export async function GET(req: Request): Promise<Response> {
  const xcron = (req.headers.get("x-cron-secret") || "").trim()
  const expected = await getFollowupCronSecret().catch(() => "")
  if (!expected || xcron !== expected) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  if (!BM_TOKEN) {
    return NextResponse.json({ ok: false, error: "BOTMAKER_ACCESS_TOKEN no configurado" }, { status: 503 })
  }

  // ?messages=<contacto>: mensajes recientes de un chat (Botmaker guarda el
  // historial aunque nuestra base se haya limpiado — auditoría de bugs CO).
  // ?chats=1: lista de chats recientes del workspace.
  const url = new URL(req.url)
  const contacto = (url.searchParams.get("messages") || "").trim()
  if (contacto) {
    // La API pagina por workspace; from/to (ISO) acotan la ventana. El filtro
    // por contacto se hace del lado del cliente (la API no filtra confiable).
    const desde = (url.searchParams.get("from") || "").trim()
    const hasta = (url.searchParams.get("to") || "").trim()
    const qs = new URLSearchParams({ "chat-platform": "whatsapp", limit: "250" })
    if (desde) qs.set("from", desde)
    if (hasta) qs.set("to", hasta)
    const r = await fetch(`https://api.botmaker.com/v2.0/messages?${qs.toString()}`, {
      headers: { "access-token": BM_TOKEN, Accept: "application/json" },
      cache: "no-store",
    })
    const data = (await r.json().catch(() => ({}))) as {
      items?: Array<{ chat?: { contactId?: string; channelId?: string } }>
      nextPage?: string
    }
    // contacto="all" devuelve la página completa; si no, filtra por contactId.
    const items = (data.items || []).filter(
      (m) => contacto === "all" || (m.chat?.contactId || "") === contacto,
    )
    return NextResponse.json({ ok: r.ok, status: r.status, contacto, total_pagina: (data.items || []).length, items })
  }
  if (url.searchParams.get("chats")) {
    const r = await fetch("https://api.botmaker.com/v2.0/chats?limit=50", {
      headers: { "access-token": BM_TOKEN, Accept: "application/json" },
      cache: "no-store",
    })
    const data = await r.json().catch(() => ({}))
    return NextResponse.json({ ok: r.ok, status: r.status, data })
  }

  // ?get=/v2.0/<ruta>: passthrough de SOLO LECTURA a la API de Botmaker con el
  // token del servidor (auditar plantillas/variables/intents sin exponer el
  // token). Solo GET y solo rutas /v2.0/.
  const pass = (url.searchParams.get("get") || "").trim()
  if (pass) {
    if (!pass.startsWith("/v2.0/")) {
      return NextResponse.json({ ok: false, error: "solo rutas /v2.0/" }, { status: 400 })
    }
    const r = await fetch(`https://api.botmaker.com${pass}`, {
      headers: { "access-token": BM_TOKEN, Accept: "application/json" },
      cache: "no-store",
    })
    const data = await r.json().catch(() => ({}))
    return NextResponse.json({ ok: r.ok, status: r.status, path: pass, data })
  }

  const res = await fetch("https://api.botmaker.com/v2.0/channels", {
    headers: { "access-token": BM_TOKEN, Accept: "application/json" },
    cache: "no-store",
  })
  const data = await res.json().catch(() => ({}))
  return NextResponse.json({ ok: res.ok, status: res.status, data })
}
