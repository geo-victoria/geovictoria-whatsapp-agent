/**
 * ADMIN — LEVANTAMIENTO (solo lectura): toda conversación con PRECIO MOSTRADO
 * y RUT, ¿tiene su deal y con la data al día?
 *
 * Orden de Lalo 10-sep: "asegurémonos que toda conversación con precio
 * mostrado y rut tenga su deal correspondiente con su data actualizada hasta
 * el hito que llegó (valor del trato, stage, empleados, moneda, gestión
 * vicky, tipo de cobro, etc.)" · "primero un levantamiento de data".
 *
 * NO ESCRIBE NADA. Cruza en memoria para no gastar mil búsquedas por
 * teléfono: baja los Deals y Leads del año por COQL paginada y los empareja
 * con el universo de lib/precio-rut por los últimos 9 dígitos.
 *
 * Qué se considera "al día" para una conversación que llegó a ver precio
 * (biblia CRM: preform visto en adelante → "4. Propuesta Enviada"):
 *   stage ≥ 4 · valor recurrente > 1.000 CLP · empleados > 0 ·
 *   moneda CLP · tipo "Mensual fijo" · Gestión Vicky estampada.
 *
 * GET ?key=<cron>[&desde=2026-01-01][&detalle=40]
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { getZohoAccessToken } from "@/lib/zoho-token"
import { contactosConPrecioYRut } from "@/lib/precio-rut"
import { montoDelBloque } from "@/lib/precio-bloque"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const ORDEN_STAGE = ["1.", "2.", "3.", "4.", "5.", "6.", "7.", "8."]
const nivel = (s: string): number => {
  const i = ORDEN_STAGE.findIndex((p) => String(s || "").trim().startsWith(p))
  return i < 0 ? (/perdido/i.test(String(s || "")) ? -1 : 0) : i + 1
}

async function autorizado(req: Request): Promise<boolean> {
  const secreto = await getFollowupCronSecret().catch(() => "")
  const cron = (process.env.CRON_SECRET || "").trim()
  const auth = req.headers.get("authorization") || ""
  const url = new URL(req.url)
  const entregado =
    req.headers.get("x-cron-secret") || (auth.startsWith("Bearer ") ? auth.slice(7) : "") || url.searchParams.get("key") || ""
  return Boolean(entregado) && (entregado === secreto || (Boolean(cron) && entregado === cron))
}

type DealZ = {
  id?: string
  Deal_Name?: string
  Stage?: string
  Valor_fijo_del_trato_Global?: number | null
  N_Empleados_que_marcan?: number | null
  Monda_del_trato?: string | null
  Tipo_de_Cobro?: string | null
  Gesti_n_Vicky?: string | null
  Atribuci_n_Vicky?: string | null
  "Contact_Name.Phone"?: string | null
  "Contact_Name.Mobile"?: string | null
  Created_Time?: string
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const sp = new URL(req.url).searchParams
  const desde = (sp.get("desde") || "2026-01-01").trim()
  const topeDetalle = Math.min(200, Math.max(10, Number(sp.get("detalle") || 40)))
  const token = await getZohoAccessToken().catch(() => "")
  if (!token) return NextResponse.json({ ok: false, error: "sin token zoho" }, { status: 502 })
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
  // OJO (cicatriz del 09-sep y otra vez hoy): una COQL con una columna
  // inválida devuelve 400 y, si el error se traga, el cruce sale VACÍO y el
  // informe miente. `RUT_Empresa` no existe en Deals: por eso la primera
  // corrida indexó 0 deals. Los fallos se acumulan y se devuelven.
  const fallosCoql: string[] = []
  const coql = async <T,>(q: string): Promise<T[]> => {
    const r = await fetch(`${api}/crm/v3/coql`, { method: "POST", headers: H, cache: "no-store", body: JSON.stringify({ select_query: q }) }).catch(() => null)
    if (!r) { fallosCoql.push("sin respuesta"); return [] }
    if (r.status === 204) return []
    if (!r.ok) {
      const cuerpo = await r.text().catch(() => "")
      fallosCoql.push(`${r.status} ${cuerpo.slice(0, 160)}`)
      return []
    }
    return (((await r.json().catch(() => ({}))) as { data?: T[] }).data) || []
  }

  const universo = await contactosConPrecioYRut({ desde, paisPrefijo: "56" })
  if (!universo.length) return NextResponse.json({ ok: true, universo: 0, nota: "sin conversaciones con precio y RUT" })

  // Deals del año, por COQL paginada, indexados por los 9 dígitos del contacto.
  const dealPorNueve = new Map<string, DealZ>()
  for (let off = 0; off < 12000; off += 200) {
    const lote = await coql<DealZ>(
      `select id, Deal_Name, Stage, Valor_fijo_del_trato_Global, N_Empleados_que_marcan, Monda_del_trato, Tipo_de_Cobro, ` +
      `Gesti_n_Vicky, Atribuci_n_Vicky, Contact_Name.Phone, Contact_Name.Mobile, Created_Time from Deals ` +
      `where Created_Time >= '${desde}T00:00:00+00:00' order by Created_Time desc limit ${off}, 200`,
    )
    for (const d of lote) {
      for (const t of [d["Contact_Name.Mobile"], d["Contact_Name.Phone"]]) {
        const n = String(t || "").replace(/\D/g, "").slice(-9)
        if (n.length !== 9) continue
        const prev = dealPorNueve.get(n)
        // Se queda el más AVANZADO; a igual etapa, el más nuevo.
        if (!prev || nivel(String(d.Stage || "")) > nivel(String(prev.Stage || ""))) dealPorNueve.set(n, d)
      }
    }
    if (lote.length < 200) break
  }
  // Leads del año (para saber si al menos hay lead).
  const leadPorNueve = new Map<string, { id?: string; Last_Name?: string; Lead_Status?: string; Gesti_n_Vicky?: string | null; "Owner.email"?: string }>()
  for (let off = 0; off < 8000; off += 200) {
    const lote = await coql<{ id?: string; Phone?: string; Last_Name?: string; Lead_Status?: string; Gesti_n_Vicky?: string | null; "Owner.email"?: string }>(
      `select id, Phone, Last_Name, Lead_Status, Gesti_n_Vicky, Owner.email from Leads where Created_Time >= '${desde}T00:00:00+00:00' order by Created_Time desc limit ${off}, 200`,
    )
    for (const l of lote) {
      const n = String(l.Phone || "").replace(/\D/g, "").slice(-9)
      if (n.length === 9 && !leadPorNueve.has(n)) leadPorNueve.set(n, l)
    }
    if (lote.length < 200) break
  }

  const faltaDeal: Array<Record<string, unknown>> = []
  const incompletos: Array<Record<string, unknown>> = []
  let alDia = 0
  const cuentaFalla = { stage: 0, valor: 0, empleados: 0, moneda: 0, tipo: 0, gestion: 0 }
  for (const c of universo) {
    const nueve = c.tel.slice(-9)
    const d = dealPorNueve.get(nueve)
    const m = montoDelBloque(c.ultimoTexto)
    const netoAprox = m.clp ? Math.round(m.clp / 1.19) : null
    if (!d) {
      const l = leadPorNueve.get(nueve)
      faltaDeal.push({
        tel: c.tel, rut: c.rut, ultimoPrecio: c.ultimoPrecio.slice(0, 10), recurrenteNetoAprox: netoAprox,
        lead: l ? { id: l.id, nombre: l.Last_Name, status: l.Lead_Status, dueno: l["Owner.email"], gestion: l.Gesti_n_Vicky || null } : null,
      })
      continue
    }
    const falla: string[] = []
    if (nivel(String(d.Stage || "")) > 0 && nivel(String(d.Stage || "")) < 4) { falla.push("stage<4"); cuentaFalla.stage++ }
    const v = Number(d.Valor_fijo_del_trato_Global || 0)
    if (!(v > 1000)) { falla.push(v > 0 ? `valor implausible ${v}` : "sin valor"); cuentaFalla.valor++ }
    if (!(Number(d.N_Empleados_que_marcan || 0) > 0)) { falla.push("sin empleados"); cuentaFalla.empleados++ }
    if (String(d.Monda_del_trato || "") !== "CLP") { falla.push(`moneda ${d.Monda_del_trato || "vacía"}`); cuentaFalla.moneda++ }
    if (String(d.Tipo_de_Cobro || "") !== "Mensual fijo") { falla.push(`tipo ${d.Tipo_de_Cobro || "vacío"}`); cuentaFalla.tipo++ }
    if (!String(d.Gesti_n_Vicky || "").trim()) { falla.push("sin Gestión Vicky"); cuentaFalla.gestion++ }
    if (!falla.length) { alDia++; continue }
    incompletos.push({
      tel: c.tel, rut: c.rut, dealId: d.id, deal: d.Deal_Name, etapa: d.Stage,
      valor: d.Valor_fijo_del_trato_Global, empleados: d.N_Empleados_que_marcan,
      moneda: d.Monda_del_trato, tipo: d.Tipo_de_Cobro, gestion: d.Gesti_n_Vicky,
      recurrenteNetoAprox: netoAprox, falta: falla,
    })
  }

  return NextResponse.json({
    ok: true,
    desde,
    nota: "solo lectura; 'al día' para quien vio precio = stage>=4, valor>1.000 CLP, empleados>0, moneda CLP, tipo Mensual fijo y Gestión Vicky estampada",
    universoPrecioYRut: universo.length,
    dealsIndexados: dealPorNueve.size,
    fallosCoql: fallosCoql.slice(0, 5),
    leadsIndexados: leadPorNueve.size,
    resumen: {
      alDia,
      incompletos: incompletos.length,
      sinDeal: faltaDeal.length,
      sinDealPeroConLead: faltaDeal.filter((x) => x.lead).length,
      sinDealNiLead: faltaDeal.filter((x) => !x.lead).length,
    },
    faltasPorCampo: cuentaFalla,
    montoRecurrenteQueSeLevantaria: incompletos
      .filter((x) => typeof x.recurrenteNetoAprox === "number" && !(Number(x.valor) > 1000))
      .reduce((a, x) => a + Number(x.recurrenteNetoAprox || 0), 0),
    sinDeal: faltaDeal.slice(0, topeDetalle),
    incompletosDetalle: incompletos.slice(0, topeDetalle),
  })
}
