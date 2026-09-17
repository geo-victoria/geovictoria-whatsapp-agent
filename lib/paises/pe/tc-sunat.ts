/**
 * Tipo de cambio USD → PEN según SUNAT (decisión Lalo 17-sep: "dejemos el dólar
 * según SUNAT"). Se usa para cotizar EN SOLES, de cara al cliente, el hardware
 * cuyo precio de lista está en DÓLARES (artículos [PER] de Books: reloj 304
 * arriendo US$24/mes · venta US$90). Los documentos internos (NDV, Books)
 * siguen en USD como siempre; la conversión existe solo para el chat, el PDF
 * y el checkout del cliente.
 *
 * Fuente primaria: el archivo público de SUNAT (una línea "dd/mm/aaaa|compra|venta|").
 * Respaldo: apis.net.pe (replica la misma tabla). Último recurso: env
 * `VICKY_PE_TC_USD` (fijo) y, si no existe, `TC_USD_PEN_FALLBACK`.
 *
 * Se usa el dólar VENTA (lo que paga quien compra dólares para pagarnos el
 * equipo importado), que es el que SUNAT publica como referencia de facturación.
 *
 * Caché en vic_kv `tc_sunat_<fecha>` (best-effort): SUNAT publica un valor por
 * día, así que dentro del mismo día todas las cotizaciones usan el mismo.
 */

export type TipoCambioSunat = {
  /** Dólar venta SUNAT (soles por dólar). */
  venta: number
  compra: number
  /** yyyy-mm-dd de la publicación. */
  fecha: string
  fuente: "sunat" | "apis.net.pe" | "cache" | "env" | "fallback"
}

/** Último recurso si ninguna fuente responde (sep-2026 ≈ 3,37). Revisar al año. */
export const TC_USD_PEN_FALLBACK = 3.4

const SUNAT_TXT = "https://www.sunat.gob.pe/a/txt/tipoCambio.txt"
const APIS_NET_PE = "https://api.apis.net.pe/v1/tipo-cambio-sunat"
const TIMEOUT_MS = 6000

function hoyLima(): string {
  // Perú no tiene horario de verano: UTC-5 fijo.
  return new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/** "17/09/2026|3.361|3.372|" → { fecha, compra, venta }. Exportada para test. */
export function parsearTxtSunat(txt: string): { fecha: string; compra: number; venta: number } | null {
  const linea = String(txt || "").trim().split(/\r?\n/).find((l) => l.includes("|")) || ""
  const [f, c, v] = linea.split("|").map((s) => s.trim())
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(f || "")
  const compra = Number(c)
  const venta = Number(v)
  if (!m || !Number.isFinite(compra) || !Number.isFinite(venta) || venta <= 0) return null
  return { fecha: `${m[3]}-${m[2]}-${m[1]}`, compra, venta }
}

function plausible(tc: number): boolean {
  // Un dólar fuera de 2,5–6 soles es un error de lectura, no un tipo de cambio.
  return Number.isFinite(tc) && tc >= 2.5 && tc <= 6
}

async function fetchConTimeout(url: string): Promise<string> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "Mozilla/5.0 (vicky)" }, cache: "no-store" })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.text()
  } finally {
    clearTimeout(t)
  }
}

async function leerCache(key: string): Promise<TipoCambioSunat | null> {
  try {
    const { getKvValue } = await import("../../supabase-persistence-v3.ts")
    const raw = await getKvValue(key)
    if (!raw) return null
    const j = JSON.parse(raw) as TipoCambioSunat
    return plausible(Number(j?.venta)) ? { ...j, fuente: "cache" } : null
  } catch {
    return null
  }
}

async function escribirCache(key: string, tc: TipoCambioSunat): Promise<void> {
  try {
    const { setKvValue } = await import("../../supabase-persistence-v3.ts")
    await setKvValue(key, JSON.stringify(tc))
  } catch {
    /* best-effort */
  }
}

/**
 * Dólar venta SUNAT del día. Nunca lanza: si todo falla devuelve el fallback
 * (env o constante) con `fuente` explícita, para que quien cotiza pueda
 * loguearlo y el equipo lo vea.
 */
export async function tipoCambioSunat(): Promise<TipoCambioSunat> {
  const envFijo = Number((process.env.VICKY_PE_TC_USD || "").replace(",", "."))
  if (plausible(envFijo) && (process.env.VICKY_PE_TC_USD_FORZAR || "").trim() === "1") {
    return { venta: envFijo, compra: envFijo, fecha: hoyLima(), fuente: "env" }
  }
  const key = `tc_sunat_${hoyLima()}`
  const cache = await leerCache(key)
  if (cache) return cache

  // 1. SUNAT directo.
  try {
    const p = parsearTxtSunat(await fetchConTimeout(SUNAT_TXT))
    if (p && plausible(p.venta)) {
      const tc: TipoCambioSunat = { ...p, fuente: "sunat" }
      await escribirCache(key, tc)
      return tc
    }
  } catch (e) {
    console.warn(`[tc-sunat] SUNAT no respondió: ${(e as Error).message}`)
  }
  // 2. Réplica.
  try {
    const j = JSON.parse(await fetchConTimeout(APIS_NET_PE)) as { compra?: number; venta?: number; fecha?: string }
    const venta = Number(j?.venta)
    if (plausible(venta)) {
      const tc: TipoCambioSunat = {
        venta,
        compra: Number(j?.compra) || venta,
        fecha: String(j?.fecha || hoyLima()).slice(0, 10),
        fuente: "apis.net.pe",
      }
      await escribirCache(key, tc)
      return tc
    }
  } catch (e) {
    console.warn(`[tc-sunat] apis.net.pe no respondió: ${(e as Error).message}`)
  }
  // 3. Fallbacks.
  if (plausible(envFijo)) return { venta: envFijo, compra: envFijo, fecha: hoyLima(), fuente: "env" }
  console.error(`[tc-sunat] sin fuente de tipo de cambio: se usa el fallback ${TC_USD_PEN_FALLBACK}`)
  return { venta: TC_USD_PEN_FALLBACK, compra: TC_USD_PEN_FALLBACK, fecha: hoyLima(), fuente: "fallback" }
}

/** USD → soles ENTEROS (un precio de reloj con céntimos se ve raro en un chat). */
export function usdASoles(usd: number, tcVenta: number): number {
  return Math.round(usd * tcVenta)
}
