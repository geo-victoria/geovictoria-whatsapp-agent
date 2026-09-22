/**
 * VIGÍA DEL AUTO-ONBOARDING (Lalo 24-ago, caso Bersa/IMP-11175).
 *
 * GET /api/vic-onboarding-vigia  (auth cron; lo despacha el despachador de
 * huérfanos cada ~30 min).
 *
 * QUÉ CAZA: registros de Autoservicio_Onboarding con Estado "Completado" pero
 * SIN planillas o SIN implementación. Causa vista en producción: el cierre
 * del wizard depende de UN POST desde el navegador del cliente hacia
 * /api/submit-to-zoho — si se pierde (red, pestaña cerrada) o si Zoho Flow
 * falla aguas abajo (caso 24-ago: deal sin cuenta → "Criteria is not
 * provided" → Failed), el onboarding queda "Completado" sin fichas y el
 * equipo de implementación no se entera.
 *
 * QUÉ HACE: relee la sesión REAL del wizard (GET /api/onboarding/{token}),
 * sanea la razón social si viene contaminada con el nombre de la cotización
 * ("Cotización X - fecha" → X) y re-dispara el cierre (POST submit-to-zoho),
 * que regenera las planillas y le pega de nuevo al Flow. Candado por registro
 * (reintento cada 6h, máx 3) + gracia de 15 min para no competir con un
 * cierre en vuelo.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret, getKvValue, setKvValue } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const WIZARD_URL = (process.env.VICKY_ONBOARDING_WIZARD_URL || "https://onboarding.geovictoria.com").trim().replace(/\/+$/, "")
const GRACIA_MIN = 15
const MAX_REINTENTOS = 3
// SOLO CIERRES RECIENTES (fix 24-ago, a las 2 horas del estreno): la primera
// versión no tenía tope de fecha y barrió el HISTÓRICO de onboardings
// "Completado sin implementación" — creó implementaciones para casos de
// marzo (SOFTMOTION, Pinnacle, GOLDEN…) que el equipo tuvo que rechazar.
// El vigía existe para el cierre que se pierde HOY, no para resucitar
// procesos muertos: ventana de 7 días sobre Fecha_ltimo_avance.
const VENTANA_DIAS = 7

async function autorizado(req: Request): Promise<boolean> {
  const secreto = await getFollowupCronSecret().catch(() => "")
  const cron = (process.env.CRON_SECRET || "").trim()
  const url = new URL(req.url)
  const auth = req.headers.get("authorization") || ""
  const entregado =
    req.headers.get("x-cron-secret") || (auth.startsWith("Bearer ") ? auth.slice(7) : "") || url.searchParams.get("key") || ""
  return Boolean(entregado) && (entregado === secreto || (Boolean(cron) && entregado === cron))
}

/** "Cotización EMPRESA SPA - 2026-08-24" → "EMPRESA SPA" (contaminación del
 * prellenado cuando el deal no tenía cuenta; los casos nuevos ya no la traen). */
function sanearRazonSocial(v: string): string {
  return String(v || "")
    .replace(/^Cotizaci[oó]n\s+/i, "")
    .replace(/\s+-\s+\d{4}-\d{2}-\d{2}$/, "")
    .trim()
}

type FilaZoho = {
  id: string
  Token_p_blico?: string | null
  Fecha_ltimo_avance?: string | null
  Link_planilla_carga_usuarios?: string | null
  Implementaci_n_creada?: { id?: string } | null
  Cotizacion_Asociada?: { id?: string } | null
}

/** ID de la CUENTA de Zoho para inyectarlo al payload (Lalo 24-ago): así el
 * Flow puede tomar la cuenta directo del paquete en vez de deducirla desde el
 * deal ("Encontrar Cuenta" con criterio vacío fue la causa del caso Bersa).
 * Fuente: la Cuenta_Asociada de la cotización del onboarding — con la
 * garantía de cadena del 24-ago, siempre existe. */
async function cuentaDeCotizacion(quoteId: string, token: string, api: string): Promise<{ id: string; nombre: string } | null> {
  if (!quoteId) return null
  try {
    const r = await fetch(
      `${api}/crm/v3/Cotizaciones_GeoVictoria/${encodeURIComponent(quoteId)}?fields=Cuenta_Asociada`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` }, cache: "no-store" },
    )
    if (r.status !== 200) return null
    const c = ((await r.json().catch(() => ({}))) as {
      data?: Array<{ Cuenta_Asociada?: { id?: string; name?: string } | null }>
    }).data?.[0]?.Cuenta_Asociada
    return c?.id ? { id: String(c.id), nombre: String(c.name || "") } : null
  } catch {
    return null
  }
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })

  const { getZohoAccessToken } = await import("@/lib/zoho-token")
  const token = await getZohoAccessToken().catch(() => "")
  if (!token) return NextResponse.json({ ok: false, error: "sin token Zoho" }, { status: 500 })
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()

  const q =
    "select id, Token_p_blico, Fecha_ltimo_avance, Link_planilla_carga_usuarios, Implementaci_n_creada, Cotizacion_Asociada " +
    "from Autoservicio_Onboarding where Estado_del_Onboarding = 'Completado' and " +
    "(Link_planilla_carga_usuarios is null or Implementaci_n_creada is null) " +
    "order by Fecha_ltimo_avance desc limit 20"
  const res = await fetch(`${api}/crm/v3/coql`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ select_query: q }),
  }).catch(() => null)
  const filas: FilaZoho[] =
    res && res.ok && res.status !== 204
      ? (((await res.json().catch(() => ({}))) as { data?: FilaZoho[] }).data ?? [])
      : []

  const resultados: Array<{ id: string; accion: string; detalle?: string }> = []
  for (const fila of filas) {
    const tokenPublico = String(fila.Token_p_blico || "").trim()
    if (!tokenPublico) {
      resultados.push({ id: fila.id, accion: "sin_token" })
      continue
    }
    // Gracia: cierre reciente puede estar en vuelo (excels + Flow tardan minutos).
    const avanceMs = Date.parse(String(fila.Fecha_ltimo_avance || "")) || 0
    if (avanceMs && Date.now() - avanceMs < GRACIA_MIN * 60_000) {
      resultados.push({ id: fila.id, accion: "en_gracia" })
      continue
    }
    // Fuera de la ventana (o sin fecha legible): histórico — no se toca.
    if (!avanceMs || Date.now() - avanceMs > VENTANA_DIAS * 24 * 3600_000) {
      resultados.push({ id: fila.id, accion: "historico_fuera_de_ventana" })
      continue
    }
    // Candado: reintento cada 6h, máximo 3 (después queda para gestión humana).
    const kvKey = `ob_vigia_${fila.id}`
    const marca = (await getKvValue(kvKey).catch(() => null)) || ""
    const [ultimoIso, intentosRaw] = marca.split("|")
    const intentos = Number(intentosRaw || 0) || 0
    if (intentos >= MAX_REINTENTOS) {
      resultados.push({ id: fila.id, accion: "agotado" })
      continue
    }
    if (ultimoIso && Date.now() - Date.parse(ultimoIso) < 6 * 3600_000) {
      resultados.push({ id: fila.id, accion: "esperando_reintento" })
      continue
    }
    await setKvValue(kvKey, `${new Date().toISOString()}|${intentos + 1}`).catch(() => {})

    try {
      // Sesión REAL del wizard: fuente de verdad del formData.
      const rSes = await fetch(`${WIZARD_URL}/api/onboarding/${encodeURIComponent(tokenPublico)}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      })
      if (!rSes.ok) {
        resultados.push({ id: fila.id, accion: "sesion_no_disponible", detalle: `HTTP ${rSes.status}` })
        continue
      }
      const ses = (await rSes.json()) as {
        estado?: string
        formData?: { empresa?: Record<string, unknown>; trabajadores?: unknown[] } & Record<string, unknown>
        navigationHistory?: number[]
        id_zoho?: string
      }
      if (String(ses.estado || "").toLowerCase() !== "completado" || !ses.formData?.empresa) {
        resultados.push({ id: fila.id, accion: "sesion_no_completada", detalle: String(ses.estado || "") })
        continue
      }
      const fd = ses.formData
      const empresa = fd.empresa as Record<string, unknown>
      empresa.razonSocial = sanearRazonSocial(String(empresa.razonSocial || ""))
      empresa.nombreFantasia = sanearRazonSocial(String(empresa.nombreFantasia || "")) || empresa.razonSocial
      // CUENTA de Zoho directo en el payload: si la cuenta existe, el nombre
      // real de la empresa manda sobre lo que traía la sesión (fuente Zoho >
      // texto contaminado), y el Flow puede usar el id sin pasar por el deal.
      const cuenta = await cuentaDeCotizacion(String(fila.Cotizacion_Asociada?.id || ""), token, api)
      if (cuenta) {
        empresa.cuentaZohoId = cuenta.id
        if (cuenta.nombre) {
          empresa.razonSocial = cuenta.nombre
          empresa.nombreFantasia = cuenta.nombre
        }
      }
      const totalTrabajadores = Array.isArray(fd.trabajadores) ? fd.trabajadores.length : 0

      const rSubmit = await fetch(`${WIZARD_URL}/api/submit-to-zoho`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({
          accion: "completado",
          eventType: "complete",
          fechaHoraEnvio: new Date().toISOString(),
          id_zoho: fila.id,
          onboardingId: tokenPublico,
          currentStep: 11,
          navigationHistory: ses.navigationHistory || [],
          estado: "Completado",
          fecha_completado: fila.Fecha_ltimo_avance || new Date().toISOString(),
          pais: "Chile",
          totalTrabajadores,
          formData: fd,
          ...(cuenta ? { cuentaZohoId: cuenta.id } : {}),
          metadata: {
            pais: "Chile",
            ...(cuenta ? { cuentaZohoId: cuenta.id } : {}),
            empresaRut: String(empresa.rut || ""),
            empresaNombre: String(empresa.razonSocial || ""),
            pasoActual: 11,
            pasoNombre: "Agradecimiento",
            totalPasos: 12,
            porcentajeProgreso: 100,
            totalTrabajadores,
            decision: "Reenvío automático del cierre (vigía Vicky — el cierre original no llegó a Zoho Flow)",
          },
          excelFile: null,
        }),
      })
      const cuerpo = await rSubmit.text().catch(() => "")
      if (!rSubmit.ok) {
        resultados.push({ id: fila.id, accion: "reenvio_fallo", detalle: `HTTP ${rSubmit.status} ${cuerpo.slice(0, 120)}` })
        continue
      }
      console.log(`[ob-vigia] cierre re-disparado para ${fila.id} (${empresa.razonSocial})`)
      const { avisarEquipoInterno } = await import("@/lib/alerta-interna")
      await avisarEquipoInterno(
        `🛟 VIGÍA ONBOARDING: el cierre del auto-onboarding de "${empresa.razonSocial}" estaba Completado pero sin ` +
          `planillas/implementación — se re-disparó automáticamente. Verificar en unos minutos que el registro tenga sus links e IMP.`,
      ).catch(() => {})
      resultados.push({ id: fila.id, accion: "reenviado" })
    } catch (e) {
      resultados.push({ id: fila.id, accion: "error", detalle: e instanceof Error ? e.message.slice(0, 120) : "?" })
    }
  }

  return NextResponse.json({ ok: true, candidatos: filas.length, resultados })
}
