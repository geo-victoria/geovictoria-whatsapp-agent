/**
 * Registro AUTOMÁTICO de pagos por transferencia a partir del aviso que el
 * BANCO manda a la casilla de Vicky (17-sep, orden Lalo "deja el correo de
 * vicky, pero automaticemos para que la casilla de vicky lo lea
 * automáticamente").
 *
 * Contexto: desde el 19-ago el modal de transferencia mostraba el correo del
 * ejecutivo dueño y el aviso del banco le llegaba a él; con el espejo caído o
 * sin subir el comprobante, la venta quedaba "Aceptada" por semanas
 * (Clinisonrie, Pizza di Napoli, Dejavu). Y en la casilla vicky@ había un
 * aviso de Banco de Chile del 06-ago (Gases del Sur, COT266, $70.478) que
 * NADIE leyó en 42 días. Este módulo cierra ese hoyo: el correo llega a
 * vicky@ (la fila Email del modal vuelve a ser la suya), un lector lo toma,
 * lo parsea (lib/aviso-banco, puro) y registra el pago con la MISMA mecánica
 * que el comprobante por WhatsApp (nota, adjunto, marcas kv, Pagada, deal
 * ganado y post-pago).
 *
 * Reglas:
 *  - Idempotente por correo (kv `correo_pago_<hash>`): un aviso se procesa UNA
 *    vez; `forzar` lo repite.
 *  - La cotización se resuelve por el NÚMERO que el cliente puso en el
 *    mensaje de la transferencia ("COT266", "pago cotizacion 266"); si no lo
 *    puso, por el RUT del ordenante y, al final, por la razón social — solo
 *    cuando el cruce da UNA sola cotización viva (Aceptada/Enviada). Ambiguo
 *    o sin cruce → aviso interno para que una persona lo asocie.
 *  - El monto se compara con el pago inicial esperado (mismo endpoint del
 *    cotizador que usa la tool del chat). Insuficiente → nota + aviso, NO se
 *    marca Pagada.
 *  - "no gatilles correos de pagos" (Lalo 17-sep): por defecto NO sale el
 *    correo de PAGADA del cotizador ni el de cobranza — solo se marca Pagada,
 *    se adjunta el aviso, se deja nota y aviso interno. vic_kv
 *    `correo_pago_correos`="on" los enciende para los avisos FRESCOS (≤3 d).
 *  - Si el deal ya va en 7/8 (el ejecutivo ya implementó/factura) o el aviso
 *    es viejo (>7 d), el registro es SILENCIOSO: candado `traspaso_postpago_`
 *    para que no salga bienvenida ni alta por chat a destiempo.
 */

import { createHash } from "node:crypto"
import { getKvValue, setKvValue } from "@/lib/supabase-persistence-v3"
import { getZohoAccessToken } from "@/lib/zoho-token"
import { avisarEquipoInterno } from "@/lib/alerta-interna"
import { adjuntarComprobanteBase64 } from "@/lib/comprobante-adjunto"
import { enviarCorreoCobranza } from "@/lib/correo-cobranza"
import {
  pagoInicialEsperadoClp,
  avanzarDealAGanado,
  crearNotaEnCotizacion,
  notificarPagadaAlCotizador,
} from "@/lib/tools/registrar-comprobante-transferencia"
import { parsearAvisoBanco, type AvisoBanco } from "@/lib/aviso-banco"

const QUOTE_MODULE = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
const ZOHO_API_DOMAIN = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
/** Tolerancia del cruce de monto contra el pago inicial esperado (CLP). */
const TOLERANCIA_CLP = Number(process.env.VICKY_CORREO_PAGO_TOLERANCIA_CLP || 1500)
/** Avisos más viejos que esto se registran en silencio (sin bienvenida ni alta). */
const DIAS_FRESCO = Number(process.env.VICKY_CORREO_PAGO_DIAS_FRESCO || 7)

export type CorreoEntrante = {
  messageId?: string
  from: string
  subject?: string
  html?: string
  text?: string
  receivedAt?: string
  fuente: "graph" | "push" | "manual"
}

export type Veredicto =
  | "no_es_aviso"
  | "ya_procesado"
  | "sin_cotizacion"
  | "ambiguo"
  | "ya_pagada"
  | "monto_insuficiente"
  | "registrado"
  | "dry"
  | "error"

export type ResultadoCorreoPago = {
  veredicto: Veredicto
  aviso?: Pick<AvisoBanco, "banco" | "ordenante" | "rutOrdenante" | "monto" | "fechaIso" | "nroOperacion" | "mensaje" | "numeroCotizacion">
  quoteId?: string
  numero?: string
  contact?: string
  empresa?: string
  esperadoClp?: number
  silencioso?: boolean
  correos?: boolean
  candidatos?: Array<{ quoteId: string; numero: string; estado: string; nombre: string }>
  detalle?: string
  hash?: string
}

type CotRow = {
  id: string
  Numero_Cotizacion?: string
  Name?: string
  Estado_Cotizacion?: string
  Tel_fono_Contacto?: string
  RUT_Cliente?: string
  Intervenci_n_Humana?: string
  Deal_Asociado?: { id?: string; name?: string } | null
  Cuenta_Asociada?: { id?: string; name?: string } | null
  Created_Time?: string
}

const CAMPOS = "id, Numero_Cotizacion, Name, Estado_Cotizacion, Tel_fono_Contacto, RUT_Cliente, Intervenci_n_Humana, Deal_Asociado, Cuenta_Asociada, Created_Time"

export function hashCorreo(c: CorreoEntrante, aviso?: AvisoBanco | null): string {
  const base = (c.messageId || "").trim() || `${c.from}|${c.subject || ""}|${aviso?.monto || ""}|${aviso?.fechaTexto || ""}|${aviso?.nroOperacion || ""}`
  return createHash("sha1").update(base).digest("hex").slice(0, 20)
}

async function coql(select_query: string): Promise<CotRow[]> {
  const token = await getZohoAccessToken()
  const r = await fetch(`${ZOHO_API_DOMAIN}/crm/v8/coql`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ select_query }),
  })
  if (r.status === 204) return []
  const j = (await r.json().catch(() => ({}))) as { data?: CotRow[]; code?: string; message?: string }
  if (!r.ok) throw new Error(`COQL ${r.status} ${j.code || ""} ${j.message || ""}`.trim())
  return Array.isArray(j.data) ? j.data : []
}

function rutVariantes(rut: string): string[] {
  const t = rut.toUpperCase().replace(/[^0-9K]/g, "")
  if (t.length < 8) return []
  const cuerpo = t.slice(0, -1)
  const dv = t.slice(-1)
  const conPuntos = cuerpo.replace(/\B(?=(\d{3})+(?!\d))/g, ".")
  return Array.from(new Set([`${cuerpo}-${dv}`, `${conPuntos}-${dv}`, `${cuerpo}${dv}`, `${cuerpo}-${dv.toLowerCase()}`, `${conPuntos}-${dv.toLowerCase()}`]))
}

function esc(s: string): string {
  return s.replace(/'/g, "\\'")
}

const VIVAS = "(Estado_Cotizacion = 'Aceptada' or Estado_Cotizacion = 'Enviada')"

/** Resuelve la cotización del aviso: número → RUT → razón social. */
async function resolverCotizacion(aviso: AvisoBanco): Promise<{ row?: CotRow; candidatos: CotRow[]; via: string }> {
  if (aviso.numeroCotizacion) {
    const rows = await coql(`select ${CAMPOS} from ${QUOTE_MODULE} where Numero_Cotizacion = '${esc(aviso.numeroCotizacion)}' limit 5`)
    if (rows.length === 1) return { row: rows[0], candidatos: rows, via: "numero" }
    if (rows.length > 1) return { candidatos: rows, via: "numero" }
  }
  const desde = new Date(Date.now() - 90 * 86400000).toISOString().replace(/\.\d{3}Z$/, "+00:00")
  if (aviso.rutOrdenante) {
    const vs = rutVariantes(aviso.rutOrdenante)
    if (vs.length) {
      const or = vs.map((v) => `RUT_Cliente = '${esc(v)}'`).join(" or ")
      const rows = await coql(`select ${CAMPOS} from ${QUOTE_MODULE} where ((${or}) and ${VIVAS}) and Created_Time > '${desde}' order by Created_Time desc limit 10`)
      const aceptadas = rows.filter((r) => /acept/i.test(String(r.Estado_Cotizacion || "")))
      const pool = aceptadas.length ? aceptadas : rows
      if (pool.length === 1) return { row: pool[0], candidatos: rows, via: "rut" }
      if (pool.length > 1) return { candidatos: pool, via: "rut" }
    }
  }
  if (aviso.ordenante) {
    // Dos primeras palabras significativas de la razón social.
    const palabras = aviso.ordenante
      .replace(/[^\p{L}\p{N} ]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !/^(SPA|LTDA|LIMITADA|SOCIEDAD|EMPRESA|COMERCIAL|INVERSIONES|SERVICIOS|GRUPO)$/i.test(w))
      .slice(0, 2)
    if (palabras.length) {
      const like = palabras.map((w) => `Name like '%${esc(w)}%'`).join(" and ")
      const rows = await coql(`select ${CAMPOS} from ${QUOTE_MODULE} where ((${like}) and ${VIVAS}) and Created_Time > '${desde}' order by Created_Time desc limit 10`)
      const aceptadas = rows.filter((r) => /acept/i.test(String(r.Estado_Cotizacion || "")))
      const pool = aceptadas.length ? aceptadas : rows
      if (pool.length === 1) return { row: pool[0], candidatos: rows, via: "razon_social" }
      if (pool.length > 1) return { candidatos: pool, via: "razon_social" }
    }
  }
  return { candidatos: [], via: "ninguna" }
}

async function etapaDeal(dealId: string): Promise<string> {
  if (!dealId) return ""
  try {
    const token = await getZohoAccessToken()
    const r = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/Deals/${dealId}?fields=Stage`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      cache: "no-store",
    })
    if (r.status !== 200) return ""
    const j = (await r.json().catch(() => ({}))) as { data?: Array<{ Stage?: string }> }
    return String(j.data?.[0]?.Stage || "")
  } catch {
    return ""
  }
}

/** PUT Estado_Cotizacion=Pagada SIN avisar al cotizador (los correos van aparte). */
async function marcarPagadaSinAviso(quoteId: string): Promise<boolean> {
  const token = await getZohoAccessToken()
  const r = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/${QUOTE_MODULE}`, {
    method: "PUT",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ data: [{ id: quoteId, Estado_Cotizacion: "Pagada" }], trigger: ["blueprint"] }),
  })
  if (!r.ok) console.warn(`[correo-pago] Estado→Pagada falló (${r.status}) quote=${quoteId}`)
  return r.ok
}

function fmtClp(n: number): string {
  return `$${Math.round(n).toLocaleString("es-CL")}`
}

function resumenAviso(a: AvisoBanco): string {
  return [
    `Banco: ${a.banco}`,
    `Ordenante: ${a.ordenante || "-"}${a.rutOrdenante ? ` (RUT ${a.rutOrdenante})` : ""}`,
    `Monto: ${fmtClp(a.monto)}`,
    `Fecha: ${a.fechaTexto || "-"}${a.hora ? ` ${a.hora}` : ""}`,
    `Nº operación: ${a.nroOperacion || "-"}`,
    `Mensaje: ${a.mensaje || "-"}`,
    a.cuentaDestino ? `Cuenta destino: ${a.cuentaDestino}` : "",
  ].filter(Boolean).join("\n")
}

/**
 * Procesa UN correo. `dry` no escribe nada; `forzar` ignora la marca de
 * procesado; `correos` fuerza/apaga los correos de PAGADA y cobranza (default:
 * vic_kv `correo_pago_correos`="on" y aviso fresco).
 */
export async function procesarCorreoEntrante(
  c: CorreoEntrante,
  opts: { dry?: boolean; forzar?: boolean; correos?: boolean } = {},
): Promise<ResultadoCorreoPago> {
  const aviso = parsearAvisoBanco({ from: c.from, subject: c.subject, html: c.html, text: c.text })
  if (!aviso) return { veredicto: "no_es_aviso" }
  const hash = hashCorreo(c, aviso)
  const kvKey = `correo_pago_${hash}`
  const resumen = {
    banco: aviso.banco, ordenante: aviso.ordenante, rutOrdenante: aviso.rutOrdenante, monto: aviso.monto,
    fechaIso: aviso.fechaIso, nroOperacion: aviso.nroOperacion, mensaje: aviso.mensaje, numeroCotizacion: aviso.numeroCotizacion,
  }
  if (!opts.forzar) {
    const previo = await getKvValue(kvKey).catch(() => null)
    if (previo) {
      let p: Partial<ResultadoCorreoPago> = {}
      try { p = JSON.parse(previo) as Partial<ResultadoCorreoPago> } catch { /* marca vieja */ }
      return { veredicto: "ya_procesado", aviso: resumen, hash, quoteId: p.quoteId, numero: p.numero, detalle: `procesado antes: ${p.veredicto || "?"}` }
    }
  }

  let res: { row?: CotRow; candidatos: CotRow[]; via: string }
  try {
    res = await resolverCotizacion(aviso)
  } catch (e) {
    return { veredicto: "error", aviso: resumen, hash, detalle: e instanceof Error ? e.message : String(e) }
  }
  const candidatos = res.candidatos.map((r) => ({
    quoteId: String(r.id), numero: String(r.Numero_Cotizacion || ""), estado: String(r.Estado_Cotizacion || ""), nombre: String(r.Name || ""),
  }))
  if (!res.row) {
    const veredicto: Veredicto = candidatos.length > 1 ? "ambiguo" : "sin_cotizacion"
    if (!opts.dry) {
      await setKvValue(kvKey, JSON.stringify({ veredicto, at: new Date().toISOString(), hash, aviso: resumen, candidatos })).catch(() => {})
      await avisarEquipoInterno(
        `💳 AVISO DE TRANSFERENCIA EN LA CASILLA DE VICKY sin cotización ${veredicto === "ambiguo" ? "única" : "asociable"}\n${resumenAviso(aviso)}` +
          (candidatos.length ? `\nCandidatas: ${candidatos.map((k) => `${k.numero} (${k.estado}, ${k.nombre})`).join(" · ")}` : "") +
          `\nHay que asociarlo a mano (vic-admin-adjuntar-comprobante + marcar Pagada) — el aviso quedó en vicky@.`,
      ).catch(() => false)
    }
    return { veredicto, aviso: resumen, hash, candidatos, detalle: `vía ${res.via}` }
  }

  const row = res.row
  const quoteId = String(row.id)
  const numero = String(row.Numero_Cotizacion || aviso.numeroCotizacion || "")
  const contact = String(row.Tel_fono_Contacto || "").replace(/\D/g, "")
  const empresa = String(row.Cuenta_Asociada?.name || row.Name || "")
  const dealId = String(row.Deal_Asociado?.id || "")

  if (/pagad/i.test(String(row.Estado_Cotizacion || ""))) {
    if (!opts.dry) await setKvValue(kvKey, JSON.stringify({ veredicto: "ya_pagada", at: new Date().toISOString(), quoteId, numero, aviso: resumen })).catch(() => {})
    return { veredicto: "ya_pagada", aviso: resumen, hash, quoteId, numero, contact, empresa }
  }

  const esperadoClp = await pagoInicialEsperadoClp(quoteId).catch(() => 0)
  const insuficiente = esperadoClp > 0 && aviso.monto + TOLERANCIA_CLP < esperadoClp

  const fechaMs = Date.parse(aviso.fechaIso || c.receivedAt || "")
  const edadDias = Number.isFinite(fechaMs) ? (Date.now() - fechaMs) / 86400000 : 0
  const stage = await etapaDeal(dealId)
  const yaImplementado = /^\s*(7|8)\./.test(stage)
  const silencioso = yaImplementado || edadDias > DIAS_FRESCO
  const correos =
    typeof opts.correos === "boolean"
      ? opts.correos
      : !silencioso && String((await getKvValue("correo_pago_correos").catch(() => null)) || "").trim().toLowerCase() === "on"

  const base: ResultadoCorreoPago = { veredicto: "dry", aviso: resumen, hash, quoteId, numero, contact, empresa, esperadoClp, silencioso, correos, detalle: `vía ${res.via}${stage ? ` · deal ${stage}` : ""}` }

  if (insuficiente) {
    if (opts.dry) return { ...base, veredicto: "dry", detalle: `${base.detalle} · MONTO INSUFICIENTE (${fmtClp(aviso.monto)} < ${fmtClp(esperadoClp)})` }
    const nota = `⚠️ AVISO DEL BANCO (casilla vicky@) con MONTO INSUFICIENTE — no se marcó Pagada.\n${resumenAviso(aviso)}\nPago inicial esperado: ${fmtClp(esperadoClp)} · faltan ${fmtClp(esperadoClp - aviso.monto)}.`
    await crearNotaEnCotizacion(quoteId, nota).catch(() => false)
    await avisarEquipoInterno(`💳 ${numero} ${empresa}: ${nota}`).catch(() => false)
    await setKvValue(kvKey, JSON.stringify({ veredicto: "monto_insuficiente", at: new Date().toISOString(), quoteId, numero, aviso: resumen, esperadoClp })).catch(() => {})
    return { ...base, veredicto: "monto_insuficiente" }
  }

  if (opts.dry) return base

  try {
    const nota =
      `💳 PAGO REGISTRADO DESDE EL AVISO DEL BANCO (casilla vicky@, ${c.fuente})\n${resumenAviso(aviso)}` +
      (esperadoClp ? `\nPago inicial esperado: ${fmtClp(esperadoClp)} ✓` : "") +
      `\nCorreo: ${c.subject || "(sin asunto)"} · ${c.from} · ${c.receivedAt || ""}` +
      (silencioso ? `\nRegistro SILENCIOSO (${yaImplementado ? `deal ya en ${stage}` : `aviso de hace ${Math.round(edadDias)} días`}): sin bienvenida ni alta por chat.` : "") +
      (correos ? "" : "\nSin correo de PAGADA ni de cobranza (interruptor correo_pago_correos apagado).")
    await crearNotaEnCotizacion(quoteId, nota).catch(() => false)
    if (c.html) {
      const nombre = `aviso-banco-${aviso.banco}-${(aviso.nroOperacion || hash).replace(/[^A-Za-z0-9_-]/g, "")}.html`
      await adjuntarComprobanteBase64(quoteId, Buffer.from(c.html, "utf8").toString("base64"), nombre, "text/html").catch(() => ({ ok: false }))
    }
    // Marcas ANTES de Pagada (misma razón que la tool del chat, 05-sep): el
    // post-pago debe saber que fue transferencia y con qué fecha real.
    const atReal = Number.isFinite(fechaMs) ? new Date(fechaMs).toISOString() : new Date().toISOString()
    if (contact) {
      await setKvValue(`comprobante_ok_${contact}`, JSON.stringify({ at: atReal, numero, quoteId, fuente: "correo_banco", nro: aviso.nroOperacion })).catch(() => {})
    }
    if (silencioso) {
      await setKvValue(`traspaso_postpago_${quoteId}`, new Date().toISOString()).catch(() => {})
    }
    const ok = await marcarPagadaSinAviso(quoteId)
    if (!ok) throw new Error("Zoho no aceptó Estado_Cotizacion=Pagada")
    if (correos) await notificarPagadaAlCotizador(quoteId).catch(() => {})
    else if (!silencioso) {
      // Sin correo de PAGADA el cotizador no dispara el post-pago: se corre acá
      // mismo (bienvenida + alta por chat si la venta es de Vicky).
      try {
        const { cerrarYTraspasarPostPago } = await import("./traspaso-postpago")
        await cerrarYTraspasarPostPago(quoteId, { motivoCierre: "pagado" })
      } catch (e) {
        console.warn("[correo-pago] post-pago directo falló:", e instanceof Error ? e.message : e)
      }
    }
    await avanzarDealAGanado({
      quoteId, dealId, empresa, rut: String(row.RUT_Cliente || ""), acceptanceUrl: "", pdfUrl: "", totalClp: null, totalUf: null, updatedAt: new Date().toISOString(),
    }).catch(() => {})
    if (correos) {
      await enviarCorreoCobranza({
        quoteId, numeroCotizacion: numero, empresa, rut: String(row.RUT_Cliente || ""), telefono: contact,
        monto: fmtClp(aviso.monto), banco: aviso.banco, fecha: `${aviso.fechaTexto} ${aviso.hora}`.trim(),
        detalle: `Aviso del banco recibido en vicky@ (${aviso.nroOperacion || "sin nº"}). Registrado automáticamente.`,
      }).catch(() => ({ ok: false }))
    }
    await setKvValue(kvKey, JSON.stringify({ veredicto: "registrado", at: new Date().toISOString(), quoteId, numero, contact, aviso: resumen, silencioso, correos })).catch(() => {})
    await avisarEquipoInterno(
      `💳 PAGO REGISTRADO desde la casilla de Vicky: ${numero} ${empresa} · ${fmtClp(aviso.monto)} · ${aviso.banco} ${aviso.fechaTexto} ${aviso.hora}` +
        (silencioso ? " · silencioso" : "") + (correos ? "" : " · sin correo de pago"),
    ).catch(() => false)
    console.log(`[correo-pago] registrado quote=${quoteId} ${numero} monto=${aviso.monto} silencioso=${silencioso} correos=${correos}`)
    return { ...base, veredicto: "registrado" }
  } catch (e) {
    console.error("[correo-pago] error registrando:", e)
    return { ...base, veredicto: "error", detalle: e instanceof Error ? e.message : String(e) }
  }
}
