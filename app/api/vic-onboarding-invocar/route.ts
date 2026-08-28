/**
 * INVOCACIÓN EXTERNA de Vicky Onboarding (24-ago, diseño con Lalo).
 *
 * POST /api/vic-onboarding-invocar  (auth: x-cron-secret / Bearer / ?key=)
 *   { contact: "56912345678" }                        → invocación directa
 *   { dealId: "35250450..." }                         → resuelve el teléfono
 *     declarado en el TRATO y prellena empresa/RUT/admin desde Zoho
 *   opcionales: empresa, rutEmpresa, admin{nombre,apellido,email}
 *
 * Qué hace, en orden:
 *   1. Resuelve el contacto (teléfono del deal si vino dealId).
 *   2. SIEMBRA el borrador con los datos comerciales (lo declarado en el
 *      chat, si existe, gana — sembrarBorrador conserva lo previo).
 *   3. Enrola el contacto en el PILOTO (vic_kv onboarding_piloto) para que
 *      el webhook lo rutee al agente de onboarding aunque el flag global
 *      esté apagado.
 *   4. Marca fase venta→onboarding y entrega el KICKOFF (texto libre si la
 *      ventana de 24h está abierta; plantilla vicky_alta_cuenta_cl si no).
 *
 * Pensado para: botón/workflow del CRM ("iniciar onboarding de este trato"),
 * pruebas del equipo y cualquier sistema con el secreto. La puerta del PAGO
 * (cerrarYTraspasarPostPago) sigue siendo la entrada natural — esto es la
 * segunda puerta, y ambas convergen al MISMO estado (kv fase + borrador).
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret, getKvValue, setKvValue } from "@/lib/supabase-persistence-v3"
import { claveFase, claveBorrador, claveAltaSolicitada, claveConfiguracion } from "@/lib/onboarding/fase"
import { parsearBorrador, sembrarBorrador, type DatosParciales } from "@/lib/onboarding/borrador"
import { entregarKickoffOnboarding } from "@/lib/onboarding-envio"

export const dynamic = "force-dynamic"
export const maxDuration = 60

async function autorizado(req: Request): Promise<boolean> {
  const secreto = await getFollowupCronSecret().catch(() => "")
  const url = new URL(req.url)
  const auth = req.headers.get("authorization") || ""
  const entregado =
    req.headers.get("x-cron-secret") || (auth.startsWith("Bearer ") ? auth.slice(7) : "") || url.searchParams.get("key") || ""
  const cronEnv = (process.env.CRON_SECRET || "").trim()
  return Boolean(entregado) && (entregado === secreto || (Boolean(cronEnv) && entregado === cronEnv))
}

type Cuerpo = {
  contact?: string
  dealId?: string
  empresa?: string
  rutEmpresa?: string
  admin?: { nombre?: string; apellido?: string; email?: string }
}

/** Teléfono + prellenado desde el TRATO ("en el trato se declaró el número"). */
async function desdeDeal(dealId: string): Promise<{
  contact: string
  empresa?: string
  rutEmpresa?: string
  admin?: { nombre?: string; apellido?: string; email?: string }
} | null> {
  const { getZohoAccessToken } = await import("@/lib/zoho-token")
  const token = await getZohoAccessToken().catch(() => "")
  if (!token) return null
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  const H = { Authorization: `Zoho-oauthtoken ${token}` }
  const r = await fetch(
    `${api}/crm/v3/Deals/${encodeURIComponent(dealId)}?fields=Contact_Phone,Rut_ID_Account,Account_Name,Contact_Name,Contact_Email`,
    { headers: H, cache: "no-store" },
  ).catch(() => null)
  if (!r || r.status !== 200) return null
  const d = ((await r.json().catch(() => ({}))) as {
    data?: Array<{
      Contact_Phone?: string | null
      Rut_ID_Account?: string | null
      Account_Name?: { name?: string } | null
      Contact_Name?: { name?: string; id?: string } | null
      Contact_Email?: string | null
    }>
  }).data?.[0]
  const fono = String(d?.Contact_Phone || "").replace(/\D/g, "")
  if (!fono) return null
  // Nombre/apellido del admin candidato: la ficha del CONTACTO los trae separados.
  let admin: { nombre?: string; apellido?: string; email?: string } | undefined
  const contactId = d?.Contact_Name?.id
  if (contactId) {
    const rc = await fetch(`${api}/crm/v3/Contacts/${contactId}?fields=First_Name,Last_Name,Email`, {
      headers: H,
      cache: "no-store",
    }).catch(() => null)
    const c = rc && rc.status === 200
      ? ((await rc.json().catch(() => ({}))) as { data?: Array<{ First_Name?: string; Last_Name?: string; Email?: string }> }).data?.[0]
      : undefined
    if (c) admin = { nombre: c.First_Name || undefined, apellido: c.Last_Name || undefined, email: c.Email || d?.Contact_Email || undefined }
  }
  return {
    contact: fono,
    empresa: d?.Account_Name?.name || undefined,
    rutEmpresa: d?.Rut_ID_Account || undefined,
    admin,
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const body = (await req.json().catch(() => ({}))) as Cuerpo

  let contact = String(body.contact || "").replace(/\D/g, "")
  let empresa = (body.empresa || "").trim()
  let rutEmpresa = (body.rutEmpresa || "").trim()
  let admin = body.admin

  if (!contact && body.dealId) {
    const deal = await desdeDeal(String(body.dealId).replace(/\D/g, ""))
    if (!deal) return NextResponse.json({ ok: false, error: "deal sin teléfono utilizable" }, { status: 404 })
    contact = deal.contact
    empresa = empresa || deal.empresa || ""
    rutEmpresa = rutEmpresa || deal.rutEmpresa || ""
    admin = admin || deal.admin
  }
  if (!contact) return NextResponse.json({ ok: false, error: "falta contact o dealId" }, { status: 400 })

  // 1. Sembrar el borrador (lo que el contacto ya haya dicho en el chat gana).
  const previo = parsearBorrador(await getKvValue(claveBorrador(contact)).catch(() => null))
  const semilla: DatosParciales = {
    empresa: { nombre: empresa || undefined, identificador: rutEmpresa || undefined },
    ...(admin ? { admin: { nombre: admin.nombre, apellido: admin.apellido, email: admin.email } } : {}),
  }
  const borrador = sembrarBorrador(previo, semilla, "cl")
  await setKvValue(claveBorrador(contact), JSON.stringify(borrador))

  // 1.5 RESET del ciclo de alta (28-ago, caso "cuenta creada" de mentira): si
  // el contacto ya pasó por un alta (prueba anterior o alta real), el estado
  // viejo (alta_solicitada + configuración F2) dejaba al agente en fase
  // CONFIGURACIÓN sin tools de alta — y el modelo "confirmaba" altas de boca.
  // Invocar = iniciar un alta NUEVA: se limpia ese estado para que el ciclo
  // parta de cero de verdad.
  await setKvValue(claveAltaSolicitada(contact), "").catch(() => {})
  await setKvValue(claveConfiguracion(contact), "").catch(() => {})

  // 2. Enrolar en el piloto (idempotente) para que el webhook rutee la fase.
  const lista = (await getKvValue("onboarding_piloto").catch(() => null)) || ""
  const fonos = lista.split(",").map((s) => s.trim()).filter(Boolean)
  if (!fonos.includes(contact)) {
    await setKvValue("onboarding_piloto", [...fonos, contact].join(","))
  }

  // 3. Fase venta→onboarding.
  await setKvValue(claveFase(contact), "onboarding")

  // 4. Kickoff (texto en ventana, plantilla fuera de ella).
  const kickoff = await entregarKickoffOnboarding(
    contact,
    borrador.empresa.nombre,
    borrador.empresa.identificador,
    borrador.admin.nombre,
  )
  console.log(`[onboarding-invocar] contacto ${contact} → fase onboarding, kickoff via=${kickoff.via}`)
  return NextResponse.json({
    ok: kickoff.via !== "fallo",
    contact,
    kickoff: kickoff.via,
    borrador: { empresa: borrador.empresa, admin: { ...borrador.admin } },
  })
}
