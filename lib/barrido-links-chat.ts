/**
 * Barrido: todo trato y lead de Vicky lleva el link a su conversación en
 * Botmaker (Lalo 26-sep, "asegúrate de que en el deal o en la nota de las
 * conversaciones de Vicky siempre vaya la URL de la conversación").
 *
 * Por qué hace falta: el link se escribía en el LEAD al nacer, pero el trato
 * lo crea casi siempre el cotizador (lead-first) y el campo no se copia al
 * convertir. Medido el 26-sep: ~200 tratos de Vicky solo de septiembre con
 * `Conversaci_n_Botmaker` vacío. El gancho en la emisión (agent-loop) cubre lo
 * nuevo; este barrido cubre lo que se escape y el histórico.
 *
 * Universo: Deals y Leads creados por Vicky o con Gestión Vicky, campo vacío,
 * con conversación de Vicky para su teléfono. Sin chat en Botmaker → candado
 * `link_chat_nf_<id>` 7 días (no se reintenta en cada pasada).
 */

import { getZohoAccessToken } from "./zoho-token"

const VICKY_USER_ID = (process.env.VICKY_ZOHO_USER_ID || "3525045000484500876").trim()
const CAMPO = (process.env.ZOHO_CAMPO_LINK_CHAT || "Conversaci_n_Botmaker").trim()
const GESTION_VICKY = "('Gestión Vicky','Derivado','Derivado por Reunión','Derivado fuera de Rango')"

type Fila = {
  id: string
  Deal_Name?: string
  Last_Name?: string
  Company?: string
  Contact_Phone?: string | null
  "Contact_Name.Phone"?: string | null
  "Contact_Name.Mobile"?: string | null
  Phone?: string | null
  Mobile?: string | null
}

export type ResultadoLink = { modulo: "Deals" | "Leads"; id: string; nombre: string; contacto: string; accion: "marcado" | "sin_chat" | "sin_conversacion" | "sin_telefono" | "dry" }

async function coql(H: Record<string, string>, api: string, q: string): Promise<Fila[]> {
  const r = await fetch(`${api}/crm/v8/coql`, { method: "POST", headers: H, cache: "no-store", body: JSON.stringify({ select_query: q }) })
  if (r.status === 204) return []
  if (!r.ok) throw new Error(`COQL ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`)
  return ((await r.json().catch(() => ({}))) as { data?: Fila[] }).data || []
}

function soloDigitos(v: unknown): string {
  return String(v || "").replace(/\D/g, "")
}

async function conversacionesExistentes(fonos: string[]): Promise<Set<string>> {
  const url = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "")
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
  const out = new Set<string>()
  if (!url || !key || !fonos.length) return out
  for (let i = 0; i < fonos.length; i += 80) {
    const lote = fonos.slice(i, i + 80)
    const r = await fetch(`${url}/rest/v1/vic_v3_conversations?contact=in.(${lote.join(",")})&select=contact`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      cache: "no-store",
    }).catch(() => null)
    if (!r?.ok) {
      console.warn(`[links-chat] supabase conversaciones HTTP ${r?.status}`)
      continue
    }
    for (const row of ((await r.json().catch(() => [])) as Array<{ contact: string }>)) out.add(row.contact)
  }
  return out
}

export async function barrerLinksChat(opts: { dry?: boolean; max?: number; dias?: number } = {}): Promise<{
  candidatos: number
  resultados: ResultadoLink[]
}> {
  const dry = Boolean(opts.dry)
  const max = Math.max(1, Math.min(200, opts.max || 40))
  const dias = Math.max(1, Math.min(365, opts.dias || 120))
  const desde = new Date(Date.now() - dias * 864e5).toISOString().slice(0, 19) + "+00:00"
  const token = await getZohoAccessToken()
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
  const { getKvValue, setKvValue } = await import("./supabase-persistence-v3")

  const filtro = `((${CAMPO} is null and Created_Time >= '${desde}') and (Created_By = '${VICKY_USER_ID}' or Gesti_n_Vicky in ${GESTION_VICKY}))`
  const cand: Array<{ modulo: "Deals" | "Leads"; fila: Fila }> = []
  for (const [modulo, campos] of [
    ["Deals", "id, Deal_Name, Contact_Phone, Contact_Name.Phone, Contact_Name.Mobile"],
    ["Leads", "id, Last_Name, Company, Phone, Mobile"],
  ] as const) {
    for (let offset = 0; offset < 2000; offset += 200) {
      const filas = await coql(H, api, `select ${campos} from ${modulo} where ${filtro} order by Created_Time desc limit ${offset}, 200`).catch((e) => {
        console.warn(`[links-chat] COQL ${modulo} falló:`, e instanceof Error ? e.message : e)
        return [] as Fila[]
      })
      for (const f of filas) cand.push({ modulo, fila: f })
      if (filas.length < 200) break
    }
  }

  const telDe = (f: Fila) =>
    soloDigitos(f.Contact_Phone || f["Contact_Name.Mobile"] || f["Contact_Name.Phone"] || f.Mobile || f.Phone)
  const conv = await conversacionesExistentes([...new Set(cand.map((c) => telDe(c.fila)).filter((t) => t.length >= 8))])

  const resultados: ResultadoLink[] = []
  let marcados = 0
  const t0 = Date.now()
  for (const { modulo, fila } of cand) {
    if (marcados >= max || Date.now() - t0 > 90_000) break
    const nombre = String(fila.Deal_Name || [fila.Company, fila.Last_Name].filter(Boolean).join(" / ") || "")
    const tel = telDe(fila)
    if (!tel) {
      resultados.push({ modulo, id: fila.id, nombre, contacto: "", accion: "sin_telefono" })
      continue
    }
    if (!conv.has(tel)) {
      resultados.push({ modulo, id: fila.id, nombre, contacto: tel, accion: "sin_conversacion" })
      continue
    }
    const nf = String((await getKvValue(`link_chat_nf_${fila.id}`).catch(() => null)) || "")
    if (nf && Date.now() - Date.parse(nf) < 7 * 864e5) continue
    if (dry) {
      resultados.push({ modulo, id: fila.id, nombre, contacto: tel, accion: "dry" })
      marcados++
      continue
    }
    const { marcarRegistroConChat } = await import("./enlace-conversacion")
    const ok = await marcarRegistroConChat(modulo, fila.id, tel).catch(() => false)
    if (ok) {
      marcados++
      resultados.push({ modulo, id: fila.id, nombre, contacto: tel, accion: "marcado" })
    } else {
      await setKvValue(`link_chat_nf_${fila.id}`, new Date().toISOString()).catch(() => {})
      resultados.push({ modulo, id: fila.id, nombre, contacto: tel, accion: "sin_chat" })
    }
  }
  return { candidatos: cand.length, resultados }
}
