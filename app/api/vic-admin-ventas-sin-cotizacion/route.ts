/**
 * ADMIN — VENTAS CERRADAS SIN COTIZACIÓN PAGADA (Lalo 14-sep).
 *
 * Nace del cruce de las cotizaciones armadas a mano en Creator: 11 clientes
 * chilenos que HOY están facturando o implementando y para los que no existe
 * ninguna cotización en estado Pagada. Para el dash esas ventas no existen —
 * cuenta cotizaciones pagadas — así que quedan congeladas en "vio precio" o
 * "formal enviada" y le bajan la tasa de cierre a Vicky por ventas que sí se
 * hicieron.
 *
 * La incoherencia que caza es simple y no depende de Creator: **deal en 6/7/8
 * de un cliente que conversó con Vicky y que vio precio o recibió formal, sin
 * una sola cotización pagada**. Da igual por dónde se haya cerrado.
 *
 * POR QUÉ NO FILTRA POR `Gesti_n_Vicky`: sería una COQL y nada más, pero de
 * los 12 casos del levantamiento **3 no tienen el campo estampado** (los
 * deals que creó un ejecutivo nunca entraron al universo del cron de
 * limpieza). Se cruza por TELÉFONO contra el universo de precio de Vicky, que
 * es completo.
 *
 * Solo lectura. GET ?key=<cron>&desde=YYYY-MM-DD[&pais=56][&csv=1]
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { getZohoAccessToken } from "@/lib/zoho-token"
import { contactosConPrecioYRut } from "@/lib/precio-rut"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const QUOTE_MODULE = (process.env.QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
const ETAPAS_CERRADAS = ["6. Listo para Cierre", "7. Implementando", "8. Facturando"]

async function autorizado(req: Request): Promise<boolean> {
  const secreto = await getFollowupCronSecret().catch(() => "")
  const cron = (process.env.CRON_SECRET || "").trim()
  const url = new URL(req.url)
  const auth = req.headers.get("authorization") || ""
  const dado =
    req.headers.get("x-cron-secret") ||
    (auth.startsWith("Bearer ") ? auth.slice(7) : "") ||
    url.searchParams.get("key") ||
    ""
  return Boolean(dado) && (dado === secreto || (Boolean(cron) && dado === cron))
}

const tel9 = (s: unknown): string => {
  const d = String(s ?? "").replace(/\D/g, "")
  return d.length >= 9 ? d.slice(-9) : ""
}

type FilaDeal = {
  id: string
  Deal_Name?: string | null
  Stage?: string | null
  Created_Time?: string | null
  Gesti_n_Vicky?: string | null
  Valor_fijo_del_trato_Global?: number | null
  "Owner.last_name"?: string | null
  "Contact_Name.Phone"?: string | null
  "Contact_Name.Mobile"?: string | null
  "Account_Name.Account_Name"?: string | null
}

type FilaQuote = {
  id: string
  Name?: string | null
  Estado_Cotizacion?: string | null
  Tel_fono_Contacto?: string | null
  Intervenci_n_Humana?: string | null
  Created_Time?: string | null
  "Deal_Asociado.id"?: string | null
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const sp = new URL(req.url).searchParams
  const desde = (sp.get("desde") || "2026-06-01").trim()
  const prefijo = (sp.get("pais") || "56").trim()
  const t0 = Date.now()
  const fallos: string[] = []

  let token = ""
  try {
    token = await getZohoAccessToken()
  } catch (e) {
    return NextResponse.json({ ok: false, error: `sin token Zoho: ${e instanceof Error ? e.message : "error"}` }, { status: 502 })
  }
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }

  async function coql<T>(select_query: string): Promise<T[]> {
    const r = await fetch(`${api}/crm/v8/coql`, { method: "POST", headers: H, cache: "no-store", body: JSON.stringify({ select_query }) })
    if (r.status === 204) return []
    if (!r.ok) {
      // Un fallo de COQL NUNCA se traga (cicatriz del 09-sep): sin esto el
      // informe dice "no hay casos" cuando lo que hubo fue un 400.
      fallos.push(`COQL ${r.status}: ${(await r.text().catch(() => "")).slice(0, 180)}`)
      return []
    }
    return ((await r.json().catch(() => ({}))) as { data?: T[] }).data || []
  }

  // ── 1. Universo de Vicky: a quién le mostró precio (mismas firmas del dash) ──
  const precio = await contactosConPrecioYRut({ desde, paisPrefijo: prefijo, exigirRut: false }).catch((e) => {
    fallos.push(`precio: ${e instanceof Error ? e.message : "error"}`)
    return [] as Awaited<ReturnType<typeof contactosConPrecioYRut>>
  })
  const primerPrecio = new Map<string, string>()
  for (const c of precio) primerPrecio.set(tel9(c.tel), String(c.primerPrecio || "").slice(0, 10))

  // ── 2. Cotizaciones: quién tiene alguna PAGADA y quién recibió formal de Vicky ──
  const pagadaTel = new Set<string>()
  const pagadaDeal = new Set<string>()
  const formalTel = new Map<string, Array<{ nombre: string; estado: string; fecha: string }>>()
  const formalDeal = new Set<string>()
  for (let off = 0; off < 4000; off += 200) {
    const lote = await coql<FilaQuote>(
      `select id, Name, Estado_Cotizacion, Tel_fono_Contacto, Intervenci_n_Humana, Created_Time, Deal_Asociado.id ` +
        `from ${QUOTE_MODULE} where Created_Time > '${desde}T00:00:00+00:00' order by Created_Time asc limit ${off}, 200`,
    )
    for (const q of lote) {
      const t = tel9(q.Tel_fono_Contacto)
      const d = String(q["Deal_Asociado.id"] || "")
      const estado = String(q.Estado_Cotizacion || "")
      if (/pagad/i.test(estado)) {
        if (t) pagadaTel.add(t)
        if (d) pagadaDeal.add(d)
      }
      if (q.Intervenci_n_Humana === "100% Vicky") {
        if (t) {
          const arr = formalTel.get(t) || []
          arr.push({ nombre: String(q.Name || ""), estado, fecha: String(q.Created_Time || "").slice(0, 10) })
          formalTel.set(t, arr)
        }
        if (d) formalDeal.add(d)
      }
    }
    if (lote.length < 200) break
  }

  // ── 3. Deals ya cerrados (6/7/8) con el teléfono de su contacto ──
  const enEtapa = ETAPAS_CERRADAS.map((s) => `'${s}'`).join(",")
  const deals: FilaDeal[] = []
  for (let off = 0; off < 6000; off += 200) {
    const lote = await coql<FilaDeal>(
      `select id, Deal_Name, Stage, Created_Time, Gesti_n_Vicky, Valor_fijo_del_trato_Global, Owner.last_name, ` +
        `Contact_Name.Phone, Contact_Name.Mobile, Account_Name.Account_Name from Deals ` +
        `where ((Stage in (${enEtapa})) and (Created_Time > '${desde}T00:00:00+00:00')) order by Created_Time asc limit ${off}, 200`,
    )
    deals.push(...lote)
    if (lote.length < 200) break
    if (Date.now() - t0 > 240_000) { fallos.push("corte por presupuesto de tiempo al paginar deals"); break }
  }

  // ── 4. La incoherencia ──
  const casos = deals
    .map((d) => {
      const tel = tel9(d["Contact_Name.Phone"]) || tel9(d["Contact_Name.Mobile"])
      return { d, tel }
    })
    .filter(({ d, tel }) => {
      // El país NO se juzga acá: el teléfono del contacto en Zoho viene tanto
      // con prefijo como sin él, y el universo de precio ya filtró por país.
      if (!tel) return false
      if (!primerPrecio.has(tel) && !formalTel.has(tel)) return false // nunca vio precio ni recibió formal de Vicky
      if (pagadaTel.has(tel)) return false
      if (pagadaDeal.has(d.id)) return false
      return true
    })
    .map(({ d, tel }) => ({
      empresa: String(d["Account_Name.Account_Name"] || d.Deal_Name || "").slice(0, 80),
      deal: String(d.Deal_Name || "").slice(0, 70),
      dealId: d.id,
      link: `https://crm.zoho.com/crm/tab/Potentials/${d.id}`,
      etapa: String(d.Stage || ""),
      dueno: String(d["Owner.last_name"] || ""),
      gestionVicky: d.Gesti_n_Vicky || null,
      valorFijoClp: d.Valor_fijo_del_trato_Global ?? null,
      tel,
      primerPrecio: primerPrecio.get(tel) || null,
      cotizacionesVicky: (formalTel.get(tel) || []).map((x) => `${x.nombre} [${x.estado}] ${x.fecha}`),
      creado: String(d.Created_Time || "").slice(0, 10),
    }))
    .sort((a, b) => a.creado.localeCompare(b.creado))

  if (sp.get("csv") === "1") {
    const filas = [
      "empresa;etapa;dueno;creado;primer_precio;gestion_vicky;valor_fijo;cotizaciones_vicky;link",
      ...casos.map((c) =>
        [c.empresa, c.etapa, c.dueno, c.creado, c.primerPrecio || "", c.gestionVicky || "", c.valorFijoClp ?? "", c.cotizacionesVicky.join(" | "), c.link]
          .map((x) => String(x).replace(/[;\n]/g, " "))
          .join(";"),
      ),
    ].join("\n")
    return new NextResponse(filas, { headers: { "Content-Type": "text/csv; charset=utf-8" } })
  }

  return NextResponse.json({
    ok: true,
    desde,
    definicion:
      "deal en 6/7/8 de un cliente al que Vicky le mostró precio o le emitió formal, sin NINGUNA cotización en estado Pagada (ni por teléfono ni por deal)",
    universo: {
      contactosConPrecio: primerPrecio.size,
      contactosConFormalDeVicky: formalTel.size,
      dealsCerradosRevisados: deals.length,
      telefonosConCotizacionPagada: pagadaTel.size,
    },
    casos: casos.length,
    porEtapa: casos.reduce<Record<string, number>>((a, c) => ({ ...a, [c.etapa]: (a[c.etapa] || 0) + 1 }), {}),
    conGestionVickyEstampada: casos.filter((c) => c.gestionVicky).length,
    limites:
      "el cruce es por teléfono del contacto del deal y por deal asociado; un deal cuyo contacto no tiene teléfono en Zoho no se puede juzgar y queda fuera",
    fallos,
    ms: Date.now() - t0,
    lista: casos,
  })
}
