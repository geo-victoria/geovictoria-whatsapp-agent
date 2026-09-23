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
 *  - ADJUNTOS (17-sep, Lalo "permite que lea imágenes y adjuntos"): si el
 *    cuerpo no es un aviso, cada imagen/PDF no-inline (máx 3) se transcribe
 *    con visión (prompt estructurado "Etiqueta: valor", orden de no inventar)
 *    y pasa por el MISMO parser en modo "adjunto", que exige que el destino
 *    seamos nosotros. El archivo original queda adjunto en la cotización y la
 *    nota dice que los datos vienen de visión. Misma verificación blanda que
 *    el comprobante por WhatsApp (05-sep): monto legible ≥ pago inicial.
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
import { parsearAvisoBanco, adjuntosLegibles, type AvisoBanco, type AdjuntoCorreo } from "@/lib/aviso-banco"
import { fichaOperativa, formatearMontoOperativo, paisDeTelefonoOperativo, type CodigoPaisOperativo } from "@/lib/paises/ficha-operativa"

const QUOTE_MODULE = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
const ZOHO_API_DOMAIN = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
/**
 * Tolerancia del cruce de monto contra el pago inicial esperado, en la moneda
 * del país de la cotización (ficha operativa: CL 1.500 · PE 2 · CO 1.000 ·
 * MX 20). Override por país: env VICKY_CORREO_PAGO_TOLERANCIA_<CC>; el env
 * chileno histórico VICKY_CORREO_PAGO_TOLERANCIA_CLP sigue valiendo para CL.
 */
function toleranciaMonto(pais: CodigoPaisOperativo): number {
  const env = process.env[`VICKY_CORREO_PAGO_TOLERANCIA_${pais.toUpperCase()}`] || (pais === "cl" ? process.env.VICKY_CORREO_PAGO_TOLERANCIA_CLP : "")
  const n = Number(env)
  return Number.isFinite(n) && n > 0 ? n : fichaOperativa(pais).toleranciaMonto
}
/** Avisos más viejos que esto se registran en silencio (sin bienvenida ni alta). */
const DIAS_FRESCO = Number(process.env.VICKY_CORREO_PAGO_DIAS_FRESCO || 7)

export type CorreoEntrante = {
  messageId?: string
  from: string
  subject?: string
  html?: string
  text?: string
  receivedAt?: string
  /** Adjuntos ya normalizados (lib/aviso-banco `normalizarAdjuntos`). */
  adjuntos?: AdjuntoCorreo[]
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
  aviso?: Pick<AvisoBanco, "banco" | "pais" | "moneda" | "ordenante" | "rutOrdenante" | "monto" | "fechaIso" | "nroOperacion" | "mensaje" | "numeroCotizacion">
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
  /** "cuerpo" o "adjunto:<nombre>" — de dónde salió el aviso. */
  origen?: string
  /** Adjuntos que se intentaron leer y qué devolvió la visión (recortado). */
  adjuntosLeidos?: Array<{ nombre: string; bytes: number; resultado: "comprobante" | "no_es_comprobante" | "ilegible" }>
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

/**
 * Formas con que un documento de empresa puede estar guardado en RUT_Cliente:
 * RUT chileno (con/sin puntos, DV en mayúscula o minúscula), RUC peruano (11
 * dígitos tal cual), NIT colombiano (con/sin DV, con/sin puntos).
 */
function rutVariantes(doc: string): string[] {
  const t = doc.toUpperCase().replace(/[^0-9K]/g, "")
  if (/^\d{11}$/.test(t)) return [t]
  if (t.length < 8) return []
  const cuerpo = t.slice(0, -1)
  const dv = t.slice(-1)
  const conPuntos = cuerpo.replace(/\B(?=(\d{3})+(?!\d))/g, ".")
  const out = [`${cuerpo}-${dv}`, `${conPuntos}-${dv}`, `${cuerpo}${dv}`, `${cuerpo}-${dv.toLowerCase()}`, `${conPuntos}-${dv.toLowerCase()}`]
  // NIT sin DV (9-10 dígitos puros): también como está.
  if (/^\d{9,10}$/.test(t)) out.push(t, t.replace(/\B(?=(\d{3})+(?!\d))/g, "."))
  return Array.from(new Set(out))
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

function resumenAviso(a: AvisoBanco): string {
  const pais = a.pais || "cl"
  const etiquetaDoc = fichaOperativa(pais).documento.etiqueta
  return [
    `Banco: ${a.banco}${a.pais ? ` (${fichaOperativa(a.pais).nombre})` : ""}`,
    `Ordenante: ${a.ordenante || "-"}${a.rutOrdenante ? ` (${etiquetaDoc} ${a.rutOrdenante})` : ""}`,
    `Monto: ${formatearMontoOperativo(a.monto, pais)}`,
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
  let aviso = parsearAvisoBanco({ from: c.from, subject: c.subject, html: c.html, text: c.text })
  let origen = "cuerpo"
  let adjuntoFuente: AdjuntoCorreo | null = null
  const adjuntosLeidos: NonNullable<ResultadoCorreoPago["adjuntosLeidos"]> = []
  if (!aviso) {
    // El cuerpo no es un aviso de banco: ¿viene el comprobante como imagen o
    // PDF? (cliente que reenvía su comprobante a vicky@, banco que lo adjunta).
    // Cada adjunto legible pasa por visión con el prompt estructurado y el
    // MISMO parser, en modo "adjunto" (exige destino nuestro).
    const legibles = adjuntosLegibles(c.adjuntos || [])
    if (legibles.length) {
      const { describirAdjunto, promptComprobante } = await import("./describe-image")
      for (const a of legibles) {
        const texto = await describirAdjunto({ base64: a.base64, tipo: a.tipo, nombre: a.nombre }, { prompt: promptComprobante(), maxTokens: 500 })
        if (!texto) { adjuntosLeidos.push({ nombre: a.nombre, bytes: a.bytes, resultado: "ilegible" }); continue }
        const parsed = parsearAvisoBanco({ from: c.from, subject: c.subject, text: texto, origen: "adjunto" })
        if (!parsed) { adjuntosLeidos.push({ nombre: a.nombre, bytes: a.bytes, resultado: "no_es_comprobante" }); continue }
        adjuntosLeidos.push({ nombre: a.nombre, bytes: a.bytes, resultado: "comprobante" })
        aviso = parsed
        origen = `adjunto:${a.nombre}`
        adjuntoFuente = a
        console.log(`[correo-pago] comprobante leído desde adjunto ${a.nombre} (${a.bytes} bytes): monto=${parsed.monto} cot=${parsed.numeroCotizacion || "-"} rut=${parsed.rutOrdenante || "-"}`)
        break
      }
    }
  }
  if (!aviso) return { veredicto: "no_es_aviso", ...(adjuntosLeidos.length ? { adjuntosLeidos } : {}) }
  const hash = hashCorreo(c, aviso)
  const kvKey = `correo_pago_${hash}`
  const resumen = {
    banco: aviso.banco, pais: aviso.pais, moneda: aviso.moneda, ordenante: aviso.ordenante, rutOrdenante: aviso.rutOrdenante, monto: aviso.monto,
    fechaIso: aviso.fechaIso, nroOperacion: aviso.nroOperacion, mensaje: aviso.mensaje, numeroCotizacion: aviso.numeroCotizacion,
  }
  if (!opts.forzar) {
    const previo = await getKvValue(kvKey).catch(() => null)
    if (previo) {
      let p: Partial<ResultadoCorreoPago> = {}
      try { p = JSON.parse(previo) as Partial<ResultadoCorreoPago> } catch { /* marca vieja */ }
      return { veredicto: "ya_procesado", aviso: resumen, hash, origen, quoteId: p.quoteId, numero: p.numero, detalle: `procesado antes: ${p.veredicto || "?"}` }
    }
  }

  let res: { row?: CotRow; candidatos: CotRow[]; via: string }
  try {
    res = await resolverCotizacion(aviso)
  } catch (e) {
    return { veredicto: "error", aviso: resumen, hash, origen, detalle: e instanceof Error ? e.message : String(e) }
  }
  const candidatos = res.candidatos.map((r) => ({
    quoteId: String(r.id), numero: String(r.Numero_Cotizacion || ""), estado: String(r.Estado_Cotizacion || ""), nombre: String(r.Name || ""),
  }))
  if (!res.row) {
    const veredicto: Veredicto = candidatos.length > 1 ? "ambiguo" : "sin_cotizacion"
    if (!opts.dry) {
      await setKvValue(kvKey, JSON.stringify({ veredicto, at: new Date().toISOString(), hash, aviso: resumen, candidatos })).catch(() => {})
      await avisarEquipoInterno(
        `💳 ${origen === "cuerpo" ? "AVISO DE TRANSFERENCIA" : `COMPROBANTE ADJUNTO (${origen.slice(8)})`} EN LA CASILLA DE VICKY sin cotización ${veredicto === "ambiguo" ? "única" : "asociable"}\n${resumenAviso(aviso)}` +
          (candidatos.length ? `\nCandidatas: ${candidatos.map((k) => `${k.numero} (${k.estado}, ${k.nombre})`).join(" · ")}` : "") +
          `\nHay que asociarlo a mano (vic-admin-adjuntar-comprobante + marcar Pagada) — el aviso quedó en vicky@.`,
      ).catch(() => false)
    }
    return { veredicto, aviso: resumen, hash, origen, adjuntosLeidos, candidatos, detalle: `vía ${res.via}` }
  }

  const row = res.row
  const quoteId = String(row.id)
  const numero = String(row.Numero_Cotizacion || aviso.numeroCotizacion || "")
  const contact = String(row.Tel_fono_Contacto || "").replace(/\D/g, "")
  const empresa = String(row.Cuenta_Asociada?.name || row.Name || "")
  const dealId = String(row.Deal_Asociado?.id || "")
  // País de la COTIZACIÓN (por el teléfono del cliente; si no, el del aviso):
  // manda en la moneda con que se escribe el monto y en la tolerancia.
  const pais: CodigoPaisOperativo = paisDeTelefonoOperativo(contact) || aviso.pais || "cl"
  const fmt = (n: number) => formatearMontoOperativo(n, pais)
  // Un aviso de un país resuelto por documento/razón social a una cotización
  // de OTRO país es un cruce falso (celulares de 9 dígitos colisionan entre CL
  // y PE): solo el NÚMERO de cotización es explícito.
  if (aviso.pais && aviso.pais !== pais && res.via !== "numero") {
    const veredicto: Veredicto = "sin_cotizacion"
    if (!opts.dry) {
      await setKvValue(kvKey, JSON.stringify({ veredicto, at: new Date().toISOString(), hash, aviso: resumen, candidatos, detalle: `pais del aviso ${aviso.pais} ≠ pais de la cotización ${pais}` })).catch(() => {})
      await avisarEquipoInterno(`💳 AVISO DE TRANSFERENCIA (${fichaOperativa(aviso.pais).nombre}) EN LA CASILLA DE VICKY cruzó por ${res.via} con ${numero} ${empresa}, que es de ${fichaOperativa(pais).nombre} — no se registró. Revisar a mano.\n${resumenAviso(aviso)}`).catch(() => false)
    }
    return { veredicto, aviso: resumen, hash, origen, adjuntosLeidos, candidatos, quoteId, numero, detalle: `pais del aviso ${aviso.pais} ≠ pais de la cotización ${pais} (vía ${res.via})` }
  }

  if (/pagad/i.test(String(row.Estado_Cotizacion || ""))) {
    if (!opts.dry) await setKvValue(kvKey, JSON.stringify({ veredicto: "ya_pagada", at: new Date().toISOString(), quoteId, numero, aviso: resumen })).catch(() => {})
    return { veredicto: "ya_pagada", aviso: resumen, hash, origen, quoteId, numero, contact, empresa }
  }

  // `pagoInicialEsperadoClp` devuelve el pago inicial en la MONEDA de la
  // cotización (el cotizador decide por el token del país; el nombre es
  // histórico de Chile).
  const esperadoClp = await pagoInicialEsperadoClp(quoteId).catch(() => 0)
  const insuficiente = esperadoClp > 0 && aviso.monto + toleranciaMonto(pais) < esperadoClp

  const fechaMs = Date.parse(aviso.fechaIso || c.receivedAt || "")
  const edadDias = Number.isFinite(fechaMs) ? (Date.now() - fechaMs) / 86400000 : 0
  const stage = await etapaDeal(dealId)
  const yaImplementado = /^\s*(7|8)\./.test(stage)
  const silencioso = yaImplementado || edadDias > DIAS_FRESCO
  const correos =
    typeof opts.correos === "boolean"
      ? opts.correos
      : !silencioso && String((await getKvValue("correo_pago_correos").catch(() => null)) || "").trim().toLowerCase() === "on"

  const base: ResultadoCorreoPago = { veredicto: "dry", aviso: resumen, hash, origen, adjuntosLeidos, quoteId, numero, contact, empresa, esperadoClp, silencioso, correos, detalle: `vía ${res.via}${stage ? ` · deal ${stage}` : ""}${origen !== "cuerpo" ? ` · ${origen}` : ""}` }

  if (insuficiente) {
    if (opts.dry) return { ...base, veredicto: "dry", detalle: `${base.detalle} · MONTO INSUFICIENTE (${fmt(aviso.monto)} < ${fmt(esperadoClp)})` }
    const nota = `⚠️ ${origen === "cuerpo" ? "AVISO DEL BANCO" : `COMPROBANTE ADJUNTO (${origen.slice(8)}, leído por visión)`} (casilla vicky@) con MONTO INSUFICIENTE — no se marcó Pagada.\n${resumenAviso(aviso)}\nPago inicial esperado: ${fmt(esperadoClp)} · faltan ${fmt(esperadoClp - aviso.monto)}.`
    await crearNotaEnCotizacion(quoteId, nota).catch(() => false)
    await avisarEquipoInterno(`💳 ${numero} ${empresa}: ${nota}`).catch(() => false)
    await setKvValue(kvKey, JSON.stringify({ veredicto: "monto_insuficiente", at: new Date().toISOString(), quoteId, numero, aviso: resumen, esperadoClp })).catch(() => {})
    return { ...base, veredicto: "monto_insuficiente" }
  }

  if (opts.dry) return base

  try {
    const nota =
      (origen === "cuerpo"
        ? `💳 PAGO REGISTRADO DESDE EL AVISO DEL BANCO (casilla vicky@, ${c.fuente})\n`
        : `💳 PAGO REGISTRADO DESDE UN COMPROBANTE ADJUNTO (${origen.slice(8)}, casilla vicky@, ${c.fuente}) — datos LEÍDOS POR VISIÓN, verificar contra el archivo adjunto\n`) +
      `${resumenAviso(aviso)}` +
      (esperadoClp ? `\nPago inicial esperado: ${fmt(esperadoClp)} ✓` : "") +
      `\nCorreo: ${c.subject || "(sin asunto)"} · ${c.from} · ${c.receivedAt || ""}` +
      (silencioso ? `\nRegistro SILENCIOSO (${yaImplementado ? `deal ya en ${stage}` : `aviso de hace ${Math.round(edadDias)} días`}): sin bienvenida ni alta por chat.` : "") +
      (correos ? "" : "\nSin correo de PAGADA ni de cobranza (interruptor correo_pago_correos apagado).")
    await crearNotaEnCotizacion(quoteId, nota).catch(() => false)
    if (adjuntoFuente) {
      // El archivo ORIGINAL (foto/PDF) va a la cotización; es la evidencia,
      // la transcripción es solo la lectura.
      const ext = (adjuntoFuente.nombre.match(/\.[a-z0-9]{2,4}$/i) || [""])[0].toLowerCase() || (/pdf/.test(adjuntoFuente.tipo) ? ".pdf" : ".jpg")
      const nombre = `comprobante-correo-${(aviso.nroOperacion || hash).replace(/[^A-Za-z0-9_-]/g, "")}${ext}`
      const ct = adjuntoFuente.tipo || (ext === ".pdf" ? "application/pdf" : "image/jpeg")
      await adjuntarComprobanteBase64(quoteId, adjuntoFuente.base64, nombre, ct).catch(() => ({ ok: false }))
    } else if (c.html) {
      const nombre = `aviso-banco-${aviso.banco}-${(aviso.nroOperacion || hash).replace(/[^A-Za-z0-9_-]/g, "")}.html`
      await adjuntarComprobanteBase64(quoteId, Buffer.from(c.html, "utf8").toString("base64"), nombre, "text/html").catch(() => ({ ok: false }))
    }
    // Marcas ANTES de Pagada (misma razón que la tool del chat, 05-sep): el
    // post-pago debe saber que fue transferencia y con qué fecha real.
    const atReal = Number.isFinite(fechaMs) ? new Date(fechaMs).toISOString() : new Date().toISOString()
    if (contact) {
      await setKvValue(`comprobante_ok_${contact}`, JSON.stringify({ at: atReal, numero, quoteId, fuente: origen === "cuerpo" ? "correo_banco" : "correo_adjunto", nro: aviso.nroOperacion })).catch(() => {})
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
        monto: fmt(aviso.monto), banco: aviso.banco, fecha: `${aviso.fechaTexto} ${aviso.hora}`.trim(),
        detalle: `Aviso del banco recibido en vicky@ (${aviso.nroOperacion || "sin nº"}). Registrado automáticamente.`,
      }).catch(() => ({ ok: false }))
    }
    await setKvValue(kvKey, JSON.stringify({ veredicto: "registrado", at: new Date().toISOString(), quoteId, numero, contact, aviso: resumen, silencioso, correos, origen })).catch(() => {})
    await avisarEquipoInterno(
      `💳 PAGO REGISTRADO desde la casilla de Vicky${origen === "cuerpo" ? "" : ` (comprobante adjunto ${origen.slice(8)}, leído por visión)`}: ${numero} ${empresa} · ${fmt(aviso.monto)} · ${aviso.banco} ${aviso.fechaTexto} ${aviso.hora}` +
        (silencioso ? " · silencioso" : "") + (correos ? "" : " · sin correo de pago"),
    ).catch(() => false)
    console.log(`[correo-pago] registrado quote=${quoteId} ${numero} monto=${aviso.monto} silencioso=${silencioso} correos=${correos}`)
    return { ...base, veredicto: "registrado" }
  } catch (e) {
    console.error("[correo-pago] error registrando:", e)
    return { ...base, veredicto: "error", detalle: e instanceof Error ? e.message : String(e) }
  }
}
