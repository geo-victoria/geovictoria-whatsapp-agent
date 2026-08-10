/**
 * DESPACHADOR DE CRONES HUÉRFANOS (Lalo 10-ago, "arréglalo").
 *
 * Diagnóstico del 10-ago: `vic-espejo-notas-cron` (creado el 06-ago) nunca se
 * ejecutó. Prueba: al dispararlo a mano creó 64 notas atrasadas de una sola
 * vez, y en 3 horas de logs de Vercel aparece UNA invocación — la mía.
 * `vic-mudos-cron` (creado hoy) está igual. Los dos están declarados en
 * vercel.json, pero el cron scheduler de Vercel corre contra el deployment de
 * PRODUCCIÓN, que en este proyecto es la rama vieja `master`: ahí esos
 * endpoints no existen. Los crones que SÍ laten (callback, loop, ptv,
 * reactivation) los dispara un scheduler externo que apunta al alias de
 * vicky-v3 — y a ese scheduler nadie le agregó los dos nuevos.
 *
 * En vez de depender de que alguien registre cada endpoint nuevo a mano, los
 * crones huérfanos los despacha un cron que SÍ corre: `vic-ptv-cron` (cada 10
 * minutos, verificado en los logs). Cada job lleva su propia cadencia en
 * vic_kv (`huerfano_<nombre>`), se marca ANTES de disparar (dos ticks
 * solapados no lo mandan dos veces) y el disparo es best-effort con timeout
 * corto: la invocación remota es otra función, así que basta con que la
 * petición SALGA — este cron jamás espera a que el otro termine ni se cae si
 * el otro falla.
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const CRON_SECRET = (process.env.CRON_SECRET || "").trim()

/** Endpoints declarados en vercel.json que el scheduler real no dispara. */
export const JOBS_HUERFANOS: Array<{ nombre: string; path: string; cadaMin: number }> = [
  { nombre: "espejo_notas", path: "/api/vic-espejo-notas-cron", cadaMin: 15 },
  { nombre: "mudos", path: "/api/vic-mudos-cron", cadaMin: 30 },
]

/**
 * Margen = medio tick del cron que despacha (ptv corre cada 10'). Sin él, una
 * cadencia de 15' solo se cumpliría en el tick de los 20' (el de los 10' aún
 * no llega al umbral) y las notas quedarían el doble de viejas. Con 5' de
 * margen, un job de 15' se dispara en el tick de los 10'.
 */
const TOLERANCIA_MS = 5 * 60_000

function h(): Record<string, string> {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
  }
}

function baseUrl(): string {
  const prod = (process.env.VERCEL_PROJECT_PRODUCTION_URL || "").trim()
  const actual = (process.env.VERCEL_URL || "").trim()
  // OJO: VERCEL_PROJECT_PRODUCTION_URL apunta al deployment de master viejo,
  // donde estos endpoints no existen. Se usa el deployment ACTUAL (el que
  // está corriendo este cron) — es el de vicky-v3 por construcción.
  if (actual) return `https://${actual}`
  if (prod) return `https://${prod}`
  return "https://geovictoria-whatsapp-agent-git-vicky-v3-geo-victoria.vercel.app"
}

async function ultimaCorrida(nombre: string): Promise<number> {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_kv?key=eq.${encodeURIComponent(`huerfano_${nombre}`)}&select=value&limit=1`,
      { headers: h(), cache: "no-store" },
    )
    if (!r.ok) return 0
    const rows = (await r.json().catch(() => [])) as Array<{ value?: string }>
    const t = Date.parse(String(rows[0]?.value || ""))
    return Number.isFinite(t) ? t : 0
  } catch {
    return 0
  }
}

async function marcarCorrida(nombre: string, iso: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?on_conflict=key`, {
    method: "POST",
    headers: { ...h(), Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key: `huerfano_${nombre}`, value: iso }),
    cache: "no-store",
  }).catch(() => undefined)
}

/**
 * Despacha los crones huérfanos que ya cumplieron su cadencia. Devuelve los
 * nombres disparados en este tick. Nunca lanza: es un pasajero del tick de
 * otro cron y no puede tumbarlo.
 */
export async function despacharHuerfanos(): Promise<string[]> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return []
  const ahora = Date.now()
  const iso = new Date(ahora).toISOString()
  const disparados: string[] = []
  for (const job of JOBS_HUERFANOS) {
    try {
      const ultima = await ultimaCorrida(job.nombre)
      if (ultima && ahora - ultima < job.cadaMin * 60_000 - TOLERANCIA_MS) continue
      // Marcar ANTES de disparar: si el disparo se pierde, se reintenta en el
      // siguiente ciclo; si se marcara después, dos ticks solapados lo
      // mandarían dos veces (notas duplicadas, correos duplicados).
      await marcarCorrida(job.nombre, iso)
      const url = `${baseUrl()}${job.path}${job.path.includes("?") ? "&" : "?"}key=${encodeURIComponent(CRON_SECRET)}`
      const ctrl = new AbortController()
      const corte = setTimeout(() => ctrl.abort(), 5000)
      await fetch(url, {
        headers: { Authorization: `Bearer ${CRON_SECRET}`, "x-cron-secret": CRON_SECRET },
        cache: "no-store",
        signal: ctrl.signal,
      })
        .catch(() => undefined) // abort esperado: la invocación remota sigue viva
        .finally(() => clearTimeout(corte))
      disparados.push(job.nombre)
    } catch {
      /* best-effort: el siguiente tick reintenta */
    }
  }
  if (disparados.length) console.log(`[huerfanos] despachados: ${disparados.join(", ")}`)
  return disparados
}
