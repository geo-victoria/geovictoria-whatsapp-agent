/**
 * AUDITORÍA DE TÓMBOLAS (Lalo 18-ago): ¿cada lead/deal quedó asignado según
 * la regla definida, mirando lo que de verdad pasó en la conversación?
 *
 * Cada tick barre los leads y deals recientes creados por Vicky, lee la LÍNEA
 * DE TIEMPO de Zoho (el evento `owner_assigned` trae el nombre e id de la
 * regla de asignación exacta que corrió — metadata nativa, verificada 18-ago
 * con el caso PROMASER), la cruza con los hechos de la conversación (dotación,
 * RUT, traspasos vic_ptv, presentación) y deja un VEREDICTO por registro con
 * sus casos borde. El dash lo muestra en la pestaña "Auditoría tómbolas"
 * (vista=tombolas de vic-funnel); el índice vive en vic_kv `tba_idx`.
 *
 * Reglas canónicas contra las que se compara (definición Lalo 18-ago):
 *  - Intención comercial + RUT → DEAL por "Tómbola Deals 2026 Chile"
 *    (…595568541), notificación + presentación por WhatsApp.
 *  - Sin intención identificada → LEAD por la tómbola SDR (…652043111,
 *    Aracely/Aleydis).
 *  - Dueño humano previo → herencia (no se re-sortea) y se presenta.
 *  - Los bordes aún sin definición (intención sin RUT) se MARCAN, no se
 *    juzgan.
 */

import { fetchZoho } from "@/lib/zoho-token"
import { getKvValue, setKvValue, getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const ZOHO_API_DOMAIN = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const VICKY_CREATOR_ID = "3525045000484500876"
const ROBOT_EMAILS = new Set(["vicky@geovictoria.com", "info@geovictoria.com"])
const REGLA_DEALS = "3525045000595568541"
const REGLA_SDR_NUEVA = "3525045000652043111"
const REGLA_TLMK_VIEJA = "3525045000649066001"
const MAX_TIMELINES_POR_TICK = 25
const DIAS_VENTANA = 7

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

async function authorized(req: Request): Promise<boolean> {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
  if (CRON_SECRET && bearer === CRON_SECRET) return true
  const key = (new URL(req.url).searchParams.get("key") || "").trim()
  if (CRON_SECRET && key === CRON_SECRET) return true
  const xcron = (req.headers.get("x-cron-secret") || "").trim()
  if (xcron) {
    const expected = await getFollowupCronSecret().catch(() => "")
    if (expected && xcron === expected) return true
  }
  return false
}

type EventoAsignacion = { reglaId: string; regla: string; owner: string }
type Veredicto = {
  id: string
  tipo: "lead" | "deal"
  nombre: string
  fono: string
  n: number
  rut: string
  dueno: string
  duenoEmail: string
  reglas: EventoAsignacion[]
  llamadasFantasma: string[]
  bordes: string[]
  creado: string
  at: string
}

function esPlaceholderEmpresa(s: string): boolean {
  return !s || /^prospecto whatsapp$/i.test(s) || /^por identificar/i.test(s)
}

/** Lee el timeline del registro y extrae asignaciones por regla + llamadas de
 * workflow cuyo dueño quedó distinto del dueño final (fantasmas). */
async function leerTimeline(modulo: string, id: string, duenoFinal: string): Promise<{
  reglas: EventoAsignacion[]
  llamadasFantasma: string[]
} | null> {
  let r = await fetchZoho(`${ZOHO_API_DOMAIN}/crm/v8/${modulo}/${id}/__timeline?per_page=200`)
  if (!r.ok) r = await fetchZoho(`${ZOHO_API_DOMAIN}/crm/v3/${modulo}/${id}/__timeline?per_page=200`)
  if (!r.ok) return null
  const j = (await r.json().catch(() => null)) as { __timeline?: Array<Record<string, unknown>> } | null
  const eventos = j?.__timeline || []
  const reglas: EventoAsignacion[] = []
  const llamadasFantasma: string[] = []
  for (const e of eventos) {
    const auto = (e.automation_details || {}) as Record<string, unknown>
    if (e.action === "owner_assigned" && e.source === "assignment_rules") {
      const regla = (auto.rule || {}) as { name?: string; id?: string }
      const owner = (auto.owner || {}) as { name?: string }
      reglas.push({ reglaId: String(regla.id || ""), regla: String(regla.name || ""), owner: String(owner.name || "") })
    }
    // Llamadas creadas por workflow al dueño DEL INSTANTE (caso Eddyluz
    // 18-ago): si ese dueño no es el final, quedó fantasma — pero SOLO cuenta
    // si la llamada AÚN EXISTE (la limpieza del 18-ago las borró; el timeline
    // conserva el evento histórico y sin este chequeo el borde nunca sanaría).
    const rec = (e.record || {}) as { module?: { api_name?: string }; id?: string }
    const modRec = String(rec.module?.api_name || "")
    if (modRec === "Calls" && e.action === "added") {
      const wfOwner = ((auto.workflow_rule as { owner?: { name?: string } } | undefined)?.owner?.name ||
        (auto.assigned_to as { name?: string } | undefined)?.name || "") as string
      const callId = String(rec.id || "")
      if (wfOwner && duenoFinal && wfOwner !== duenoFinal && !/vicky geovictoria/i.test(wfOwner) && callId) {
        const vivo = await fetchZoho(`${ZOHO_API_DOMAIN}/crm/v3/Calls/${callId}?fields=id`)
          .then((rr) => rr.ok)
          .catch(() => false)
        if (vivo) llamadasFantasma.push(wfOwner)
      }
    }
  }
  return { reglas, llamadasFantasma }
}

export async function GET(req: Request): Promise<Response> {
  if (!(await authorized(req))) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401 })
  }
  const desde = new Date(Date.now() - DIAS_VENTANA * 864e5).toISOString().slice(0, 10)

  // 1. Población: leads y deals de Vicky de la ventana (solo Chile).
  const coql = async (q: string): Promise<Array<Record<string, unknown>>> => {
    const r = await fetchZoho(`${ZOHO_API_DOMAIN}/crm/v8/coql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ select_query: q }),
    })
    if (!r.ok || r.status === 204) return []
    return (((await r.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>> }).data || [])
  }
  const leads = await coql(
    `select id, Full_Name, Company, Phone, RUT_Empresa, N_Empleados_que_marcan, Owner.first_name, Owner.last_name, Owner.email, Converted__s, Created_Time from Leads ` +
      `where ((Created_By = ${VICKY_CREATOR_ID} and Created_Time >= '${desde}T00:00:00-04:00') and Territorio = 'Chile') order by Created_Time desc limit 100`,
  )
  const deals = await coql(
    `select id, Deal_Name, Stage, N_Empleados_que_marcan, Owner.first_name, Owner.last_name, Owner.email, Contact_Name.Phone, Created_Time from Deals ` +
      `where (Created_By = ${VICKY_CREATOR_ID} and Created_Time >= '${desde}T00:00:00-04:00') order by Created_Time desc limit 100`,
  )

  // 2. Hechos de conversación: traspasos de la ventana (vendedor presentado).
  const supa = async <T,>(ruta: string): Promise<T[]> => {
    if (!SUPABASE_URL || !SUPABASE_KEY) return []
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${ruta}`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      cache: "no-store",
    })
    return r.ok ? ((await r.json().catch(() => [])) as T[]) : []
  }
  const ptv = await supa<{ contact: string; vendedor_email: string; vendedor_nombre: string; presentado_al_prospecto: boolean; motivo: string }>(
    `vic_ptv?traspasado_at=gte.${encodeURIComponent(new Date(Date.now() - DIAS_VENTANA * 864e5).toISOString())}&select=contact,vendedor_email,vendedor_nombre,presentado_al_prospecto,motivo&limit=300`,
  )
  const ptvPorFono = new Map(ptv.map((p) => [p.contact.replace(/\D/g, ""), p]))

  // 3. Evaluar los registros aún no auditados (timeline = 1 llamada por
  //    registro; tope por tick, el resto cae al siguiente).
  const idxCrudo = await getKvValue("tba_idx").catch(() => null)
  let idx: Veredicto[] = []
  try {
    idx = idxCrudo ? (JSON.parse(idxCrudo) as Veredicto[]) : []
  } catch {
    idx = []
  }
  const yaAuditados = new Set(idx.map((v) => v.id))
  let auditados = 0

  const evaluar = async (tipo: "lead" | "deal", r: Record<string, unknown>): Promise<void> => {
    const id = String(r.id || "")
    if (!id || yaAuditados.has(id) || auditados >= MAX_TIMELINES_POR_TICK) return
    const duenoNombre = `${String((r as Record<string, string>)["Owner.first_name"] || "")} ${String((r as Record<string, string>)["Owner.last_name"] || "")}`.trim()
    const duenoEmail = String((r as Record<string, string>)["Owner.email"] || "").toLowerCase()
    const fono = String(tipo === "lead" ? r.Phone || "" : (r as Record<string, string>)["Contact_Name.Phone"] || "").replace(/\D/g, "")
    const n = Number(r.N_Empleados_que_marcan || 0)
    const rut = String(r.RUT_Empresa || "")
    const empresa = String(tipo === "lead" ? r.Company || "" : r.Deal_Name || "")
    const tl = await leerTimeline(tipo === "lead" ? "Leads" : "Deals", id, duenoNombre)
    auditados++
    if (!tl) return
    const bordes: string[] = []
    const convertido = r.Converted__s === true
    const conIdentidad = Boolean(rut || !esPlaceholderEmpresa(empresa))
    const p = ptvPorFono.get(fono)

    if (tipo === "lead") {
      // Regla que corrió vs definición.
      for (const ev of tl.reglas) {
        if (ev.reglaId === REGLA_TLMK_VIEJA) bordes.push("regla_vieja_TLMK (definición nueva apunta a la SDR …3111)")
        else if (ev.reglaId !== REGLA_SDR_NUEVA && ev.reglaId !== REGLA_DEALS) bordes.push(`regla_desconocida:${ev.regla}`)
      }
      // Intención + identidad y sigue lead sin convertir → deal faltante
      // (salvo dueño humano previo: definición pendiente).
      if (!convertido && n > 20 && conIdentidad) {
        bordes.push(ROBOT_EMAILS.has(duenoEmail) ? "deal_faltante" : "deal_no_creado_por_dueno_humano (definición pendiente)")
      }
      if (!convertido && n > 20 && !conIdentidad) bordes.push("intencion_sin_rut (definición pendiente)")
    }
    if (tl.llamadasFantasma.length) bordes.push(`llamada_fantasma:${[...new Set(tl.llamadasFantasma)].join("/")}`)
    if (p) {
      if (p.presentado_al_prospecto === false) bordes.push("traspaso_sin_presentacion")
      if (duenoEmail && p.vendedor_email && duenoEmail !== p.vendedor_email.toLowerCase() && !ROBOT_EMAILS.has(duenoEmail)) {
        bordes.push(`dueno_distinto_del_presentado (${p.vendedor_nombre})`)
      }
    }
    if (tl.reglas.length > 1 && new Set(tl.reglas.map((x) => x.reglaId)).size > 1) bordes.push("multiples_reglas")

    idx.unshift({
      id,
      tipo,
      nombre: empresa || String(r.Full_Name || ""),
      fono,
      n,
      rut,
      dueno: duenoNombre,
      duenoEmail,
      reglas: tl.reglas,
      llamadasFantasma: tl.llamadasFantasma,
      bordes,
      creado: String(r.Created_Time || ""),
      at: new Date().toISOString(),
    })
    yaAuditados.add(id)
  }

  for (const l of leads) await evaluar("lead", l)
  for (const d of deals) await evaluar("deal", d)

  // 4. Persistir índice (cap 400, lo nuevo primero).
  idx = idx.slice(0, 400)
  await setKvValue("tba_idx", JSON.stringify(idx)).catch(() => {})

  const conBordes = idx.filter((v) => v.bordes.length).length
  console.log(`[tombola-audit] auditados=${auditados} total_idx=${idx.length} con_bordes=${conBordes}`)
  return new Response(
    JSON.stringify({ ok: true, auditadosEsteTick: auditados, totalIndice: idx.length, conBordes }),
    { headers: { "content-type": "application/json" } },
  )
}
