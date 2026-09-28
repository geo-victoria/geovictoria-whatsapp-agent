/**
 * ADMIN — consumo y costo de Anthropic (28-sep, Lalo: "¿hay alguna API de
 * Anthropic para ir a buscar la data del consumo diario, del caché, etc?").
 *
 * SOLO LECTURA. Llama a la Usage & Cost Admin API con ANTHROPIC_ADMIN_KEY
 * (Admin API key `sk-ant-admin01-…`, distinta de la key del agente) y devuelve
 * por día y por modelo los tokens de entrada sin caché, escritura de caché,
 * lectura de caché y salida, más el costo en USD que Anthropic reporta.
 *
 * Para qué: saber si el caché del prompt pega (hallazgo 01 del informe de
 * Omar) y medir el antes/después de cada cambio de prompt con la factura real,
 * no con estimaciones. La llave jamás sale en la respuesta.
 *
 * GET ?key=<cron>&dias=30            → resumen por modelo + tabla diaria
 *     &crudo=1                       → además la respuesta cruda de Anthropic
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

const API = "https://api.anthropic.com/v1/organizations"

async function autorizado(req: Request): Promise<boolean> {
  const secreto = await getFollowupCronSecret()
  const url = new URL(req.url)
  const auth = req.headers.get("authorization") || ""
  const entregado =
    req.headers.get("x-cron-secret") || (auth.startsWith("Bearer ") ? auth.slice(7) : "") || url.searchParams.get("key") || ""
  return Boolean(secreto) && entregado === secreto
}

type BucketUso = {
  starting_at: string
  ending_at: string
  results: Array<{
    model?: string | null
    uncached_input_tokens?: number
    cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    output_tokens?: number
  }>
}

type BucketCosto = {
  starting_at: string
  ending_at: string
  results: Array<{ description?: string | null; model?: string | null; amount?: string | number; currency?: string; cost_type?: string }>
}

async function paginar<T>(adminKey: string, base: URL): Promise<{ data: T[]; error?: string }> {
  const out: T[] = []
  let page: string | null = null
  for (let i = 0; i < 20; i++) {
    const u = new URL(base.toString())
    if (page) u.searchParams.set("page", page)
    const r = await fetch(u, {
      headers: {
        "x-api-key": adminKey,
        "anthropic-version": "2023-06-01",
        "User-Agent": "VickyGeoVictoria/1.0 (costo-anthropic)",
      },
    })
    const j = (await r.json().catch(() => ({}))) as { data?: T[]; has_more?: boolean; next_page?: string | null; error?: { message?: string } }
    if (!r.ok) return { data: out, error: `${r.status} ${j?.error?.message || JSON.stringify(j).slice(0, 200)}` }
    out.push(...(j.data || []))
    if (!j.has_more || !j.next_page) break
    page = j.next_page
  }
  return { data: out }
}

function isoDia(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const adminKey = (process.env.ANTHROPIC_ADMIN_KEY || "").trim()
  if (!adminKey) {
    return NextResponse.json(
      { ok: false, error: "falta ANTHROPIC_ADMIN_KEY (env de Vercel, entornos Production y Preview; requiere redeploy)" },
      { status: 503 },
    )
  }
  const url = new URL(req.url)
  const dias = Math.min(31, Math.max(1, Number(url.searchParams.get("dias") || 30) || 30))
  const crudo = url.searchParams.get("crudo") === "1"

  const hasta = new Date()
  hasta.setUTCHours(0, 0, 0, 0)
  hasta.setUTCDate(hasta.getUTCDate() + 1) // incluye el día de hoy (parcial)
  const desde = new Date(hasta)
  desde.setUTCDate(desde.getUTCDate() - dias)

  const usoUrl = new URL(`${API}/usage_report/messages`)
  usoUrl.searchParams.set("starting_at", desde.toISOString())
  usoUrl.searchParams.set("ending_at", hasta.toISOString())
  usoUrl.searchParams.set("bucket_width", "1d")
  usoUrl.searchParams.append("group_by[]", "model")
  usoUrl.searchParams.set("limit", "31")

  const costoUrl = new URL(`${API}/cost_report`)
  costoUrl.searchParams.set("starting_at", desde.toISOString())
  costoUrl.searchParams.set("ending_at", hasta.toISOString())
  costoUrl.searchParams.append("group_by[]", "description")
  costoUrl.searchParams.set("limit", "31")

  const [uso, costo] = await Promise.all([paginar<BucketUso>(adminKey, usoUrl), paginar<BucketCosto>(adminKey, costoUrl)])

  // Agregados por modelo (todo el rango) y por día (todos los modelos).
  type Acum = { sinCache: number; cacheWrite: number; cacheRead: number; out: number; llamadasAprox?: number }
  const nuevo = (): Acum => ({ sinCache: 0, cacheWrite: 0, cacheRead: 0, out: 0 })
  const porModelo: Record<string, Acum> = {}
  const porDia: Record<string, Acum & { modelos: Record<string, Acum> }> = {}
  for (const b of uso.data) {
    const dia = isoDia(new Date(b.starting_at))
    porDia[dia] ||= { ...nuevo(), modelos: {} }
    for (const r of b.results || []) {
      const m = r.model || "(sin modelo)"
      const cw =
        (r.cache_creation?.ephemeral_5m_input_tokens || 0) +
        (r.cache_creation?.ephemeral_1h_input_tokens || 0) +
        (r.cache_creation_input_tokens || 0)
      const fila: Acum = {
        sinCache: r.uncached_input_tokens || 0,
        cacheWrite: cw,
        cacheRead: r.cache_read_input_tokens || 0,
        out: r.output_tokens || 0,
      }
      for (const dest of [porModelo[m] ||= nuevo(), porDia[dia], porDia[dia].modelos[m] ||= nuevo()]) {
        dest.sinCache += fila.sinCache
        dest.cacheWrite += fila.cacheWrite
        dest.cacheRead += fila.cacheRead
        dest.out += fila.out
      }
    }
  }
  const conTasa = (a: Acum) => {
    const entrada = a.sinCache + a.cacheWrite + a.cacheRead
    return {
      ...a,
      entradaTotal: entrada,
      pctLeidoDeCache: entrada ? Math.round((a.cacheRead / entrada) * 1000) / 10 : 0,
      pctEscritoEnCache: entrada ? Math.round((a.cacheWrite / entrada) * 1000) / 10 : 0,
    }
  }

  // Costo: Anthropic lo reporta en centavos (string decimal) por descripción.
  const costoPorDia: Record<string, number> = {}
  const costoPorDescripcion: Record<string, number> = {}
  let costoTotalUsd = 0
  for (const b of costo.data) {
    const dia = isoDia(new Date(b.starting_at))
    for (const r of b.results || []) {
      const usd = Number(r.amount || 0) / 100
      costoTotalUsd += usd
      costoPorDia[dia] = (costoPorDia[dia] || 0) + usd
      const d = r.description || r.model || r.cost_type || "(sin descripción)"
      costoPorDescripcion[d] = (costoPorDescripcion[d] || 0) + usd
    }
  }
  const redondear = (n: number) => Math.round(n * 100) / 100

  const dias_ordenados = Object.keys(porDia).sort()
  return NextResponse.json({
    ok: !uso.error && !costo.error,
    rango: { desde: desde.toISOString(), hasta: hasta.toISOString(), dias },
    errores: { uso: uso.error || null, costo: costo.error || null },
    costoTotalUsd: redondear(costoTotalUsd),
    costoPromedioDiaUsd: dias_ordenados.length ? redondear(costoTotalUsd / dias_ordenados.length) : 0,
    costoPorDescripcionUsd: Object.fromEntries(
      Object.entries(costoPorDescripcion)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => [k, redondear(v)]),
    ),
    porModelo: Object.fromEntries(Object.entries(porModelo).map(([k, v]) => [k, conTasa(v)])),
    porDia: dias_ordenados.map((d) => ({
      dia: d,
      costoUsd: redondear(costoPorDia[d] || 0),
      ...conTasa(porDia[d]),
      modelos: Object.fromEntries(Object.entries(porDia[d].modelos).map(([k, v]) => [k, conTasa(v)])),
    })),
    lectura:
      "pctLeidoDeCache bajo con pctEscritoEnCache alto = el prefijo se reescribe en cada request (caché roto). Con caché sano la lectura domina y la escritura es marginal.",
    ...(crudo ? { crudo: { uso: uso.data, costo: costo.data } } : {}),
  })
}
