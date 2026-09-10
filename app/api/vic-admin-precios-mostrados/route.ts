/**
 * ADMIN — ¿CUÁNTOS PRECIOS HA MOSTRADO VICKY? (pregunta de Lalo 10-sep).
 *
 * "Mostró precio" usa la MISMA señal que el dash y el criterio del caso C de
 * atribución (`fetchPreformAts` / vic-precio-mostrado): un mensaje de VICKY
 * con un bloque de precio. Las firmas canónicas son "Resumen mensual",
 * "Total mensual con IVA" y "UF + IVA al mes"; se agrega "Total mensual" a
 * secas porque los precios viejos (antes del 02-sep) salían con ese rótulo y
 * si no se cuenta, el histórico queda corto.
 *
 * Cuenta dos cosas distintas, que no hay que confundir:
 *   · MENSAJES con precio (cuántas veces Vicky mostró un precio), y
 *   · CONTACTOS únicos (a cuántas personas), que es el indicador "Vio precio"
 *     del dash.
 *
 * Excluye los contactos internos de métricas (mismo criterio del dash) y los
 * teléfonos sin país. Solo lectura, auth de cron.
 *
 * GET ?key=<cron>[&desde=YYYY-MM-DD][&paginas=<n>]
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { metricsContactSet, isTestContact } from "@/lib/funnel-analysis"
import { montoDelBloque } from "@/lib/precio-bloque"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

const FIRMAS = ["Resumen mensual", "Total mensual con IVA", "UF + IVA al mes", "Total mensual"]

async function autorizado(req: Request): Promise<boolean> {
  const secreto = await getFollowupCronSecret().catch(() => "")
  const cron = (process.env.CRON_SECRET || "").trim()
  const url = new URL(req.url)
  const auth = req.headers.get("authorization") || ""
  const entregado =
    req.headers.get("x-cron-secret") || (auth.startsWith("Bearer ") ? auth.slice(7) : "") || url.searchParams.get("key") || ""
  return Boolean(entregado) && (entregado === secreto || (Boolean(cron) && entregado === cron))
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  if (!SUPABASE_URL || !SUPABASE_KEY) return NextResponse.json({ ok: false, error: "sin supabase" }, { status: 503 })
  const sp = new URL(req.url).searchParams
  const desde = (sp.get("desde") || "2026-01-01").trim()
  const paginas = Math.min(60, Math.max(1, Number(sp.get("paginas") || 40)))
  const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  // OJO: encodeURIComponent y NADA MÁS. Escapar además el % ("%20"→"%2520")
  // deja el patrón sin coincidencias y el conteo en cero (primer intento del
  // 10-sep). El "+" de "UF + IVA al mes" tiene que viajar como %2B.
  const orFirmas = FIRMAS.map((f) => `content.ilike.*${encodeURIComponent(f)}*`).join(",")

  // Mensajes de Vicky con bloque de precio, paginados de 1.000 en 1.000.
  type Fila = { conversation_id?: string; at?: string; content?: string }
  const filas: Fila[] = []
  for (let p = 0; p < paginas; p++) {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_v3_messages?role=eq.assistant&or=(${orFirmas})&at=gte.${desde}` +
        `&select=conversation_id,at,content&order=at.asc&limit=1000&offset=${p * 1000}`,
      { headers: h, cache: "no-store" },
    ).catch(() => null)
    if (!r?.ok) break
    const lote = ((await r.json().catch(() => [])) as Fila[]) || []
    filas.push(...lote)
    if (lote.length < 1000) break
  }

  // conversation_id → contacto (lotes de 200 ids).
  const ids = [...new Set(filas.map((f) => String(f.conversation_id || "")).filter(Boolean))]
  const contactoDe = new Map<string, string>()
  for (let i = 0; i < ids.length; i += 200) {
    const lote = ids.slice(i, i + 200).map((x) => `"${x}"`).join(",")
    const r = await fetch(`${SUPABASE_URL}/rest/v1/vic_v3_conversations?id=in.(${lote})&select=id,contact`, { headers: h, cache: "no-store" }).catch(() => null)
    if (!r?.ok) continue
    for (const c of ((await r.json().catch(() => [])) as Array<{ id: string; contact: string }>) || []) {
      contactoDe.set(String(c.id), String(c.contact || "").replace(/\D/g, ""))
    }
  }

  const internos = metricsContactSet()
  const PAISES: Record<string, string> = { "56": "Chile", "57": "Colombia", "52": "México", "51": "Perú" }
  const pais = (t: string) => PAISES[t.slice(0, 2)] || (t.startsWith("1") ? "otro" : "sin país")

  let mensajes = 0
  const porFirma = new Map<string, number>()
  const primeraVez = new Map<string, string>() // contacto → fecha del primer precio
  const porPais = new Map<string, Set<string>>()
  // Monto por contacto: manda el ÚLTIMO precio que vio (es el vigente).
  const ufDia = Math.max(0, Number(sp.get("uf") || 0)) || 0
  const ultimo = new Map<string, { at: string; clp?: number; uf?: number }>()
  let descartadosInternos = 0
  let descartadosSinPais = 0
  for (const f of filas) {
    const tel = contactoDe.get(String(f.conversation_id || "")) || ""
    if (!tel) continue
    if (isTestContact(tel, internos)) { descartadosInternos++; continue }
    const p = pais(tel)
    if (p === "sin país") { descartadosSinPais++; continue }
    mensajes++
    const c = String(f.content || "")
    const firma = FIRMAS.find((x) => c.toLowerCase().includes(x.toLowerCase())) || "otra"
    porFirma.set(firma, (porFirma.get(firma) || 0) + 1)
    const at = String(f.at || "")
    if (!primeraVez.has(tel) || at < (primeraVez.get(tel) as string)) primeraVez.set(tel, at)
    const set = porPais.get(p) || new Set<string>()
    set.add(tel)
    porPais.set(p, set)
    const prev = ultimo.get(tel)
    if (!prev || at > prev.at) ultimo.set(tel, { at, ...montoDelBloque(c) })
  }

  // Suma del último precio de cada contacto = MRR MOSTRADO (con IVA).
  let mrrClp = 0
  let conClp = 0
  let ufSola = 0
  let conUfSola = 0
  let sinMonto = 0
  const montos: number[] = []
  const mrrPorPais = new Map<string, number>()
  const mrrPorMes = new Map<string, number>()
  for (const [tel, u] of ultimo.entries()) {
    let clp = u.clp || 0
    if (!clp && u.uf && ufDia) clp = Math.round(u.uf * ufDia)
    if (u.clp) conClp++
    else if (u.uf) { conUfSola++; ufSola += u.uf }
    if (!clp) { sinMonto++; continue }
    mrrClp += clp
    montos.push(clp)
    const p = pais(tel)
    mrrPorPais.set(p, (mrrPorPais.get(p) || 0) + clp)
    const mes = String(primeraVez.get(tel) || u.at).slice(0, 7)
    mrrPorMes.set(mes, (mrrPorMes.get(mes) || 0) + clp)
  }
  montos.sort((a, b) => a - b)
  const mediana = montos.length ? montos[Math.floor(montos.length / 2)] : 0

  // ¿CADA PRECIO MOSTRADO TIENE REGISTRO EN ZOHO? (pregunta de Lalo 10-sep).
  // Se mira primero lo que Vicky misma anotó —puntero de cotización, kv
  // `zoho_lead_` y kv `deal_fono_`/`espejo_deal_`— porque es gratis; a los que
  // quedan sin nada se les pregunta a Zoho por teléfono, con tope de muestra,
  // para saber si el registro existe y Vicky no lo anotó (caso típico: lead
  // del formulario web que ella nunca tocó).
  const telsPrecio = [...primeraVez.keys()]
  const conCotizacion = new Set<string>()
  const conLead = new Set<string>()
  const conDeal = new Set<string>()
  for (let i = 0; i < telsPrecio.length; i += 100) {
    const lote = telsPrecio.slice(i, i + 100)
    const inList = lote.map((t) => `"${t}"`).join(",")
    const keysLead = lote.map((t) => `"zoho_lead_${t}"`).join(",")
    const keysDeal = lote.flatMap((t) => [`"deal_fono_${t}"`, `"espejo_deal_${t}"`]).join(",")
    const [rp, rl, rd] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/vic_v3_quote_pointers?contact=in.(${inList})&select=contact,quote_id,deal_id`, { headers: h, cache: "no-store" }).catch(() => null),
      fetch(`${SUPABASE_URL}/rest/v1/vic_kv?key=in.(${keysLead})&select=key,value`, { headers: h, cache: "no-store" }).catch(() => null),
      fetch(`${SUPABASE_URL}/rest/v1/vic_kv?key=in.(${keysDeal})&select=key,value`, { headers: h, cache: "no-store" }).catch(() => null),
    ])
    if (rp?.ok) for (const f of ((await rp.json().catch(() => [])) as Array<{ contact?: string; quote_id?: string; deal_id?: string }>) || []) {
      const t = String(f.contact || "").replace(/\D/g, "")
      if (f.quote_id) conCotizacion.add(t)
      if (f.deal_id) conDeal.add(t)
    }
    if (rl?.ok) for (const f of ((await rl.json().catch(() => [])) as Array<{ key: string; value: string }>) || []) {
      if (String(f.value || "").trim() && !/^creando/.test(String(f.value))) conLead.add(String(f.key).replace(/^zoho_lead_/, ""))
    }
    if (rd?.ok) for (const f of ((await rd.json().catch(() => [])) as Array<{ key: string; value: string }>) || []) {
      if (String(f.value || "").includes("dealId")) conDeal.add(String(f.key).replace(/^(deal_fono_|espejo_deal_)/, ""))
    }
  }
  const sinRegistroConocido = telsPrecio.filter((t) => !conCotizacion.has(t) && !conLead.has(t) && !conDeal.has(t))
  // Muestra contra Zoho de los que no tienen nada anotado.
  const muestraN = Math.min(60, Math.max(0, Number(sp.get("muestra") || 30)))
  let muestraRevisada = 0
  let muestraConRegistro = 0
  const muestraSinNada: string[] = []
  if (muestraN > 0 && sinRegistroConocido.length) {
    const { getZohoAccessToken } = await import("@/lib/zoho-token")
    const token = await getZohoAccessToken().catch(() => "")
    const apiZ = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const HZ = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
    if (token) {
      for (const tel of sinRegistroConocido.slice(0, muestraN)) {
        muestraRevisada++
        const nueve = tel.slice(-9)
        const [rl, rc] = await Promise.all([
          fetch(`${apiZ}/crm/v3/Leads/search?phone=${nueve}&converted=both&per_page=1`, { headers: HZ, cache: "no-store" }).catch(() => null),
          fetch(`${apiZ}/crm/v3/Contacts/search?phone=${nueve}&per_page=1`, { headers: HZ, cache: "no-store" }).catch(() => null),
        ])
        const hayLead = rl?.status === 200
        const hayContacto = rc?.status === 200
        if (hayLead || hayContacto) muestraConRegistro++
        else if (muestraSinNada.length < 20) muestraSinNada.push(tel)
      }
    }
  }

  // ¿PRECIO MOSTRADO **Y** RUT CONOCIDO? (pregunta de Lalo 10-sep) y, de esos,
  // cuáles NO tienen deal: son los deals que FALTAN, porque con RUT y precio
  // la escalera manda crear el registro. El RUT se busca en lo que escribió
  // el CLIENTE (regex + dígito verificador) y no en lo que dijo Vicky.
  const conRut = new Map<string, string>() // contacto → RUT normalizado
  let faltanDealConRut: Array<{ tel: string; rut: string; primerPrecio: string }> = []
  if (sp.get("rut") === "1" && telsPrecio.length) {
    const { normalizarRut, rutValido } = await import("@/lib/rut")
    const RUT_RE = /\b(\d{1,2}[.]?\d{3}[.]?\d{3}\s*[-–]?\s*[\dkK])\b/g
    // conversación → contacto (para atribuir los mensajes).
    const convDe = new Map<string, string>()
    for (const [cid, tel] of contactoDe.entries()) if (primeraVez.has(tel)) convDe.set(cid, tel)
    const cids = [...convDe.keys()]
    for (let i = 0; i < cids.length; i += 100) {
      const lote = cids.slice(i, i + 100).map((x) => `"${x}"`).join(",")
      for (let p = 0; p < 12; p++) {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/vic_v3_messages?conversation_id=in.(${lote})&role=eq.user&select=conversation_id,content&limit=1000&offset=${p * 1000}`,
          { headers: h, cache: "no-store" },
        ).catch(() => null)
        if (!r?.ok) break
        const filasM = ((await r.json().catch(() => [])) as Array<{ conversation_id?: string; content?: string }>) || []
        for (const f of filasM) {
          const tel = convDe.get(String(f.conversation_id || "")) || ""
          if (!tel || conRut.has(tel)) continue
          for (const m of String(f.content || "").matchAll(RUT_RE)) {
            const cand = normalizarRut(m[1])
            if (rutValido(cand)) { conRut.set(tel, cand); break }
          }
        }
        if (filasM.length < 1000) break
      }
    }
    faltanDealConRut = [...conRut.entries()]
      .filter(([tel]) => !conDeal.has(tel) && !conCotizacion.has(tel))
      .map(([tel, rut]) => ({ tel, rut, primerPrecio: String(primeraVez.get(tel) || "").slice(0, 10) }))
  }

  // Contactos NUEVOS con precio por mes (por su primera vez).
  const porMes = new Map<string, number>()
  for (const at of primeraVez.values()) {
    const mes = at.slice(0, 7)
    porMes.set(mes, (porMes.get(mes) || 0) + 1)
  }

  return NextResponse.json({
    ok: true,
    desde,
    paginasLeidas: Math.ceil(filas.length / 1000),
    firmas: FIRMAS,
    mensajesConPrecio: mensajes,
    contactosConPrecio: primeraVez.size,
    porMesContactosNuevos: Object.fromEntries([...porMes.entries()].sort()),
    porPaisContactos: Object.fromEntries([...porPais.entries()].map(([k, v]) => [k, v.size])),
    porFirmaMensajes: Object.fromEntries([...porFirma.entries()].sort((a, b) => b[1] - a[1])),
    monto: {
      nota: "suma del ÚLTIMO precio mostrado a cada contacto (mensual, CON IVA)",
      mrrMostradoClp: mrrClp,
      contactosConMontoClp: conClp,
      contactosSoloUf: conUfSola,
      ufSinConvertir: Number(ufSola.toFixed(2)),
      ufUsadaParaConvertir: ufDia || null,
      contactosSinMontoLegible: sinMonto,
      promedioClp: montos.length ? Math.round(mrrClp / montos.length) : 0,
      medianaClp: mediana,
      porPaisClp: Object.fromEntries([...mrrPorPais.entries()]),
      porMesClp: Object.fromEntries([...mrrPorMes.entries()].sort()),
    },
    registro: {
      nota: "cotización/lead/deal que VICKY anotó; a los que no tienen nada se les pregunta a Zoho por teléfono en una muestra",
      conCotizacion: conCotizacion.size,
      conLeadAnotado: conLead.size,
      conDealAnotado: conDeal.size,
      sinRegistroAnotado: sinRegistroConocido.length,
      muestraRevisada,
      muestraConRegistroEnZoho: muestraConRegistro,
      muestraSinNingunRegistro: muestraSinNada,
    },
    rut: sp.get("rut") === "1"
      ? {
          nota: "RUT válido (con dígito verificador) escrito por el CLIENTE en el chat",
          conPrecioYRut: conRut.size,
          conPrecioSinRut: telsPrecio.length - conRut.size,
          conRutYSinDeal: faltanDealConRut.length,
          faltanDeal: faltanDealConRut.slice(0, 60),
        }
      : "pasa ?rut=1 para calcularlo",
    descartados: { internos: descartadosInternos, sinPais: descartadosSinPais },
    truncado: filas.length >= paginas * 1000,
  })
}
