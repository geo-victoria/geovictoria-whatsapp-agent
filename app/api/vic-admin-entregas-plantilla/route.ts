import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { salientesDesde, veredictosDeEntrega, type EnvioAVerificar } from "@/lib/entrega-plantilla"

export const runtime = "nodejs"
export const maxDuration = 300

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

/**
 * ¿CUÁLES DE LAS PLANTILLAS QUE CREEMOS HABER ENVIADO SALIERON DE VERDAD?
 * (SOLO LECTURA, 13-sep)
 *
 * Cruza lo que anotamos como enviado —`vic_campanas` y/o las marcas kv de cada
 * campaña— contra lo que Botmaker despachó (API de mensajes: `from:"bot"` con
 * `content.whatsAppTemplateName`). Hasta hoy un envío frenado por el pacing de
 * Meta o por el tope de MARKETING se anotaba como ÉXITO, porque Botmaker
 * responde 202 = "encargo aceptado", no "entregado".
 *
 * `?prefijo=campana_remk_remk_300_08sep_` lee las marcas kv de esa campaña ·
 * `?campana=react_t` lee vic_campanas · `?dias=` la ventana (default 3, máx 7:
 * la API de Botmaker se pagina y más días no alcanzan a recorrerse).
 *
 * LÍMITE: responde "Botmaker no la despachó", NO "Meta no la entregó". Un
 * mensaje despachado y botado por Meta probablemente figure igual como salido
 * — el código de error de Meta no viaja por esta API.
 */
export async function GET(req: Request): Promise<Response> {
  const sp = new URL(req.url).searchParams
  const key = (sp.get("key") || req.headers.get("x-cron-secret") || "").trim()
  const secreto = (process.env.FOLLOWUP_CRON_SECRET || "").trim() || (await getFollowupCronSecret().catch(() => "")) || ""
  if (!key || !secreto || key !== secreto) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  if (!SUPABASE_URL || !SUPABASE_KEY) return NextResponse.json({ ok: false, error: "sin supabase" }, { status: 503 })

  const dias = Math.min(Math.max(Number(sp.get("dias")) || 3, 1), 7)
  const desdeMs = Date.now() - dias * 86_400_000
  const desdeIso = new Date(desdeMs).toISOString()
  const H = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }

  const envios: EnvioAVerificar[] = []
  const fuentes: Record<string, number> = {}

  const prefijo = (sp.get("prefijo") || "").trim()
  if (prefijo) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?key=like.${encodeURIComponent(prefijo)}*&select=key,value&limit=1000`, { headers: H, cache: "no-store" })
    const filas = ((await r.json().catch(() => [])) as Array<{ key: string; value: string }>) || []
    for (const f of filas) {
      let at: string | number = 0
      let tpl: string | undefined
      try {
        const j = JSON.parse(f.value) as { at?: string; tpl?: string }
        at = j.at || 0
        tpl = j.tpl
      } catch { /* value plano */ }
      const contacto = f.key.slice(prefijo.length).replace(/\D/g, "")
      if (contacto) envios.push({ contacto, at, tpl })
    }
    fuentes[`kv:${prefijo}`] = filas.length
  }

  const campana = (sp.get("campana") || "").trim()
  if (campana) {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_campanas?campana=like.${encodeURIComponent(campana)}*&evento=eq.enviado&at=gte.${desdeIso}&select=contact,at,campana&limit=2000`,
      { headers: H, cache: "no-store" },
    )
    const filas = ((await r.json().catch(() => [])) as Array<{ contact: string; at: string; campana: string }>) || []
    for (const f of filas) envios.push({ contacto: f.contact, at: f.at, tpl: f.campana })
    fuentes[`vic_campanas:${campana}`] = filas.length
  }

  if (!envios.length) {
    return NextResponse.json({ ok: false, error: "nada que verificar — pasa ?prefijo= (marcas kv) o ?campana= (vic_campanas)" }, { status: 400 })
  }

  const { porContacto, total, truncado, error } = await salientesDesde(desdeIso, { presupuestoMs: 240_000, maxPaginas: 60 })
  // Botmaker NO deja consultar más de ~72 h atrás (400
  // LONG_TERM_SEARCH_PARAM_REQUIRED). Si no se leyó nada, no hay veredicto que
  // dar: reportar "no salió" sería inventar un hallazgo con datos ausentes.
  const lecturaUtil = total > 0
  const veredictos = veredictosDeEntrega(envios, porContacto, desdeMs, { lecturaUtil })

  const resumen = { salio: 0, no_visto: 0, sin_ventana: 0, sin_datos: 0 }
  for (const v of veredictos) resumen[v.veredicto]++
  const enVentana = resumen.salio + resumen.no_visto

  return NextResponse.json({
    ok: true,
    ventanaDias: dias,
    fuentes,
    mensajesBotLeidos: total,
    truncado,
    lecturaUtil,
    errorBotmaker: error || undefined,
    avisoVentana: lecturaUtil ? undefined : "Botmaker no deja consultar más de ~72 h atrás: verifica DENTRO de ese plazo",
    resumen,
    pctSalio: enVentana ? Math.round((resumen.salio / enVentana) * 100) : null,
    nota: "verifica que BOTMAKER las despachó; el código de error de META no viaja por esta API",
    noVistos: veredictos.filter((v) => v.veredicto === "no_visto").slice(0, 60),
  })
}
