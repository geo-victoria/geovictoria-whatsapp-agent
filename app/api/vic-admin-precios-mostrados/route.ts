/**
 * ADMIN — ¿CUÁNTOS PRECIOS HA MOSTRADO VICKY? (pregunta de Lalo 10-sep).
 *
 * "Mostró precio" usa la MISMA señal que el dash y el criterio del caso C de
 * atribución (`fetchPreformAts` / vic-precio-mostrado): un mensaje de VICKY
 * con un bloque de precio. Las firmas canónicas son "Resumen mensual",
 * "Total mensual con IVA" y "UF + IVA al mes"; se agrega "Total mensual" a
 * secas porque los precios viejos (antes del 02-sep) salían con ese rótulo y
 * si no se cuenta, el histórico queda corto.
 *
 * Cuenta dos cosas distintas, que no hay que confundir:
 *   · MENSAJES con precio (cuántas veces Vicky mostró un precio), y
 *   · CONTACTOS únicos (a cuántas personas), que es el indicador "Vio precio"
 *     del dash.
 *
 * Excluye los contactos internos de métricas (mismo criterio del dash) y los
 * teléfonos sin país. Solo lectura, auth de cron.
 *
 * GET ?key=<cron>[&desde=YYYY-MM-DD][&paginas=<n>]
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { metricsContactSet, isTestContact } from "@/lib/funnel-analysis"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

const FIRMAS = ["Resumen mensual", "Total mensual con IVA", "UF + IVA al mes", "Total mensual"]

async function autorizado(req: Request): Promise<boolean> {
  const secreto = await getFollowupCronSecret().catch(() => "")
  const cron = (process.env.CRON_SECRET || "").trim()
  const url = new URL(req.url)
  const auth = req.headers.get("authorization") || ""
  const entregado =
    req.headers.get("x-cron-secret") || (auth.startsWith("Bearer ") ? auth.slice(7) : "") || url.searchParams.get("key") || ""
  return Boolean(entregado) && (entregado === secreto || (Boolean(cron) && entregado === cron))
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  if (!SUPABASE_URL || !SUPABASE_KEY) return NextResponse.json({ ok: false, error: "sin supabase" }, { status: 503 })
  const sp = new URL(req.url).searchParams
  const desde = (sp.get("desde") || "2026-01-01").trim()
  const paginas = Math.min(60, Math.max(1, Number(sp.get("paginas") || 40)))
  const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  // OJO: encodeURIComponent y NADA MÁS. Escapar además el % ("%20"→"%2520")
  // deja el patrón sin coincidencias y el conteo en cero (primer intento del
  // 10-sep). El "+" de "UF + IVA al mes" tiene que viajar como %2B.
  const orFirmas = FIRMAS.map((f) => `content.ilike.*${encodeURIComponent(f)}*`).join(",")

  // Mensajes de Vicky con bloque de precio, paginados de 1.000 en 1.000.
  type Fila = { conversation_id?: string; at?: string; content?: string }
  const filas: Fila[] = []
  for (let p = 0; p < paginas; p++) {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_v3_messages?role=eq.assistant&or=(${orFirmas})&at=gte.${desde}` +
        `&select=conversation_id,at,content&order=at.asc&limit=1000&offset=${p * 1000}`,
      { headers: h, cache: "no-store" },
    ).catch(() => null)
    if (!r?.ok) break
    const lote = ((await r.json().catch(() => [])) as Fila[]) || []
    filas.push(...lote)
    if (lote.length < 1000) break
  }

  // conversation_id → contacto (lotes de 200 ids).
  const ids = [...new Set(filas.map((f) => String(f.conversation_id || "")).filter(Boolean))]
  const contactoDe = new Map<string, string>()
  for (let i = 0; i < ids.length; i += 200) {
    const lote = ids.slice(i, i + 200).map((x) => `"${x}"`).join(",")
    const r = await fetch(`${SUPABASE_URL}/rest/v1/vic_v3_conversations?id=in.(${lote})&select=id,contact`, { headers: h, cache: "no-store" }).catch(() => null)
    if (!r?.ok) continue
    for (const c of ((await r.json().catch(() => [])) as Array<{ id: string; contact: string }>) || []) {
      contactoDe.set(String(c.id), String(c.contact || "").replace(/\D/g, ""))
    }
  }

  const internos = metricsContactSet()
  const PAISES: Record<string, string> = { "56": "Chile", "57": "Colombia", "52": "México", "51": "Perú" }
  const pais = (t: string) => PAISES[t.slice(0, 2)] || (t.startsWith("1") ? "otro" : "sin país")

  let mensajes = 0
  const porFirma = new Map<string, number>()
  const primeraVez = new Map<string, string>() // contacto → fecha del primer precio
  const porPais = new Map<string, Set<string>>()
  let descartadosInternos = 0
  let descartadosSinPais = 0
  for (const f of filas) {
    const tel = contactoDe.get(String(f.conversation_id || "")) || ""
    if (!tel) continue
    if (isTestContact(tel, internos)) { descartadosInternos++; continue }
    const p = pais(tel)
    if (p === "sin país") { descartadosSinPais++; continue }
    mensajes++
    const c = String(f.content || "")
    const firma = FIRMAS.find((x) => c.toLowerCase().includes(x.toLowerCase())) || "otra"
    porFirma.set(firma, (porFirma.get(firma) || 0) + 1)
    const at = String(f.at || "")
    if (!primeraVez.has(tel) || at < (primeraVez.get(tel) as string)) primeraVez.set(tel, at)
    const set = porPais.get(p) || new Set<string>()
    set.add(tel)
    porPais.set(p, set)
  }

  // Contactos NUEVOS con precio por mes (por su primera vez).
  const porMes = new Map<string, number>()
  for (const at of primeraVez.values()) {
    const mes = at.slice(0, 7)
    porMes.set(mes, (porMes.get(mes) || 0) + 1)
  }

  return NextResponse.json({
    ok: true,
    desde,
    paginasLeidas: Math.ceil(filas.length / 1000),
    firmas: FIRMAS,
    mensajesConPrecio: mensajes,
    contactosConPrecio: primeraVez.size,
    porMesContactosNuevos: Object.fromEntries([...porMes.entries()].sort()),
    porPaisContactos: Object.fromEntries([...porPais.entries()].map(([k, v]) => [k, v.size])),
    porFirmaMensajes: Object.fromEntries([...porFirma.entries()].sort((a, b) => b[1] - a[1])),
    descartados: { internos: descartadosInternos, sinPais: descartadosSinPais },
    truncado: filas.length >= paginas * 1000,
  })
}
