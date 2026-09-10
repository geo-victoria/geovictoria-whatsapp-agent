/**
 * CONVERSACIONES CON PRECIO MOSTRADO **Y** RUT CONOCIDO.
 *
 * Es el universo que Lalo quiere garantizado en el CRM (10-sep): "toda
 * conversación con precio mostrado y rut tenga su deal correspondiente con su
 * data actualizada hasta el hito que llegó". Vive acá para que el contador de
 * precios y el reconciliador midan EXACTAMENTE lo mismo.
 *
 * · PRECIO = mensaje de Vicky con bloque de precio (las firmas del dash).
 * · RUT = RUT con dígito verificador válido escrito por el CLIENTE, no por
 *   Vicky (lo que ella repite puede venir de la ficha SII y no del cliente).
 */

import { normalizarRut, rutValido } from "./rut"

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const H = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }

export const FIRMAS_PRECIO = ["Resumen mensual", "Total mensual con IVA", "UF + IVA al mes", "Total mensual"]
const RUT_RE = /\b(\d{1,2}[.]?\d{3}[.]?\d{3}\s*[-–]?\s*[\dkK])\b/g

export type ContactoPrecioRut = {
  tel: string
  rut: string
  /** ISO del primer bloque de precio. */
  primerPrecio: string
  /** ISO del último bloque de precio. */
  ultimoPrecio: string
  /** Texto del último bloque, para sacar el monto. */
  ultimoTexto: string
}

async function sb<T>(path: string): Promise<T[]> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H, cache: "no-store" })
    return r.ok ? ((await r.json()) as T[]) : []
  } catch {
    return []
  }
}

/**
 * Devuelve los contactos con precio mostrado y RUT del cliente. `paisPrefijo`
 * acota por país (default Chile: los montos y la escalera son de CL).
 */
export async function contactosConPrecioYRut(opts: { desde?: string; paisPrefijo?: string; exigirRut?: boolean } = {}): Promise<ContactoPrecioRut[]> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return []
  const desde = (opts.desde || "2026-01-01").trim()
  const prefijo = opts.paisPrefijo ?? "56"
  const orFirmas = FIRMAS_PRECIO.map((f) => `content.ilike.*${encodeURIComponent(f)}*`).join(",")
  // 1) Bloques de precio (primero y último por conversación).
  const porConv = new Map<string, { primero: string; ultimo: string; texto: string }>()
  for (let p = 0; p < 40; p++) {
    const lote = await sb<{ conversation_id?: string; at?: string; content?: string }>(
      `vic_v3_messages?role=eq.assistant&or=(${orFirmas})&at=gte.${desde}&select=conversation_id,at,content&order=at.asc&limit=1000&offset=${p * 1000}`,
    )
    for (const f of lote) {
      const cid = String(f.conversation_id || "")
      if (!cid) continue
      const at = String(f.at || "")
      const prev = porConv.get(cid)
      if (!prev) porConv.set(cid, { primero: at, ultimo: at, texto: String(f.content || "") })
      else if (at >= prev.ultimo) { prev.ultimo = at; prev.texto = String(f.content || "") }
    }
    if (lote.length < 1000) break
  }
  if (!porConv.size) return []
  // 2) conversación → teléfono.
  const telDe = new Map<string, string>()
  const cids = [...porConv.keys()]
  for (let i = 0; i < cids.length; i += 200) {
    const lista = cids.slice(i, i + 200).map((x) => `"${x}"`).join(",")
    for (const c of await sb<{ id: string; contact: string }>(`vic_v3_conversations?id=in.(${lista})&select=id,contact`)) {
      telDe.set(String(c.id), String(c.contact || "").replace(/\D/g, ""))
    }
  }
  // 3) RUT escrito por el cliente en esas conversaciones (se salta cuando no
  // se exige: es la pasada más cara y no aporta si solo importa el precio).
  const rutDe = new Map<string, string>()
  for (let i = 0; opts.exigirRut !== false && i < cids.length; i += 100) {
    const lista = cids.slice(i, i + 100).map((x) => `"${x}"`).join(",")
    for (let p = 0; p < 12; p++) {
      const lote = await sb<{ conversation_id?: string; content?: string }>(
        `vic_v3_messages?conversation_id=in.(${lista})&role=eq.user&select=conversation_id,content&limit=1000&offset=${p * 1000}`,
      )
      for (const f of lote) {
        const tel = telDe.get(String(f.conversation_id || "")) || ""
        if (!tel || rutDe.has(tel)) continue
        for (const m of String(f.content || "").matchAll(RUT_RE)) {
          const cand = normalizarRut(m[1])
          if (rutValido(cand)) { rutDe.set(tel, cand); break }
        }
      }
      if (lote.length < 1000) break
    }
  }
  // 4) Unir por teléfono (una conversación por contacto, la de más precio).
  const out = new Map<string, ContactoPrecioRut>()
  for (const [cid, x] of porConv.entries()) {
    const tel = telDe.get(cid) || ""
    if (!tel || (prefijo && !tel.startsWith(prefijo))) continue
    const rut = rutDe.get(tel) || ""
    // `exigirRut: false` sirve para preguntar solo "¿hay un precio del que
    // sacar el monto?" — ahí el RUT no hace falta y exigirlo subestimaba
    // (medición del 10-sep sobre los deals sin monto útil).
    if (!rut && opts.exigirRut !== false) continue
    const prev = out.get(tel)
    if (!prev || x.ultimo > prev.ultimoPrecio) {
      out.set(tel, { tel, rut, primerPrecio: prev?.primerPrecio || x.primero, ultimoPrecio: x.ultimo, ultimoTexto: x.texto })
    }
  }
  return [...out.values()].sort((a, b) => a.ultimoPrecio.localeCompare(b.ultimoPrecio))
}
