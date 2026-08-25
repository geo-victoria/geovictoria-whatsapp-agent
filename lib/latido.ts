/**
 * Latido de crones (Lalo 08-ago noche): todo el proceso comercial vive en
 * los crones (traspasos, loop de toques, seguimientos, cadencia outbound) y
 * hasta hoy un cron muerto no avisaba a nadie — así murió el despachador de
 * llamadas el 24-jul: en silencio, y se descubrió semanas después.
 *
 * Cada cron ESTAMPA su latido (vic_kv latido_<nombre>) al terminar un tick
 * exitoso, y los dos crones más frecuentes VIGILAN los latidos de todos los
 * demás: un latido con más de 30 minutos de atraso en horario hábil CL
 * dispara UNA alerta interna por hora (kv guard con TTL). La vigilancia es
 * cruzada a propósito — un cron muerto no puede reportarse a sí mismo.
 *
 * Best-effort integral: nada de esto puede afectar el tick del cron.
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

/** Crones vigilados. El nombre es la clave kv (latido_<nombre>).
 * OJO: "followup" se RETIRÓ el 25-ago — vic-followup-cron se eliminó en la
 * demolición del 12-ago y el vigía llevaba 13 días alertando cada hora hábil
 * por un cron que ya no existe (falso positivo permanente). Al retirar un
 * cron: sacarlo también de esta lista y borrar su vic_kv latido_<nombre>. */
export const CRONES_VIGILADOS = ["ptv", "loop", "outbound"] as const
export type CronVigilado = (typeof CRONES_VIGILADOS)[number]

const ATRASO_MAX_MS = 30 * 60_000

function h(): Record<string, string> {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
  }
}

/** Estampa el latido del cron. Llamar al FINAL de un tick exitoso. */
export async function estamparLatido(nombre: CronVigilado): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return
  await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?on_conflict=key`, {
    method: "POST",
    headers: { ...h(), Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key: `latido_${nombre}`, value: new Date().toISOString() }),
    cache: "no-store",
  }).catch(() => undefined)
}

/** Horario hábil CL simple (L-V 8-19 Santiago): fuera de él los crones pueden
 * espaciarse sin que sea una emergencia, y nadie quiere alertas a las 3 AM. */
function habilCL(ahora: Date): boolean {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Santiago",
    hour: "numeric",
    hour12: false,
    weekday: "short",
  }).formatToParts(ahora)
  const dia = p.find((x) => x.type === "weekday")?.value || ""
  const hora = Number(p.find((x) => x.type === "hour")?.value || 0) % 24
  return !["Sat", "Sun"].includes(dia) && hora >= 8 && hora < 19
}

/**
 * Vigila los latidos de los DEMÁS crones (nunca el propio). Devuelve la
 * cantidad de alertas emitidas. Un cron sin latido registrado aún no alerta
 * (recién desplegado); alerta solo el que ALGUNA VEZ latió y se calló.
 */
export async function vigilarLatidos(propio: CronVigilado): Promise<number> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return 0
  const ahora = new Date()
  if (!habilCL(ahora)) return 0
  const otros = CRONES_VIGILADOS.filter((c) => c !== propio)
  const keys = [...otros.map((c) => `latido_${c}`), ...otros.map((c) => `latido_alerta_${c}`)]
  let filas: Array<{ key: string; value: string; expires_at?: string | null }> = []
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_kv?key=in.(${keys.map((k) => `"${k}"`).join(",")})&select=key,value,expires_at`,
      { headers: h(), cache: "no-store" },
    )
    if (!res.ok) return 0
    filas = ((await res.json().catch(() => [])) as typeof filas) || []
  } catch {
    return 0
  }
  const valor = new Map(
    filas
      .filter((f) => !f.expires_at || Date.parse(f.expires_at) > ahora.getTime())
      .map((f) => [f.key, f.value]),
  )
  let alertas = 0
  for (const cron of otros) {
    const ultimo = Date.parse(valor.get(`latido_${cron}`) || "")
    if (!Number.isFinite(ultimo)) continue // nunca latió: aún no vigilable
    if (ahora.getTime() - ultimo < ATRASO_MAX_MS) continue
    if (valor.has(`latido_alerta_${cron}`)) continue // ya alertado esta hora
    const min = Math.round((ahora.getTime() - ultimo) / 60_000)
    const { avisarEquipoInterno } = await import("./alerta-interna")
    await avisarEquipoInterno(
      `💔 CRON MUDO: vic-${cron === "outbound" ? "outbound-cadence" : cron}-cron no registra un tick exitoso hace ${min} minutos (en horario hábil). El proceso comercial depende de él — revisar los logs de Vercel AHORA. (Así murió el despachador de llamadas el 24-jul, en silencio.)`,
    ).catch(() => {})
    await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?on_conflict=key`, {
      method: "POST",
      headers: { ...h(), Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        key: `latido_alerta_${cron}`,
        value: ahora.toISOString(),
        expires_at: new Date(ahora.getTime() + 60 * 60_000).toISOString(),
      }),
      cache: "no-store",
    }).catch(() => undefined)
    alertas++
  }
  return alertas
}
