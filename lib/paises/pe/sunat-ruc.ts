/**
 * PADRÓN SUNAT POR RUC (22-sep, Lalo "¿por qué me pide razón social? en Chile
 * no la pide"). Chile resuelve la razón social desde el RUT con el padrón del
 * SII; Perú la pedía al cliente porque no teníamos padrón. Este módulo lo
 * cierra con la consulta pública de apis.net.pe (v1, sin token — la misma
 * fuente de respaldo del dólar SUNAT), con caché de 30 días en vic_kv.
 *
 * REGLA (la misma del SII, Lalo 10-ago): el padrón NO toca la conversación —
 * solo rellena la razón social al EMITIR (y, algún día, el formulario del
 * alta). Vicky no lo menciona ni confirma nombres con el cliente.
 */

export type FichaRuc = {
  ruc: string
  razonSocial: string
  estado?: string
  condicion?: string
  direccion?: string
  distrito?: string
  provincia?: string
  departamento?: string
}

const TIMEOUT_MS = 6000
const CACHE_DIAS = 30

/** Parser PURO de la respuesta de apis.net.pe v1 (testeable sin red). */
export function parsearFichaSunat(ruc: string, json: unknown): FichaRuc | null {
  const j = (json || {}) as Record<string, unknown>
  const nombre = String(j.nombre || "").replace(/\s+/g, " ").trim()
  if (!nombre) return null
  const limpio = (v: unknown) => {
    const s = String(v || "").replace(/\s+/g, " ").trim()
    return s && s !== "-" ? s : undefined
  }
  return {
    ruc,
    razonSocial: nombre,
    estado: limpio(j.estado),
    condicion: limpio(j.condicion),
    direccion: limpio(j.direccion),
    distrito: limpio(j.distrito),
    provincia: limpio(j.provincia),
    departamento: limpio(j.departamento),
  }
}

export async function fichaRucSunat(rucIn: string): Promise<FichaRuc | null> {
  const ruc = String(rucIn || "").replace(/\D/g, "")
  if (!/^\d{11}$/.test(ruc)) return null
  const key = `sunat_ruc_${ruc}`
  try {
    const { getKvValue } = await import("../../supabase-persistence-v3.ts")
    const raw = await getKvValue(key)
    if (raw) {
      const c = JSON.parse(raw) as FichaRuc & { at?: string }
      const edad = c.at ? Date.now() - new Date(c.at).getTime() : Number.POSITIVE_INFINITY
      if (c.razonSocial && edad < CACHE_DIAS * 86400e3) return c
    }
  } catch { /* sin caché */ }
  let ficha: FichaRuc | null = null
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS)
    const r = await fetch(`https://api.apis.net.pe/v1/ruc?numero=${ruc}`, {
      signal: ctl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (vicky)" },
      cache: "no-store",
    })
    clearTimeout(t)
    if (r.ok) ficha = parsearFichaSunat(ruc, await r.json())
    else console.warn(`[sunat-ruc] ${ruc} → HTTP ${r.status}`)
  } catch (e) {
    console.warn(`[sunat-ruc] ${ruc} falló:`, e instanceof Error ? e.message : e)
  }
  if (ficha) {
    try {
      const { setKvValue } = await import("../../supabase-persistence-v3.ts")
      await setKvValue(key, JSON.stringify({ ...ficha, at: new Date().toISOString() }))
    } catch { /* best-effort */ }
  }
  return ficha
}
