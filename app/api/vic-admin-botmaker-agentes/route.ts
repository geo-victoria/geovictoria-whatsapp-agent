/**
 * Endpoint ADMIN: /api/vic-admin-botmaker-agentes
 *
 * Alinea Botmaker con Zoho (orden de Lalo, 14-ago). Tres trabajos:
 *   1. `roles`     — deja OPERATOR a los dueños de registros de Vicky y les
 *                    pone SU etiqueta, que es lo que en Botmaker filtra qué
 *                    conversaciones ve cada uno.
 *   2. `crear`     — da de alta a los dueños que aún no existen como agentes
 *                    (Aleydis y Araceli reciben la mayor parte de los leads
 *                    de Vicky y no tenían cuenta: no podían abrir el chat).
 *   3. `etiquetar` — barrido RETROACTIVO: cada conversación queda con la
 *                    etiqueta del dueño de su registro en Zoho.
 *
 * Zoho es la fuente de la verdad. Nada acá toca la conversación del cliente
 * ni reasigna registros: solo roles, altas y etiquetas de visibilidad.
 *
 * Auth: ?key=<cron secret> o header x-vicky-secret.
 */

import { NextResponse } from "next/server"
import {
  actualizarAgente,
  chatRefDeContacto,
  crearAgente,
  etiquetarChatConDueno,
  listarAgentes,
  type RolBotmaker,
} from "@/lib/botmaker-agentes"
import { getFollowupCronSecret, getKvValue, setKvValue } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const VICKY_SECRET = (process.env.VICKY_COTIZADORA_SECRET || "").trim()
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const ZOHO_API = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()

async function autorizado(req: Request, key: string): Promise<boolean> {
  const headerSecret = (req.headers.get("x-vicky-secret") || "").trim()
  if (CRON_SECRET && key === CRON_SECRET) return true
  if (VICKY_SECRET && headerSecret === VICKY_SECRET) return true
  if (key) {
    const kv = await getFollowupCronSecret().catch(() => "")
    if (kv && key === kv) return true
  }
  return false
}

async function supa<T>(path: string): Promise<T[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    cache: "no-store",
  })
  return r.ok ? ((await r.json().catch(() => [])) as T[]) : []
}

async function coql<T>(query: string): Promise<T[]> {
  const { getZohoAccessToken } = await import("@/lib/zoho-token")
  const token = await getZohoAccessToken()
  const r = await fetch(`${ZOHO_API}/crm/v3/coql`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ select_query: query }),
  })
  if (r.status === 204) return []
  if (!r.ok) {
    console.warn(`[bm-agentes] COQL ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`)
    return []
  }
  const b = (await r.json().catch(() => ({}))) as { data?: T[] }
  return Array.isArray(b.data) ? b.data : []
}

/** Dueño vigente en Zoho de un teléfono: manda el DEAL, y si no hay, el lead. */
async function duenosPorTelefono(fonos: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!fonos.length) return out
  const lista = fonos.map((f) => `'+${f}'`).join(",")
  const leads = await coql<{ Phone?: string; "Owner.email"?: string }>(
    `select Phone, Owner.email from Leads where ((Phone in (${lista}))) limit 200`,
  )
  for (const l of leads) {
    const f = String(l.Phone || "").replace(/\D/g, "")
    const e = String(l["Owner.email"] || "")
    if (f && e) out.set(f, e)
  }
  const contactos = await coql<{ Phone?: string; "Owner.email"?: string }>(
    `select Phone, Owner.email from Contacts where ((Phone in (${lista}))) limit 200`,
  )
  for (const c of contactos) {
    const f = String(c.Phone || "").replace(/\D/g, "")
    const e = String(c["Owner.email"] || "")
    // El contacto (lead ya convertido) pisa al lead: es el registro vivo.
    if (f && e) out.set(f, e)
  }
  return out
}

function json(payload: unknown, status = 200): Response {
  return NextResponse.json(payload as Record<string, unknown>, { status })
}

export async function GET(req: Request): Promise<Response> {
  const sp = new URL(req.url).searchParams
  if (!(await autorizado(req, (sp.get("key") || "").trim()))) return json({ ok: false, error: "unauthorized" }, 401)
  const agentes = await listarAgentes()
  return json({
    ok: true,
    total: agentes.length,
    agentes: agentes
      .map((a) => ({ email: a.email, name: a.name, role: a.role, tags: a.tags || [] }))
      .sort((x, y) => (x.email || "").localeCompare(y.email || "")),
  })
}

export async function POST(req: Request): Promise<Response> {
  const sp = new URL(req.url).searchParams
  if (!(await autorizado(req, (sp.get("key") || "").trim()))) return json({ ok: false, error: "unauthorized" }, 401)
  const body = (await req.json().catch(() => ({}))) as {
    accion?: string
    correos?: string[]
    rol?: RolBotmaker
    nuevos?: Array<{ email: string; name: string }>
    limite?: number
    dryRun?: boolean
  }
  const accion = String(body.accion || "")
  const dryRun = body.dryRun === true

  // ── 1. ROLES + etiqueta propia ────────────────────────────────────────────
  if (accion === "roles") {
    const rol = (body.rol || "OPERATOR") as RolBotmaker
    const correos = (body.correos || []).map((c) => c.trim().toLowerCase()).filter(Boolean)
    const agentes = await listarAgentes()
    const porCorreo = new Map(agentes.map((a) => [String(a.email || "").toLowerCase(), a]))
    const hechos: Array<Record<string, unknown>> = []
    for (const correo of correos) {
      const a = porCorreo.get(correo)
      if (!a) {
        hechos.push({ correo, estado: "no existe como agente" })
        continue
      }
      // SIN ETIQUETAS (14-ago): Botmaker solo acepta tags de un catálogo ya
      // creado en la consola, y además dejaron de hacer falta — con la
      // asignación real funcionando, un OPERATOR ve sus conversaciones
      // porque las tiene ASIGNADAS, no porque las filtre por tag.
      if (a.role === rol) {
        hechos.push({ correo, estado: "sin cambios", rol: a.role })
        continue
      }
      if (dryRun) {
        hechos.push({ correo, estado: "SIMULADO", de: a.role, a: rol })
        continue
      }
      const r = await actualizarAgente(correo, { role: rol })
      hechos.push({ correo, estado: r.ok ? "actualizado" : `error: ${r.error}`, de: a.role, a: rol })
    }
    return json({ ok: true, dryRun, accion, hechos })
  }

  // ── 2. ALTA de los que faltan ─────────────────────────────────────────────
  if (accion === "crear") {
    const rol = (body.rol || "OPERATOR") as RolBotmaker
    const agentes = await listarAgentes()
    const existentes = new Set(agentes.map((a) => String(a.email || "").toLowerCase()))
    const hechos: Array<Record<string, unknown>> = []
    for (const n of body.nuevos || []) {
      const correo = String(n.email || "").trim().toLowerCase()
      if (!correo) continue
      if (existentes.has(correo)) {
        hechos.push({ correo, estado: "ya existía" })
        continue
      }
      if (dryRun) {
        hechos.push({ correo, estado: "SIMULADO", nombre: n.name, rol })
        continue
      }
      // Botmaker exige contraseña al crear (mínimo 8). Se genera temporal y se
      // devuelve UNA vez para entregarla; la persona debe cambiarla al entrar.
      const clave = `Gv${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6).toUpperCase()}!`
      const r = await crearAgente({ email: correo, name: n.name, role: rol, password: clave })
      hechos.push({
        correo,
        estado: r.ok ? "creado" : `error: ${r.error}`,
        id: r.id,
        clave_temporal: r.ok ? clave : undefined,
      })
    }
    return json({ ok: true, dryRun, accion, hechos })
  }

  // ── 3. ETIQUETADO RETROACTIVO de conversaciones ───────────────────────────
  if (accion === "etiquetar") {
    const limite = Math.min(120, Math.max(1, Number(body.limite) || 60))
    const cursorKv = "bm_etiquetas_offset"
    const offset = parseInt((await getKvValue(cursorKv).catch(() => "0")) || "0") || 0
    const convs = await supa<{ contact: string }>(
      `vic_v3_conversations?select=contact&order=updated_at.desc&limit=${limite}&offset=${offset}`,
    )
    if (!convs.length) {
      await setKvValue(cursorKv, "0").catch(() => {})
      return json({ ok: true, accion, fin: true, offset, mensaje: "no quedan conversaciones; cursor reiniciado" })
    }
    const fonos = convs.map((c) => String(c.contact || "").replace(/\D/g, "")).filter(Boolean)
    const duenos = await duenosPorTelefono(fonos)
    let etiquetados = 0
    let sinDueno = 0
    let sinCambio = 0
    const errores: string[] = []
    for (const fono of fonos) {
      const owner = duenos.get(fono)
      if (!owner) {
        sinDueno++
        continue
      }
      if (dryRun) {
        etiquetados++
        continue
      }
      const r = await etiquetarChatConDueno(chatRefDeContacto(fono), owner)
      if (r.cambiado) etiquetados++
      else if (r.error) errores.push(`${fono}: ${r.error}`)
      else sinCambio++
    }
    if (!dryRun) await setKvValue(cursorKv, String(offset + convs.length)).catch(() => {})
    return json({
      ok: true,
      dryRun,
      accion,
      offset,
      revisadas: convs.length,
      etiquetados,
      sin_cambio: sinCambio,
      sin_dueno_en_zoho: sinDueno,
      errores: errores.slice(0, 5),
      siguienteOffset: offset + convs.length,
    })
  }

  // ── 4. SONDA: ¿el PATCH de chat acepta agentId? ───────────────────────────
  // La doc lista solo firstName/lastName/country/email/variables/tags/isTester,
  // pero agentId SÍ existe en el GET. Antes de darlo por imposible se prueba
  // contra un chat real y se relee el estado: si Botmaker lo acepta, la
  // asignación de verdad (no solo la etiqueta) queda al alcance.
  if (accion === "probar_agentid") {
    const chatRef = String((body as { chatRef?: string }).chatRef || "")
    const agentId = String((body as { agentId?: string }).agentId || "")
    if (!chatRef || !agentId) return json({ ok: false, error: "chatRef y agentId requeridos" }, 400)
    const { leerChat } = await import("@/lib/botmaker-agentes")
    const antes = await leerChat(chatRef)
    const r = await fetch(`https://api.botmaker.com/v2.0/chats/${encodeURIComponent(chatRef)}`, {
      method: "PATCH",
      headers: {
        "access-token": (process.env.BOTMAKER_ACCESS_TOKEN || "").trim(),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      cache: "no-store",
      body: JSON.stringify({ agentId }),
    })
    const cuerpo = (await r.text().catch(() => "")).slice(0, 400)
    const despues = await leerChat(chatRef)
    return json({
      ok: true,
      accion,
      status: r.status,
      respuesta: cuerpo,
      agentId_antes: antes?.agentId || null,
      agentId_despues: despues?.agentId || null,
      aplicado: Boolean(despues?.agentId && despues.agentId === agentId),
    })
  }

  // ── 6. AUDITORÍA de sincronía CRM ↔ conversaciones ────────────────────────
  // Pregunta de Lalo (15-ago): ¿está todo cruzado? ¿faltan leads o tratos por
  // crear? ¿hay oportunidades comerciales fuera del CRM? Se responde con
  // datos, no con impresiones: se toman TODAS las conversaciones, se marcan
  // las que tienen hito comercial (precio visto, cotización o reunión) y se
  // cruzan por teléfono contra Leads y Contacts de Zoho.
  if (accion === "auditoria") {
    const convs: Array<{ contact: string; user_msg_count?: number }> = []
    for (let p = 0; p < 12; p++) {
      const pagina = await supa<{ contact: string; user_msg_count?: number }>(
        `vic_v3_conversations?select=contact,user_msg_count&limit=1000&offset=${p * 1000}`,
      )
      convs.push(...pagina)
      if (pagina.length < 1000) break
    }
    const internos = new Set(["56944668823", "56978385048", "56971345236"])
    const todos = convs
      .map((c) => String(c.contact || "").replace(/\D/g, ""))
      .filter((c) => c && !internos.has(c))
    // Hitos comerciales: cotización emitida (puntero) o reunión agendada.
    const punteros = await supa<{ contact: string; deal_id?: string }>(
      `vic_v3_quote_pointers?select=contact,deal_id&limit=2000`,
    )
    const reuniones = await supa<{ contact: string }>(`vic_v3_meetings?select=contact&limit=2000`)
    const conCotizacion = new Set(punteros.map((p) => String(p.contact || "").replace(/\D/g, "")))
    const conReunion = new Set(reuniones.map((m) => String(m.contact || "").replace(/\D/g, "")))
    const conHito = todos.filter((c) => conCotizacion.has(c) || conReunion.has(c))

    // Cruce contra Zoho por teléfono, en lotes y tolerando el formato: hay
    // registros guardados con "+56..." y otros sin el signo.
    // COQL admite un MÁXIMO DE 50 VALORES por IN (LIMIT_EXCEEDED). Como cada
    // teléfono se busca en sus dos formatos —en Zoho conviven "+56..." y
    // "56..."— el lote es de 24 números = 48 valores. Con lotes grandes todas
    // las consultas rebotaban y el resultado daba "0 en el CRM": el silencio
    // parecía un hallazgo.
    // Los teléfonos en Zoho vienen ESCRITOS DE VARIAS FORMAS: "+56964525048",
    // "56964525048", "+569 6452 5048" y "+56 9 6249 2757" conviven en la
    // misma base. Comparando solo el formato plano, tres cotizaciones
    // emitidas (Transyver, Maca, Ingredientes Alimenticios) figuraban como
    // "sin registro en el CRM" cuando su trato existe hace semanas.
    const variantes = (f: string): string[] => {
      const out = new Set([f, `+${f}`])
      const m = f.match(/^(\d{2})9(\d{4})(\d{4})$/) // CL: 56 9 XXXX XXXX
      if (m) {
        out.add(`+${m[1]} 9 ${m[2]} ${m[3]}`)
        out.add(`+${m[1]}9 ${m[2]} ${m[3]}`)
      }
      return [...out]
    }
    const enCrm = new Set<string>()
    const lotes: string[][] = []
    for (let i = 0; i < todos.length; i += 12) lotes.push(todos.slice(i, i + 12))
    // De a 6 lotes en paralelo para que la auditoría completa entre en el
    // tiempo de la función.
    for (let i = 0; i < lotes.length; i += 6) {
      await Promise.all(
        lotes.slice(i, i + 6).map(async (lote) => {
          const lista = lote.flatMap(variantes).map((v) => `'${v}'`).join(",")
          const porVariante = new Map<string, string>()
          for (const f of lote) for (const v of variantes(f)) porVariante.set(v, f)
          for (const modulo of ["Leads", "Contacts"]) {
            const filas = await coql<{ Phone?: string }>(
              `select id, Phone from ${modulo} where ((Phone in (${lista}))) limit 200`,
            )
            for (const f of filas) {
              const bruto = String(f.Phone || "")
              const normal = porVariante.get(bruto) || bruto.replace(/\D/g, "")
              if (normal) enCrm.add(normal)
            }
          }
        }),
      )
    }
    // "Con trato" se mide donde el trato realmente se ancla: el puntero de la
    // cotización. No se infiere de la existencia de un contacto.
    const conDeal = new Set<string>()
    for (const p of punteros) {
      if (p.deal_id) conDeal.add(String(p.contact || "").replace(/\D/g, ""))
    }
    const faltantes = todos.filter((c) => !enCrm.has(c))
    const hitoSinCrm = conHito.filter((c) => !enCrm.has(c))
    const hitoSinDeal = conHito.filter((c) => !conDeal.has(c))
    return json({
      ok: true,
      accion,
      conversaciones: todos.length,
      con_hito_comercial: conHito.length,
      en_crm: todos.length - faltantes.length,
      sin_registro_en_crm: faltantes.length,
      hito_comercial_sin_registro_en_crm: hitoSinCrm.length,
      cotizacion_emitida_sin_trato_asociado: hitoSinDeal.length,
      muestra_hito_sin_crm: hitoSinCrm.slice(0, 20),
      muestra_hito_sin_trato: hitoSinDeal.slice(0, 20),
      // Lista COMPLETA: el detalle es el que permite separar prospectos
      // reales de ruido (ids de Instagram/Facebook, números de otros países).
      sin_crm: faltantes,
    })
  }

  // ── 5. SONDA: disparar una INTENCIÓN inyectando variables ─────────────────
  // El constructor de flujos vive solo en la consola (/intents es GET), pero
  // una intención que YA existe y está activa se puede ejecutar por API con
  // variables propias. Si su flujo trae la acción "Asignar la conversación a
  // agente específico", el agentId del chat cambia — y eso se verifica acá
  // releyendo el chat antes y después. Probar SIEMPRE contra un número
  // interno: el flujo puede mandarle un mensaje al contacto.
  if (accion === "probar_intent") {
    const b2 = body as { chatRef?: string; intent?: string; variables?: Record<string, string> }
    const chatRef = String(b2.chatRef || "")
    const intent = String(b2.intent || "")
    if (!chatRef || !intent) return json({ ok: false, error: "chatRef e intent requeridos" }, 400)
    const [canal, contacto] = chatRef.split(":")
    const { leerChat } = await import("@/lib/botmaker-agentes")
    const antes = await leerChat(chatRef)
    const r = await fetch("https://api.botmaker.com/v2.0/chats-actions/trigger-intent", {
      method: "POST",
      headers: {
        "access-token": (process.env.BOTMAKER_ACCESS_TOKEN || "").trim(),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      cache: "no-store",
      body: JSON.stringify({
        chat: { channelId: canal, contactId: contacto },
        intentIdOrName: intent,
        variables: b2.variables || {},
      }),
    })
    const cuerpo = (await r.text().catch(() => "")).slice(0, 400)
    // El flujo corre asíncrono: se le da un respiro antes de releer.
    await new Promise((res) => setTimeout(res, 6000))
    const despues = await leerChat(chatRef)
    return json({
      ok: true,
      accion,
      intent,
      variables: b2.variables || {},
      status: r.status,
      respuesta: cuerpo,
      agentId_antes: antes?.agentId || null,
      agentId_despues: despues?.agentId || null,
      cambio: (antes?.agentId || null) !== (despues?.agentId || null),
    })
  }

  return json({ ok: false, error: "accion debe ser roles | crear | etiquetar | probar_agentid | probar_intent" }, 400)
}
