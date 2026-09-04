/**
 * ADMIN — explorador de Zoho Bookings (03-sep).
 *
 * Existe para que las credenciales de Bookings NUNCA tengan que pasar por una
 * consola ni por un chat: viven en las env de Vercel y este endpoint las lee.
 * Sirve para verificar que el token quedó bien y para descubrir los IDs que la
 * habilidad de agendamiento necesita (workspace, servicio del "Curso 1",
 * relator), que no se pueden deducir del link público de reserva.
 *
 *   GET ?key=<cron>                     → ¿configurado? ¿el token renueva?
 *   GET ?key=<cron>&workspaces=1        → espacios de trabajo
 *   GET ?key=<cron>&servicios=<wsId>    → servicios (acá está el Curso 1)
 *   GET ?key=<cron>&staff=<serviceId>   → relatores del servicio
 *   GET ?key=<cron>&cupos=<serviceId>   → horarios libres, respetando la
 *                                         holgura de 2 días hábiles
 *
 * SOLO LECTURA. No agenda nada.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import {
  fetchDisponibilidad,
  bookingsConfigurado,
  accessTokenBookings,
  fetchWorkspaces,
  fetchServicios,
  fetchStaff,
} from "@/lib/zoho-bookings"

export const dynamic = "force-dynamic"
export const maxDuration = 30

async function autorizado(req: Request): Promise<boolean> {
  const url = new URL(req.url)
  const dado =
    req.headers.get("x-cron-secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim() ||
    url.searchParams.get("key") ||
    ""
  if (!dado) return false
  const kv = await getFollowupCronSecret().catch(() => "")
  return dado === (process.env.CRON_SECRET || "").trim() || (Boolean(kv) && dado === kv)
}

export async function GET(req: Request): Promise<Response> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const sp = new URL(req.url).searchParams

  if (!bookingsConfigurado()) {
    return NextResponse.json({
      ok: false,
      configurado: false,
      falta: ["ZOHO_BOOKINGS_CLIENT_ID", "ZOHO_BOOKINGS_CLIENT_SECRET", "ZOHO_BOOKINGS_REFRESH_TOKEN"].filter(
        (n) => !(process.env[n] || "").trim(),
      ),
    })
  }

  const ws = sp.get("servicios")
  if (ws) return NextResponse.json({ ok: true, workspaceId: ws, servicios: await fetchServicios(ws) })
  const svc = sp.get("staff")
  if (svc) return NextResponse.json({ ok: true, serviceId: svc, staff: await fetchStaff(svc) })
  if (sp.get("workspaces") === "1") return NextResponse.json({ ok: true, workspaces: await fetchWorkspaces() })

  // CUPOS con la holgura ya aplicada (Lalo 04-sep, "2 días laborales de
  // holgura"): jamás se pregunta por hoy ni por mañana, así que lo que
  // devuelve este endpoint es exactamente lo que se le puede ofrecer al
  // cliente. `dias` mira más adelante; `feriados` acepta YYYY-MM-DD por coma.
  const cupos = (sp.get("cupos") || "").trim()
  if (cupos) {
    const { fechasAgendables, aFormatoBookings } = await import("@/lib/onboarding/agenda-capacitacion")
    const feriados = new Set(
      (sp.get("feriados") || "").split(",").map((f) => f.trim()).filter(Boolean),
    )
    const dias = Math.min(Math.max(Number(sp.get("dias") || 3) || 3, 1), 10)
    const fechas = fechasAgendables(new Date(), dias, feriados)
    const porDia = []
    for (const f of fechas) {
      const r = (await fetchDisponibilidad(cupos, aFormatoBookings(f)).catch(() => null)) as
        | { response?: { returnvalue?: { data?: unknown } } }
        | null
      const data = r?.response?.returnvalue?.data
      porDia.push({ fecha: f, cupos: Array.isArray(data) ? data : data ? [data] : [] })
    }
    return NextResponse.json({ ok: true, servicio: cupos, desde: fechas[0], dias: porDia })
  }

  // Por defecto: solo confirma que el refresh token renueva. Nunca devuelve
  // el token — este endpoint no filtra credenciales ni siquiera al admin.
  const token = await accessTokenBookings()
  return NextResponse.json({
    ok: Boolean(token),
    configurado: true,
    tokenRenueva: Boolean(token),
    detalle: token ? "el refresh token responde" : "el refresh token NO renueva — revisar credenciales",
  })
}
