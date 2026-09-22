/**
 * REGISTRO DE PROACTIVIDAD QUE NO SALIÓ (13-sep, pregunta de Lalo "¿tienes
 * cómo ver toda la comunicación proactiva que ha fallado?").
 *
 * Hasta hoy la respuesta era no: el ÉXITO se anotaba en tres lugares (tqlog_
 * del loop, kv de campaña, vic_campanas) y el FALLO en ninguno — solo un
 * console.error que Vercel guarda ~3 días y un `ok:false` dentro del JSON del
 * cron, que nadie persiste. Los 6 envíos caídos de la campaña de los 300 se
 * supieron porque alguien estaba mirando la respuesta en vivo.
 *
 * Esto vive en vic_kv (`envio_fallido_<ts>_<contacto>`, TTL 30 días) por la
 * misma razón que tqlog: no exige migración y el lector es una consulta por
 * prefijo. Si algún día el volumen lo pide, la tabla propia es un rename.
 *
 * LÍMITE QUE HAY QUE DECIR SIEMPRE: esto registra lo que Botmaker RECHAZA.
 * Un 202 suyo significa "encargo aceptado", no "entregado": una plantilla en
 * revisión, el pacing de Meta o el tope de 2 mensajes de marketing en 24 h se
 * ven como éxito desde acá. Ese hueco no lo cierra este archivo.
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "")
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ""

const DIAS_RETENCION = 30

export type EnvioFallido = {
  /** Teléfono destino, solo dígitos. */
  c: string
  /** "plantilla" | "texto" | "intent" */
  tipo: string
  /** Nombre de la plantilla o del intent (vacío en texto libre). */
  tpl?: string
  /** Número de la línea por la que salía. */
  linea?: string
  /** Por qué no salió: sin_token, sin_canal, http_<status>, excepcion, … */
  motivo: string
  /** Respuesta de Botmaker recortada, que es donde vive el porqué real. */
  detalle?: string
  at: string
}

/**
 * Anota un envío que NO salió. Best-effort y sin await obligatorio: jamás
 * puede tumbar ni demorar el camino del envío (el llamador ya devolvió false).
 */
export async function registrarEnvioFallido(f: Omit<EnvioFallido, "at">): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return
  const contacto = String(f.c || "").replace(/\D/g, "") || "sin_contacto"
  const fila: EnvioFallido = {
    ...f,
    c: contacto,
    detalle: f.detalle ? String(f.detalle).slice(0, 300) : undefined,
    at: new Date().toISOString(),
  }
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?on_conflict=key`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        key: `envio_fallido_${Date.now()}_${contacto}`,
        value: JSON.stringify(fila),
        expires_at: new Date(Date.now() + DIAS_RETENCION * 24 * 3600e3).toISOString(),
      }),
      cache: "no-store",
    })
  } catch {
    /* best-effort: el registro del fallo jamás provoca otro fallo */
  }
}

/** Lee los fallos de los últimos `dias` (default 7), más nuevos primero. */
export async function leerEnviosFallidos(dias = 7): Promise<EnvioFallido[]> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return []
  const corte = Date.now() - Math.max(1, dias) * 24 * 3600e3
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_kv?key=like.envio_fallido_*&select=key,value&limit=5000`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store" },
  ).catch(() => null)
  if (!r || !r.ok) return []
  const filas = ((await r.json().catch(() => [])) as Array<{ key: string; value: string }>) || []
  const out: EnvioFallido[] = []
  for (const f of filas) {
    // El timestamp va en la CLAVE: filtrar por ahí evita parsear los 5.000.
    const ts = Number(String(f.key).split("_")[2] || 0)
    if (!ts || ts < corte) continue
    try {
      out.push(JSON.parse(f.value) as EnvioFallido)
    } catch {
      /* fila ilegible: se ignora, no se pierde el resto */
    }
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1))
}
