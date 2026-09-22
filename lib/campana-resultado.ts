/**
 * ¿LA CAMPAÑA ESTÁ HACIENDO BIEN O MAL? (13-sep, pregunta de Lalo "¿serán
 * automáticas para siempre?").
 *
 * El pre-flight del lunes mira lo que VA A SALIR; esto mira lo que YA SALIÓ.
 * Sin esto, la decisión de "sigue encendida" se toma por inercia: el freno
 * actual detecta volumen inesperado y ceguera, pero no detecta DAÑO — nadie
 * cuenta los opt-out ni los "no me escriban más" contra los envíos.
 *
 * El riesgo que esto vigila no se paga solo en esta campaña: los toques son
 * MARKETING para Meta, y si la calificación de la línea se degrada por
 * proactividad sostenida se cae con ella el toque 0, las presentaciones de
 * traspaso y el kickoff del alta.
 *
 * Fuente = `vic_campanas` (evento enviado / enviado_correo con campana
 * react_t*), que es la única que tiene UNA FILA POR ENVÍO con su hora.
 */

import { posturaRechazoCliente, esAutorespuesta } from "./rechazo-cliente"

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "")
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ""

export type ResultadoCampana = {
  dias: number
  enviados: number
  contactos: number
  respondieron: number
  rechazos: number
  autorespuestas: number
  optOuts: number
  ventas: number
  /** respondieron ÷ contactos tocados, en %. */
  tasaRespuesta: number
  /** (rechazos + opt-outs) ÷ contactos tocados, en %: la métrica de DAÑO. */
  tasaDano: number
  /** % de opt-out puro, que es la señal que mira Meta. */
  tasaOptOut: number
  porSemana: Array<{ semana: string; enviados: number; respondieron: number; rechazos: number; optOuts: number; ventas: number }>
  fallas: string[]
}

async function sb<T>(ruta: string): Promise<T[]> {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("supabase sin configurar")
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${ruta}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    cache: "no-store",
  })
  if (!r.ok) throw new Error(`supabase ${r.status} en ${ruta.split("?")[0]}`)
  return ((await r.json().catch(() => [])) as T[]) || []
}

const lunesDe = (d: Date): string => {
  const x = new Date(d)
  const dow = (x.getUTCDay() + 6) % 7
  x.setUTCDate(x.getUTCDate() - dow)
  return x.toISOString().slice(0, 10)
}

/**
 * Resultado de los toques del ciclo en los últimos `dias`.
 *
 * REGLA DE ATRIBUCIÓN: solo cuenta lo que pasó DESPUÉS del primer toque de
 * cada contacto. Un rechazo de agosto no es daño de la campaña de septiembre,
 * y una venta anterior al toque tampoco es mérito suyo.
 *
 * Las fallas de consulta se acumulan y viajan en el resultado: un `catch` mudo
 * acá haría exactamente lo que hizo la campaña el 11-sep — parecer sana
 * estando muerta.
 */
export async function resultadoCampana(dias = 28): Promise<ResultadoCampana> {
  const fallas: string[] = []
  const corte = new Date(Date.now() - Math.max(1, dias) * 86_400_000)
  const vacio: ResultadoCampana = {
    dias, enviados: 0, contactos: 0, respondieron: 0, rechazos: 0, autorespuestas: 0,
    optOuts: 0, ventas: 0, tasaRespuesta: 0, tasaDano: 0, tasaOptOut: 0, porSemana: [], fallas,
  }

  let envios: Array<{ contact: string; campana: string; evento: string; at: string }> = []
  try {
    envios = await sb(
      `vic_campanas?campana=like.react_t*&evento=in.(enviado,enviado_correo)&at=gte.${corte.toISOString()}&select=contact,campana,evento,at&order=at.asc&limit=5000`,
    )
  } catch (e) {
    fallas.push(`vic_campanas: ${e instanceof Error ? e.message : e}`)
    return vacio
  }
  if (!envios.length) return vacio

  // Primer toque de cada contacto: la línea desde la que se atribuye todo.
  const primerToque = new Map<string, Date>()
  for (const e of envios) {
    const at = new Date(e.at)
    const prev = primerToque.get(e.contact)
    if (!prev || at < prev) primerToque.set(e.contact, at)
  }
  const contactos = [...primerToque.keys()]

  // Conversaciones y mensajes posteriores al toque (vic_v3_messages NO tiene
  // columna contact: cuelgan de conversation_id — cicatriz del 11-sep).
  const convDe = new Map<string, string>()
  const optOutConv = new Set<string>()
  for (let i = 0; i < contactos.length; i += 100) {
    const lote = contactos.slice(i, i + 100)
    try {
      const cs = await sb<{ id: string; contact: string; followup_closed_reason: string | null }>(
        `vic_v3_conversations?contact=in.(${lote.join(",")})&select=id,contact,followup_closed_reason`,
      )
      for (const c of cs) {
        convDe.set(c.id, c.contact)
        if (c.followup_closed_reason === "opt_out") optOutConv.add(c.contact)
      }
    } catch (e) {
      fallas.push(`conversaciones: ${e instanceof Error ? e.message : e}`)
    }
  }

  const msgsPorContacto = new Map<string, Array<{ role: string; content: string; at: string }>>()
  const ids = [...convDe.keys()]
  for (let i = 0; i < ids.length; i += 100) {
    const lote = ids.slice(i, i + 100)
    try {
      const ms = await sb<{ conversation_id: string; role: string; content: string; at: string }>(
        `vic_v3_messages?conversation_id=in.(${lote.join(",")})&at=gte.${corte.toISOString()}&select=conversation_id,role,content,at&order=at.asc&limit=5000`,
      )
      for (const m of ms) {
        const c = convDe.get(m.conversation_id)
        if (!c) continue
        const t0 = primerToque.get(c)
        if (!t0 || new Date(m.at) < t0) continue
        const arr = msgsPorContacto.get(c) || []
        arr.push({ role: m.role, content: m.content, at: m.at })
        msgsPorContacto.set(c, arr)
      }
    } catch (e) {
      fallas.push(`mensajes: ${e instanceof Error ? e.message : e}`)
    }
  }

  // Opt-out explícito y pago, por marca kv posterior al toque.
  const marcas = new Map<string, string>()
  const claves = contactos.flatMap((c) => [`voz_no_llamar_${c}`, `pago_online_${c}`, `comprobante_ok_${c}`])
  for (let i = 0; i < claves.length; i += 150) {
    const lote = claves.slice(i, i + 150).map((k) => `"${k}"`).join(",")
    try {
      const kv = await sb<{ key: string; value: string }>(`vic_kv?key=in.(${lote})&select=key,value`)
      for (const f of kv) marcas.set(f.key, f.value)
    } catch (e) {
      fallas.push(`kv: ${e instanceof Error ? e.message : e}`)
    }
  }
  const marcaPosterior = (clave: string, t0: Date): boolean => {
    const v = marcas.get(clave)
    if (!v) return false
    try {
      const at = (JSON.parse(v) as { at?: string }).at
      return at ? new Date(at) >= t0 : true
    } catch {
      return true // marca sin fecha: se cuenta, el lado conservador
    }
  }

  const porSemana = new Map<string, { enviados: number; respondieron: number; rechazos: number; optOuts: number; ventas: number }>()
  const semana = (k: string) => {
    if (!porSemana.has(k)) porSemana.set(k, { enviados: 0, respondieron: 0, rechazos: 0, optOuts: 0, ventas: 0 })
    return porSemana.get(k)!
  }
  for (const e of envios) semana(lunesDe(new Date(e.at))).enviados++

  let respondieron = 0, rechazos = 0, autorespuestas = 0, optOuts = 0, ventas = 0
  for (const c of contactos) {
    const t0 = primerToque.get(c)!
    const sem = semana(lunesDe(t0))
    const msgs = msgsPorContacto.get(c) || []
    const delCliente = msgs.filter((m) => m.role === "user")
    if (delCliente.length) {
      respondieron++
      sem.respondieron++
      const postura = posturaRechazoCliente(msgs)
      const auto = delCliente.some((m) => esAutorespuesta(m.content))
      if (auto) autorespuestas++
      else if (postura) { rechazos++; sem.rechazos++ }
    }
    if (optOutConv.has(c) || marcaPosterior(`voz_no_llamar_${c}`, t0)) { optOuts++; sem.optOuts++ }
    if (marcaPosterior(`pago_online_${c}`, t0) || marcaPosterior(`comprobante_ok_${c}`, t0)) { ventas++; sem.ventas++ }
  }

  const base = contactos.length || 1
  return {
    dias,
    enviados: envios.length,
    contactos: contactos.length,
    respondieron,
    rechazos,
    autorespuestas,
    optOuts,
    ventas,
    tasaRespuesta: Math.round((respondieron / base) * 1000) / 10,
    tasaDano: Math.round(((rechazos + optOuts) / base) * 1000) / 10,
    tasaOptOut: Math.round((optOuts / base) * 1000) / 10,
    porSemana: [...porSemana.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([s, v]) => ({ semana: s, ...v })),
    fallas,
  }
}
