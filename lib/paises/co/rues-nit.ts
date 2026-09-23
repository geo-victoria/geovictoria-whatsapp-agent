/**
 * PADRÓN RUES POR NIT (23-sep, pregunta de Rodrigo "¿hay un listado de las
 * empresas en Colombia a partir del NIT?" — sí). Chile resuelve la razón
 * social desde el RUT con el SII y Perú desde el RUC con SUNAT; Colombia la
 * pedía al cliente porque no teníamos padrón. Este módulo lo cierra con el
 * dataset ABIERTO del Registro Único Empresarial y Social (Confecámaras) en
 * datos.gov.co — recurso `c82u-588k` "Personas Naturales, Personas Jurídicas y
 * Entidades Sin Ánimo de Lucro": 9,4 millones de matrículas, actualizado
 * semanalmente, con razón social, dígito de verificación, estado de la
 * matrícula, cámara de comercio y CIIU. Sin token; caché de 30 días en vic_kv.
 *
 * REGLA (la misma del SII, Lalo 10-ago): el padrón NO toca la conversación —
 * solo rellena la razón social al EMITIR (y, algún día, el formulario del
 * alta). Vicky no lo menciona ni confirma nombres con el cliente.
 */

import { normalizarNit } from "./nit.ts"

export type FichaNit = {
  nit: string
  dv?: string
  razonSocial: string
  estado?: string
  camara?: string
  ciiu?: string
  organizacionJuridica?: string
  fechaActualizacion?: string
}

const TIMEOUT_MS = 6000
const CACHE_DIAS = 30
const RECURSO = "https://www.datos.gov.co/resource/c82u-588k.json"

type FilaRues = Record<string, unknown>

function limpio(v: unknown): string | undefined {
  const s = String(v ?? "").replace(/\s+/g, " ").trim()
  return s && s !== "-" ? s : undefined
}

/**
 * Parser PURO (testeable sin red): un NIT tiene una matrícula por cámara y por
 * época — se prefiere la ACTIVA, luego la de categoría principal (sociedad /
 * persona jurídica, código "01") y, a igualdad, la actualizada más
 * recientemente. Solo filas con clase de identificación NIT.
 */
export function parsearFichaRues(nitCuerpo: string, filas: unknown): FichaNit | null {
  const lista = (Array.isArray(filas) ? filas : []) as FilaRues[]
  const candidatas = lista.filter((f) => {
    const clase = String(f.clase_identificacion || "").toUpperCase()
    const num = String(f.numero_identificacion || f.nit || "").replace(/\D/g, "")
    return num === nitCuerpo && (clase === "" || clase === "NIT") && limpio(f.razon_social)
  })
  if (!candidatas.length) return null
  const puntaje = (f: FilaRues): number => {
    let p = 0
    const estado = String(f.estado_matricula || "").toUpperCase()
    if (estado === "ACTIVA") p += 100
    else if (estado === "CANCELADA") p -= 50
    if (String(f.codigo_categoria_matricula || "") === "01") p += 20
    const anio = Number(f.ultimo_ano_renovado || 0)
    if (Number.isFinite(anio)) p += Math.min(10, Math.max(0, anio - 2015))
    return p
  }
  candidatas.sort((a, b) => {
    const d = puntaje(b) - puntaje(a)
    if (d !== 0) return d
    return String(b.fecha_actualizacion || "").localeCompare(String(a.fecha_actualizacion || ""))
  })
  const f = candidatas[0]
  const razon = limpio(f.razon_social)
  if (!razon) return null
  return {
    nit: nitCuerpo,
    dv: limpio(f.digito_verificacion),
    razonSocial: razon,
    estado: limpio(f.estado_matricula),
    camara: limpio(f.camara_comercio),
    ciiu: limpio(f.cod_ciiu_act_econ_pri),
    organizacionJuridica: limpio(f.organizacion_juridica),
    fechaActualizacion: limpio(f.fecha_actualizacion),
  }
}

export async function fichaNitRues(nitIn: string): Promise<FichaNit | null> {
  const canon = normalizarNit(String(nitIn || ""))
  if (!canon) return null
  const cuerpo = canon.split("-")[0]
  const key = `rues_nit_${cuerpo}`
  try {
    const { getKvValue } = await import("../../supabase-persistence-v3.ts")
    const raw = await getKvValue(key)
    if (raw) {
      const c = JSON.parse(raw) as FichaNit & { at?: string }
      const edad = c.at ? Date.now() - new Date(c.at).getTime() : Number.POSITIVE_INFINITY
      if (c.razonSocial && edad < CACHE_DIAS * 86400e3) return c
    }
  } catch { /* sin caché */ }
  let ficha: FichaNit | null = null
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS)
    const url = `${RECURSO}?numero_identificacion=${encodeURIComponent(cuerpo)}&$limit=50`
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (vicky)", Accept: "application/json" },
      cache: "no-store",
    })
    clearTimeout(t)
    if (r.ok) ficha = parsearFichaRues(cuerpo, await r.json())
    else console.warn(`[rues-nit] ${cuerpo} → HTTP ${r.status}`)
  } catch (e) {
    console.warn(`[rues-nit] ${cuerpo} falló:`, e instanceof Error ? e.message : e)
  }
  if (ficha) {
    try {
      const { setKvValue } = await import("../../supabase-persistence-v3.ts")
      await setKvValue(key, JSON.stringify({ ...ficha, at: new Date().toISOString() }))
    } catch { /* best-effort */ }
  }
  return ficha
}
