/**
 * ADMIN — dejar la bitácora `vic_ptv` de un contacto CALZADA con el dueño real
 * del deal, sin sortear nada y sin escribirle al cliente.
 *
 * Nace el 11-sep con el caso MSS Asesores / Diego Cubillos (reclamo de Victoria
 * Luna, confirmado por Lalo: "es de Daniela"). El deal volvió a su dueña desde
 * la UI de Zoho, pero `vic_ptv` seguía nombrando a Anderson — y esa fila es la
 * que Vicky lee para decir "te atiende X" y para el chequeo 9h, así que al
 * cliente le habríamos repetido el nombre equivocado. Hasta hoy no existía
 * ninguna puerta admin para escribir esa fila: las únicas que la tocan son
 * `vic-admin-tombolear-deal` (que RE-SORTEA, justo lo que acá no se quiere) y
 * la conciliación SDR.
 *
 * La VERDAD es el Owner del deal en Zoho: no se acepta un correo a mano, se
 * lee el registro. Y de paso se CONGELA el caso para la conciliación
 * (`sdr_recon_deal_<id>` + `sdr_recon_fono_<fono>`), porque un dueño puesto por
 * una persona no se vuelve a mover.
 *
 * `presentado` (default TRUE) deja la presentación por hecha para que ninguna
 * maquinaria le anuncie el cambio al cliente — en este caso ya había recibido
 * tres nombres en un día. Pasar `presentado:false` solo si se decide avisarle.
 *
 * POST {dealId, contact?, motivo?, presentado?}  ·  auth de cron
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret, setKvValue } from "@/lib/supabase-persistence-v3"
import { getZohoAccessToken } from "@/lib/zoho-token"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

async function autorizado(req: Request): Promise<boolean> {
  const secreto = await getFollowupCronSecret().catch(() => "")
  const cron = (process.env.CRON_SECRET || "").trim()
  const auth = req.headers.get("authorization") || ""
  const entregado =
    req.headers.get("x-cron-secret") ||
    (auth.startsWith("Bearer ") ? auth.slice(7) : "") ||
    new URL(req.url).searchParams.get("key") ||
    ""
  return Boolean(entregado) && (entregado === secreto || (Boolean(cron) && entregado === cron))
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  if (!SUPABASE_URL || !SUPABASE_KEY) return NextResponse.json({ ok: false, error: "sin supabase" }, { status: 503 })
  const body = (await req.json().catch(() => ({}))) as {
    dealId?: string
    contact?: string
    motivo?: string
    presentado?: boolean
  }
  const dealId = String(body.dealId || "").trim()
  if (!/^\d{10,}$/.test(dealId)) return NextResponse.json({ ok: false, error: "falta dealId" }, { status: 400 })

  const token = await getZohoAccessToken().catch(() => "")
  if (!token) return NextResponse.json({ ok: false, error: "sin token zoho" }, { status: 502 })
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }

  const rd = await fetch(
    `${api}/crm/v3/Deals/${dealId}?fields=Deal_Name,Owner,Stage,Contact_Name`,
    { headers: H, cache: "no-store" },
  )
  if (rd.status !== 200) return NextResponse.json({ ok: false, error: `deal ${rd.status}` }, { status: 404 })
  const deal = (((await rd.json().catch(() => ({}))) as {
    data?: Array<{ Deal_Name?: string; Stage?: string; Owner?: { id?: string; name?: string; email?: string }; Contact_Name?: { id?: string } | null }>
  }).data || [])[0]
  const owner = deal?.Owner
  if (!owner?.email || !owner.id) return NextResponse.json({ ok: false, error: "deal sin dueño legible" }, { status: 409 })

  // Teléfono: el del body o el del contacto del deal.
  let fono = String(body.contact || "").replace(/\D/g, "")
  if (!fono && deal?.Contact_Name?.id) {
    const rc = await fetch(`${api}/crm/v3/Contacts/${deal.Contact_Name.id}?fields=Phone,Mobile`, { headers: H, cache: "no-store" }).catch(() => null)
    const c = rc?.status === 200 ? (((await rc.json().catch(() => ({}))) as { data?: Array<{ Phone?: string; Mobile?: string }> }).data || [])[0] : null
    fono = String(c?.Mobile || c?.Phone || "").replace(/\D/g, "")
  }
  if (!fono) return NextResponse.json({ ok: false, error: "sin teléfono del contacto" }, { status: 409 })

  const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" }
  const rf = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_ptv?contact=eq.${encodeURIComponent(fono)}&estado=eq.activo&select=id,vendedor_email,vendedor_nombre&limit=1`,
    { headers: h, cache: "no-store" },
  )
  const filas = rf.ok ? (((await rf.json().catch(() => [])) as Array<{ id: string; vendedor_email?: string; vendedor_nombre?: string }>) || []) : []
  const previo = filas[0] || null

  const telefonoVendedor = await (async () => {
    try {
      const { directorioEjecutivos } = await import("@/lib/directorio-ejecutivos")
      const hit = directorioEjecutivos().find(
        (e) => String(e.email || "").toLowerCase() === owner.email!.toLowerCase(),
      )
      return hit?.telefono || ""
    } catch {
      return ""
    }
  })()

  const presentado = body.presentado === false ? false : true
  let filaActualizada = false
  if (previo?.id) {
    const up = await fetch(`${SUPABASE_URL}/rest/v1/vic_ptv?id=eq.${previo.id}`, {
      method: "PATCH",
      headers: h,
      cache: "no-store",
      body: JSON.stringify({
        vendedor_email: owner.email,
        vendedor_nombre: owner.name || owner.email.split("@")[0],
        vendedor_zoho_id: owner.id,
        presentado_al_prospecto: presentado,
        motivo: "dueno_real_del_deal",
      }),
    }).catch(() => null)
    filaActualizada = Boolean(up?.ok)
  }

  // El caso queda FUERA de la conciliación: el dueño lo decidió una persona.
  const sello = `manual:${(body.motivo || "dueno confirmado a mano").slice(0, 60)}:${new Date().toISOString()}`
  await setKvValue(`sdr_recon_deal_${dealId}`, sello).catch(() => {})
  await setKvValue(`sdr_recon_fono_${fono}`, sello).catch(() => {})

  return NextResponse.json({
    ok: true,
    dealId,
    deal: deal?.Deal_Name || "",
    etapa: deal?.Stage || "",
    contacto: fono,
    duenoReal: { nombre: owner.name, email: owner.email, telefono: telefonoVendedor },
    bitacoraAntes: previo ? { email: previo.vendedor_email, nombre: previo.vendedor_nombre } : null,
    filaActualizada,
    presentadoAlProspecto: presentado,
    congelado: sello,
  })
}
