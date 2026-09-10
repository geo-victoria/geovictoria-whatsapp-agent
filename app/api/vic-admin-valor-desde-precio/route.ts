/**
 * ADMIN — poner el VALOR del deal desde el PRECIO VIGENTE MOSTRADO en el chat
 * (orden de Lalo 10-sep: "actualiza los 20 que están en 0 con la data del
 * precio vigente mostrado, solo lo recurrente").
 *
 * Por qué existe: el pase de vic-admin-deal-limpieza escribe el valor solo si
 * puede calcular el recurrente DESDE LA COTIZACIÓN; cuando el cliente vio
 * precio pero nunca se emitió formal, el campo queda nulo (o con la tarifa en
 * UF que dejó un workflow de Zoho, 0,75) y el forecast cuenta ese deal en $0.
 * Acá la fuente es el ÚLTIMO bloque de precio que Vicky le mostró.
 *
 * Del bloque se toma SOLO LO RECURRENTE: el "Total mensual con IVA" ya es la
 * suma de lo mensual (plan más arriendo si lo hubo) y NO incluye los pagos
 * únicos. Se pasa a NETO dividiendo por 1,19, porque la convención del deal
 * (Lalo 20-ago y 09-sep) es recurrente mensual NETO en CLP.
 *
 * POST {dealIds:[...], dry?:true, uf?:number, incluirPruebas?:false}
 *   · dry (default TRUE) simula y no escribe nada.
 *   · uf: valor de la UF para los bloques que solo traen UF.
 *   · Solo Chile: en CO/MX/PE el bloque está en su moneda y convertirlo sería
 *     inventar; esos deals se reportan como omitidos.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { getZohoAccessToken } from "@/lib/zoho-token"
import { montoDelBloque } from "@/lib/precio-bloque"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const FIRMAS = ["Resumen mensual", "Total mensual con IVA", "UF + IVA al mes", "Total mensual"]
const IVA = 1.19
/** Nombres que delatan un deal interno de prueba (mismo criterio del dash). */
const ES_PRUEBA = /prueba|test|huellerocompany|grovictoria|tu empresa/i

async function autorizado(req: Request): Promise<boolean> {
  const secreto = await getFollowupCronSecret().catch(() => "")
  const cron = (process.env.CRON_SECRET || "").trim()
  const auth = req.headers.get("authorization") || ""
  const url = new URL(req.url)
  const entregado =
    req.headers.get("x-cron-secret") || (auth.startsWith("Bearer ") ? auth.slice(7) : "") || url.searchParams.get("key") || ""
  return Boolean(entregado) && (entregado === secreto || (Boolean(cron) && entregado === cron))
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const body = (await req.json().catch(() => ({}))) as { dealIds?: string[]; dry?: boolean; uf?: number; incluirPruebas?: boolean }
  const ids = (body.dealIds || []).map((x) => String(x || "").trim()).filter((x) => /^\d{10,}$/.test(x))
  if (!ids.length) return NextResponse.json({ ok: false, error: "falta dealIds" }, { status: 400 })
  const dry = body.dry !== false
  const uf = Math.max(0, Number(body.uf || 0)) || 0
  const token = await getZohoAccessToken().catch(() => "")
  if (!token) return NextResponse.json({ ok: false, error: "sin token zoho" }, { status: 502 })
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
  const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }

  const salida: Array<Record<string, unknown>> = []
  for (const dealId of ids) {
    const rd = await fetch(`${api}/crm/v3/Deals/${dealId}?fields=Deal_Name,Stage,Owner,Valor_fijo_del_trato_Global,Tipo_de_Cobro,Monda_del_trato,Contact_Name`, { headers: H, cache: "no-store" }).catch(() => null)
    const deal = rd?.status === 200
      ? (((await rd.json().catch(() => ({}))) as {
          data?: Array<{ Deal_Name?: string; Stage?: string; Valor_fijo_del_trato_Global?: number | null; Contact_Name?: { id?: string } | null }>
        }).data || [])[0]
      : null
    if (!deal) { salida.push({ dealId, omitido: "deal no encontrado" }); continue }
    const nombre = String(deal.Deal_Name || "")
    if (ES_PRUEBA.test(nombre) && !body.incluirPruebas) {
      salida.push({ dealId, deal: nombre, omitido: "parece deal de prueba (usa incluirPruebas)" })
      continue
    }
    // Teléfono del contacto del deal.
    let tel = ""
    if (deal.Contact_Name?.id) {
      const rc = await fetch(`${api}/crm/v3/Contacts/${deal.Contact_Name.id}?fields=Phone,Mobile`, { headers: H, cache: "no-store" }).catch(() => null)
      const c = rc?.status === 200 ? (((await rc.json().catch(() => ({}))) as { data?: Array<{ Phone?: string; Mobile?: string }> }).data || [])[0] : null
      tel = String(c?.Mobile || c?.Phone || "").replace(/\D/g, "")
    }
    if (!tel) { salida.push({ dealId, deal: nombre, omitido: "sin teléfono del contacto" }); continue }
    if (!tel.startsWith("56")) { salida.push({ dealId, deal: nombre, tel, omitido: "fuera de Chile: el bloque está en otra moneda" }); continue }

    // ÚLTIMO bloque de precio de ese contacto.
    const rconv = await fetch(`${SUPABASE_URL}/rest/v1/vic_v3_conversations?contact=eq.${tel}&select=id`, { headers: h, cache: "no-store" }).catch(() => null)
    const convs = rconv?.ok ? ((await rconv.json().catch(() => [])) as Array<{ id: string }>) : []
    if (!convs.length) { salida.push({ dealId, deal: nombre, tel, omitido: "sin conversación" }); continue }
    const orFirmas = FIRMAS.map((f) => `content.ilike.*${encodeURIComponent(f)}*`).join(",")
    const lista = convs.map((c) => `"${c.id}"`).join(",")
    const rm = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_v3_messages?conversation_id=in.(${lista})&role=eq.assistant&or=(${orFirmas})&select=content,at&order=at.desc&limit=1`,
      { headers: h, cache: "no-store" },
    ).catch(() => null)
    const msg = rm?.ok ? ((await rm.json().catch(() => [])) as Array<{ content?: string; at?: string }>)[0] : null
    if (!msg) { salida.push({ dealId, deal: nombre, tel, omitido: "sin bloque de precio en el chat" }); continue }
    const m = montoDelBloque(String(msg.content || ""))
    const conIva = m.clp || (m.uf && uf ? m.uf * uf : 0)
    if (!conIva) { salida.push({ dealId, deal: nombre, tel, omitido: `bloque sin monto legible${m.uf ? " (solo UF, pasa ?uf=)" : ""}` }); continue }
    const neto = Math.round(conIva / IVA)
    const antes = Number(deal.Valor_fijo_del_trato_Global || 0)
    const fila: Record<string, unknown> = {
      dealId, deal: nombre, etapa: deal.Stage, tel,
      precioMostradoAt: msg.at,
      totalConIvaClp: Math.round(conIva),
      recurrenteNetoClp: neto,
      valorAntes: antes,
    }
    if (!dry) {
      const put = await fetch(`${api}/crm/v3/Deals`, {
        method: "PUT", headers: H, cache: "no-store",
        body: JSON.stringify({
          data: [{
            id: dealId,
            Valor_fijo_del_trato_Global: neto,
            Tipo_de_Cobro: "Mensual fijo",
            Monda_del_trato: "CLP",
            Valor_por_usuario_Global: null,
          }],
          trigger: ["blueprint"],
          skip_feature_execution: [{ name: "assignment_rules" }],
        }),
      }).catch(() => null)
      fila.escrito = Boolean(put?.ok)
      if (put?.ok) {
        await fetch(`${api}/crm/v3/Notes`, {
          method: "POST", headers: H, cache: "no-store",
          body: JSON.stringify({
            data: [{
              Note_Title: "Valor del trato desde el precio mostrado por Vicky",
              Note_Content:
                `El deal estaba en ${antes || 0} y el forecast lo contaba en cero. Se tomó el ÚLTIMO precio que Vicky le mostró al cliente ` +
                `(${String(msg.at || "").slice(0, 16).replace("T", " ")} UTC): total mensual con IVA $${Math.round(conIva).toLocaleString("es-CL")} → ` +
                `recurrente mensual NETO $${neto.toLocaleString("es-CL")}, que es la convención del campo. Solo lo RECURRENTE: los pagos únicos no entran.`,
              Parent_Id: { module: { api_name: "Deals" }, id: dealId },
            }],
          }),
        }).catch(() => null)
      }
    }
    salida.push(fila)
  }

  const conValor = salida.filter((x) => typeof x.recurrenteNetoClp === "number")
  return NextResponse.json({
    ok: true,
    dry,
    ufUsada: uf || null,
    revisados: ids.length,
    conPrecio: conValor.length,
    omitidos: salida.length - conValor.length,
    sumaRecurrenteNetoClp: conValor.reduce((a, x) => a + (Number(x.recurrenteNetoClp) || 0), 0),
    detalle: salida,
  })
}
