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

  // ── CONTEO DE GESTIÓN VICKY EN DEALS (?conteo=1) — pregunta de Lalo 10-sep:
  // "¿cuántos deals tienen marcado Gestión Vicky? ¿cuántos de esos ya tienen
  // el valor conocido?". COQL no cuenta sin group by, así que se pagina y se
  // cuenta acá. VALOR CONOCIDO = `Valor_fijo_del_trato_Global` > 1.000 CLP:
  // bajo mil es la tarifa en UF disfrazada, y el forecast la lee como cero.
  if (sp.get("conteo") === "1") {
    const porMarca = new Map<string, { deals: number; conValor: number; implausible: number; sinValor: number; sumaClp: number }>()
    let total = 0
    for (let off = 0; off < 9800; off += 200) {
      const lote = await coql<{ Gesti_n_Vicky?: string | null; Valor_fijo_del_trato_Global?: number | null; Stage?: string }>(
        `select id, Gesti_n_Vicky, Valor_fijo_del_trato_Global, Stage from Deals where Gesti_n_Vicky is not null order by Created_Time desc limit ${off}, 200`,
      )
      for (const d of lote) {
        total++
        const k = String(d.Gesti_n_Vicky || "(vacío)")
        const acc = porMarca.get(k) || { deals: 0, conValor: 0, implausible: 0, sinValor: 0, sumaClp: 0 }
        acc.deals++
        const v = Number(d.Valor_fijo_del_trato_Global || 0)
        if (v > 1000) { acc.conValor++; acc.sumaClp += v }
        else if (v > 0) acc.implausible++
        else acc.sinValor++
        porMarca.set(k, acc)
      }
      if (lote.length < 200) break
    }
    const suma = (f: (x: { deals: number; conValor: number; implausible: number; sinValor: number; sumaClp: number }) => number) =>
      [...porMarca.values()].reduce((a, x) => a + f(x), 0)
    const deVicky = [...porMarca.entries()].filter(([k]) => !/no habló/i.test(k))
    return NextResponse.json({
      ok: true,
      modo: "conteo",
      nota: "valor conocido = Valor_fijo_del_trato_Global > 1.000 CLP; bajo mil es tarifa en UF y el forecast la lee como cero",
      dealsConMarca: total,
      conValor: suma((x) => x.conValor),
      valorImplausible: suma((x) => x.implausible),
      sinValor: suma((x) => x.sinValor),
      sumaRecurrenteClp: suma((x) => x.sumaClp),
      soloGestionadosPorVicky: {
        deals: deVicky.reduce((a, [, x]) => a + x.deals, 0),
        conValor: deVicky.reduce((a, [, x]) => a + x.conValor, 0),
        sinValorNiPlausible: deVicky.reduce((a, [, x]) => a + x.sinValor + x.implausible, 0),
        sumaRecurrenteClp: deVicky.reduce((a, [, x]) => a + x.sumaClp, 0),
      },
      porMarca: Object.fromEntries(porMarca),
      fallosCoql: fallosCoql.slice(0, 3),
    })
  }

  // ── LOS DEALS DE VICKY SIN MONTO ÚTIL (?sinvalor=1) — Lalo 10-sep,
  // "revisemos esos 117 deals sin monto útil". Clasifica por DE DÓNDE se
  // podría sacar el valor: de su cotización, del bloque de precio del chat, o
  // de ninguna parte. Solo lectura.
  if (sp.get("sinvalor") === "1") {
    // Índice deal → cotización (una pasada, en vez de una COQL por deal).
    const cotDeDeal = new Map<string, string>()
    for (let off = 0; off < 9800; off += 200) {
      const lote = await coql<{ id?: string; Deal_Asociado?: { id?: string } | null }>(
        `select id, Deal_Asociado, Created_Time from Cotizaciones_GeoVictoria where Deal_Asociado is not null order by Created_Time desc limit ${off}, 200`,
      )
      for (const q of lote) {
        const d = String(q.Deal_Asociado?.id || "")
        if (d && q.id && !cotDeDeal.has(d)) cotDeDeal.set(d, String(q.id))
      }
      if (lote.length < 200) break
    }
    // Teléfonos con precio mostrado (para saber si hay de dónde sacarlo).
    // SIN exigir RUT: acá la pregunta es solo si existe un precio del que
    // sacar el monto.
    const universoPrecio = await contactosConPrecioYRut({ desde: "2026-01-01", paisPrefijo: "", exigirRut: false })
    const conPrecio = new Set(universoPrecio.map((c) => c.tel))
    const montoDe = new Map<string, number>()
    for (const c of universoPrecio) {
      const m = montoDelBloque(c.ultimoTexto)
      if (m.clp) montoDe.set(c.tel, Math.round(m.clp / 1.19))
    }
    const filas: Array<Record<string, unknown>> = []
    const grupos = { conCotizacion: 0, conPrecioEnChat: 0, sinNinguna: 0, cierrePerdido: 0, otroPais: 0 }
    for (let off = 0; off < 9800; off += 200) {
      const lote = await coql<{
        id?: string; Deal_Name?: string; Stage?: string; Gesti_n_Vicky?: string | null
        Valor_fijo_del_trato_Global?: number | null; "Owner.email"?: string
        "Contact_Name.Phone"?: string | null; "Contact_Name.Mobile"?: string | null; Created_Time?: string
      }>(
        `select id, Deal_Name, Stage, Gesti_n_Vicky, Valor_fijo_del_trato_Global, Owner.email, Contact_Name.Phone, Contact_Name.Mobile, Created_Time ` +
        `from Deals where Gesti_n_Vicky is not null order by Created_Time desc limit ${off}, 200`,
      )
      for (const d of lote) {
        const marca = String(d.Gesti_n_Vicky || "")
        if (/no habló/i.test(marca)) continue // esa etiqueta es justamente "no es de Vicky"
        const v = Number(d.Valor_fijo_del_trato_Global || 0)
        if (v > 1000) continue
        const tel = String(d["Contact_Name.Mobile"] || d["Contact_Name.Phone"] || "").replace(/\D/g, "")
        const cot = cotDeDeal.get(String(d.id || "")) || ""
        const perdido = /perdido/i.test(String(d.Stage || ""))
        const otroPais = Boolean(tel) && !tel.startsWith("56")
        const via = cot ? "cotizacion" : conPrecio.has(tel) ? "precio_en_chat" : "ninguna"
        if (via === "cotizacion") grupos.conCotizacion++
        else if (via === "precio_en_chat") grupos.conPrecioEnChat++
        else grupos.sinNinguna++
        if (perdido) grupos.cierrePerdido++
        if (otroPais) grupos.otroPais++
        filas.push({
          dealId: d.id, deal: String(d.Deal_Name || "").slice(0, 46), etapa: d.Stage, marca,
          valor: d.Valor_fijo_del_trato_Global, dueno: d["Owner.email"], tel, creado: String(d.Created_Time || "").slice(0, 10),
          via, perdido, otroPais, cotizacion: cot || null,
          recurrenteNetoDelChat: montoDe.get(tel) ?? null,
        })
      }
      if (lote.length < 200) break
    }
    const tope = Math.max(10, Math.min(200, Number(sp.get("detalle") || 60)))
    return NextResponse.json({
      ok: true, modo: "sinvalor",
      nota: "deals de Vicky (Gestión Vicky/Derivado/fuera de Rango) con valor nulo o bajo mil pesos; 'via' dice de dónde se podría sacar el monto",
      total: filas.length, grupos,
      vivos: filas.filter((x) => !x.perdido).length,
      detalle: filas.slice(0, tope),
      fallosCoql: fallosCoql.slice(0, 3),
    })
  }

  // ── FICHA POR CONTACTO (?tels=a,b,c): para responder "¿por qué no se creó
  // el deal?" con evidencia — conversación, dotación, si llegó a formal,
  // estado del loop, traspaso y qué hay en Zoho.
  const telsPedidos = String(sp.get("tels") || "").split(",").map((t) => t.replace(/\D/g, "")).filter((t) => t.length >= 9)
  if (telsPedidos.length) {
    const SUPA = (process.env.SUPABASE_URL || "").trim()
    const KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
    const hs = { apikey: KEY, Authorization: `Bearer ${KEY}` }
    const sb = async <T,>(path: string): Promise<T[]> => {
      const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: hs, cache: "no-store" }).catch(() => null)
      return r?.ok ? ((await r.json().catch(() => [])) as T[]) : []
    }
    const fichas: Array<Record<string, unknown>> = []
    for (const tel of telsPedidos) {
      const convs = await sb<{ id: string; pref_escalon_at?: string | null; user_msg_count?: number | null; first_user_at?: string | null; last_user_at?: string | null }>(
        `vic_v3_conversations?contact=eq.${tel}&select=id,pref_escalon_at,user_msg_count,first_user_at,last_user_at`,
      )
      const cid = convs[0]?.id || ""
      const msgs = cid
        ? await sb<{ role: string; content: string; at: string }>(`vic_v3_messages?conversation_id=eq.${cid}&select=role,content,at&order=at.desc&limit=8`)
        : []
      const loop = await sb<{ stage?: string; estado?: string; motivo_cierre?: string | null; touch?: number | null }>(
        `vic_loop?contact=eq.${tel}&select=stage,estado,motivo_cierre,touch&limit=1`,
      )
      const ptv = await sb<{ vendedor_email?: string; estado?: string; motivo?: string; traspasado_at?: string }>(
        `vic_ptv?contact=eq.${tel}&select=vendedor_email,estado,motivo,traspasado_at&order=traspasado_at.desc&limit=1`,
      )
      const punteros = await sb<{ quote_id: string; deal_id?: string | null; created_at?: string }>(
        `vic_v3_quote_pointers?contact=eq.${tel}&select=quote_id,deal_id,created_at&order=created_at.desc&limit=3`,
      )
      const kvs = await sb<{ key: string; value: string }>(
        `vic_kv?key=in.("sobre_umbral_${tel}","mas_de_50_${tel}","zoho_lead_${tel}","deal_fono_${tel}","voz_no_llamar_${tel}","comprobante_ok_${tel}","pago_online_${tel}","casuistica_aplicada_${tel}")&select=key,value`,
      )
      // Zoho: lead y contacto por teléfono.
      const nueve = tel.slice(-9)
      const rl = await fetch(`${api}/crm/v3/Leads/search?phone=${nueve}&converted=both&per_page=2`, { headers: H, cache: "no-store" }).catch(() => null)
      const leads = rl?.status === 200 ? (((await rl.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>> }).data || []) : []
      const rc = await fetch(`${api}/crm/v3/Contacts/search?phone=${nueve}&per_page=2`, { headers: H, cache: "no-store" }).catch(() => null)
      const contactos = rc?.status === 200 ? (((await rc.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>> }).data || []) : []
      fichas.push({
        tel,
        conversacion: convs[0] ? { mensajesDelCliente: convs[0].user_msg_count, primer: convs[0].first_user_at, ultimo: convs[0].last_user_at, precioEstampadoAt: convs[0].pref_escalon_at } : null,
        ultimosMensajes: msgs.reverse().map((m) => `${m.at.slice(5, 16)} ${m.role === "user" ? "CLIENTE" : "VICKY"}: ${String(m.content || "").replace(/\s+/g, " ").slice(0, 160)}`),
        loop: loop[0] || null,
        traspaso: ptv[0] || null,
        cotizaciones: punteros,
        kv: Object.fromEntries(kvs.map((k) => [k.key.replace(`_${tel}`, ""), String(k.value || "").slice(0, 60)])),
        zohoLeads: leads.map((l) => ({ id: l.id, nombre: l.Last_Name, status: l.Lead_Status, dueno: (l.Owner as { email?: string } | undefined)?.email, empleados: l.N_Empleados_que_marcan, rut: l.RUT_Empresa, convertido: Boolean(l.Converted__s) })),
        zohoContactos: contactos.map((c) => ({ id: c.id, nombre: c.Full_Name, cuenta: (c.Account_Name as { name?: string } | undefined)?.name })),
      })
    }
    return NextResponse.json({ ok: true, modo: "fichas", fichas })
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

  // FUENTES LOCALES DEL DEAL (fix del 10-sep): cruzar SOLO por el teléfono del
  // contacto del deal deja fuera los deals cuyo contacto en Zoho no tiene
  // teléfono — dos de los cinco "sin deal" de la primera corrida (Antrillao,
  // que además PAGÓ, y Jaime) eran falsos positivos por eso. El puntero de
  // cotización y el candado `deal_fono_` sí conocen ese vínculo.
  const SUPA = (process.env.SUPABASE_URL || "").trim()
  const KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
  const hs = { apikey: KEY, Authorization: `Bearer ${KEY}` }
  const dealLocalPorTel = new Map<string, string>()
  {
    const tels = universo.map((c) => c.tel)
    for (let i = 0; i < tels.length; i += 100) {
      const inList = tels.slice(i, i + 100).map((t) => `"${t}"`).join(",")
      const keys = tels.slice(i, i + 100).map((t) => `"deal_fono_${t}"`).join(",")
      const [rp, rk] = await Promise.all([
        fetch(`${SUPA}/rest/v1/vic_v3_quote_pointers?contact=in.(${inList})&select=contact,deal_id`, { headers: hs, cache: "no-store" }).catch(() => null),
        fetch(`${SUPA}/rest/v1/vic_kv?key=in.(${keys})&select=key,value`, { headers: hs, cache: "no-store" }).catch(() => null),
      ])
      if (rp?.ok) for (const f of ((await rp.json().catch(() => [])) as Array<{ contact?: string; deal_id?: string | null }>) || []) {
        const t = String(f.contact || "").replace(/\D/g, "")
        if (f.deal_id) dealLocalPorTel.set(t, String(f.deal_id))
      }
      if (rk?.ok) for (const f of ((await rk.json().catch(() => [])) as Array<{ key: string; value: string }>) || []) {
        const t = String(f.key).replace("deal_fono_", "")
        try {
          const v = JSON.parse(String(f.value || "{}")) as { dealId?: string }
          if (v?.dealId && !dealLocalPorTel.has(t)) dealLocalPorTel.set(t, String(v.dealId))
        } catch { /* marca "creando" u otra cosa */ }
      }
    }
  }
  // Índice de deals por id, para poder mirar los que llegan por fuente local.
  const dealPorId = new Map<string, DealZ>()
  for (const d of dealPorNueve.values()) if (d.id) dealPorId.set(String(d.id), d)

  const faltaDeal: Array<Record<string, unknown>> = []
  const incompletos: Array<Record<string, unknown>> = []
  let alDia = 0
  const cuentaFalla = { stage: 0, valor: 0, empleados: 0, moneda: 0, tipo: 0, gestion: 0 }
  for (const c of universo) {
    const nueve = c.tel.slice(-9)
    let d = dealPorNueve.get(nueve)
    if (!d) {
      const idLocal = dealLocalPorTel.get(c.tel) || ""
      if (idLocal) {
        d = dealPorId.get(idLocal)
        if (!d) {
          // El deal existe pero es de otro año o no entró al índice: se lee.
          const rr = await fetch(
            `${api}/crm/v3/Deals/${idLocal}?fields=Deal_Name,Stage,Valor_fijo_del_trato_Global,N_Empleados_que_marcan,Monda_del_trato,Tipo_de_Cobro,Gesti_n_Vicky,Atribuci_n_Vicky`,
            { headers: H, cache: "no-store" },
          ).catch(() => null)
          if (rr?.status === 200) d = (((await rr.json().catch(() => ({}))) as { data?: DealZ[] }).data || [])[0]
        }
      }
    }
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

  // ── ¿EL PRECIO MOSTRADO ESTÁ REFLEJADO EN LOS DEALS? (?reflejo=1) — Lalo
  // 10-sep: "esos 21 millones de MRR en precio mostrado, ¿están reflejados en
  // su totalidad en los deals?". El precio del chat es CON IVA y el campo del
  // deal es NETO, así que se compara neto contra neto (÷1,19). Solo Chile.
  let reflejo: Record<string, unknown> | null = null
  if (sp.get("reflejo") === "1") {
    const todos = await contactosConPrecioYRut({ desde, paisPrefijo: "56", exigirRut: false })
    // La mayoría de los bloques trae el valor en UF y el CLP solo como
    // aproximación; descartarlos dejaba fuera 272 de 483 contactos y la cifra
    // NO calzaba con los $21,2 M del contador de precios (Lalo: "esa cifra
    // debe calzar tanto en las conversaciones como en los deals"). Con ?uf= se
    // convierten igual que allá.
    const ufDia = Math.max(0, Number(sp.get("uf") || 0)) || 0
    let mostradoNeto = 0, reflejadoNeto = 0, sinDealNeto = 0, sinValorNeto = 0
    let desdeUf = 0
    let conDealYValor = 0, conDealSinValor = 0, sinDeal = 0, sinMontoLegible = 0
    let sobre = 0, bajo = 0
    for (const c of todos) {
      const m = montoDelBloque(c.ultimoTexto)
      const conIva = m.clp || (m.uf && ufDia ? m.uf * ufDia : 0)
      if (m.uf && !m.clp && ufDia) desdeUf++
      const neto = conIva ? Math.round(conIva / 1.19) : 0
      if (!neto) { sinMontoLegible++; continue }
      mostradoNeto += neto
      const idLocal = dealLocalPorTel.get(c.tel) || ""
      const d = dealPorNueve.get(c.tel.slice(-9)) || (idLocal ? dealPorId.get(idLocal) : undefined)
      if (!d) { sinDeal++; sinDealNeto += neto; continue }
      const v = Number(d.Valor_fijo_del_trato_Global || 0)
      if (!(v > 1000)) { conDealSinValor++; sinValorNeto += neto; continue }
      conDealYValor++
      reflejadoNeto += v
      if (v > neto * 1.15) sobre++
      else if (v < neto * 0.85) bajo++
    }
    reflejo = {
      nota: "neto contra neto: el bloque del chat va CON IVA y el campo del deal es NETO",
      contactosConPrecioCL: todos.length,
      sinMontoLegible,
      convertidosDesdeUf: desdeUf,
      ufUsada: ufDia || null,
      mostradoNetoClp: mostradoNeto,
      reflejadoEnDealsClp: reflejadoNeto,
      cobertura: mostradoNeto ? `${Math.round((reflejadoNeto * 100) / mostradoNeto)}%` : "—",
      noReflejado: { sinDeal, montoClp: sinDealNeto, conDealSinValor, montoSinValorClp: sinValorNeto },
      desviaciones: { dealMayorQueElPrecio: sobre, dealMenorQueElPrecio: bajo, iguales: conDealYValor - sobre - bajo },
    }
  }

  // ── ACCIÓN ACOTADA (?aplicar=gestion): estampa SOLO Gesti_n_Vicky donde
  // falta. Es un campo nuestro y de cero riesgo; valor, moneda y tipo NO se
  // tocan acá porque varios de esos deals son de otro canal (arriendo de
  // equipo, "Por usuario" en UF) y ahí la convención de Vicky no aplica.
  // "Derivado" si la conversación se traspasó, "Gestión Vicky" si no.
  let estampados = 0
  if (sp.get("aplicar") === "gestion") {
    const tope = Math.max(1, Math.min(60, Number(sp.get("limit") || 30)))
    const candidatos = incompletos.filter((x) => Array.isArray(x.falta) && (x.falta as string[]).includes("sin Gestión Vicky")).slice(0, tope)
    for (const x of candidatos) {
      const tel = String(x.tel || "")
      const rptv = await fetch(`${SUPA}/rest/v1/vic_ptv?contact=eq.${tel}&select=id&limit=1`, { headers: hs, cache: "no-store" }).catch(() => null)
      const traspasado = rptv?.ok ? (((await rptv.json().catch(() => [])) as unknown[]) || []).length > 0 : false
      const veredicto = traspasado ? "Derivado" : "Gestión Vicky"
      const put = await fetch(`${api}/crm/v3/Deals`, {
        method: "PUT", headers: H, cache: "no-store",
        body: JSON.stringify({ data: [{ id: x.dealId, Gesti_n_Vicky: veredicto }], trigger: ["blueprint"], skip_feature_execution: [{ name: "assignment_rules" }] }),
      }).catch(() => null)
      if (put?.ok) { estampados++; x.gestionEstampada = veredicto }
    }
  }

  return NextResponse.json({
    ok: true,
    desde,
    gestionEstampados: estampados,
    reflejo,
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
