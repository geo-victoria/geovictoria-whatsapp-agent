/**
 * Parser PURO de los avisos de transferencia que los bancos mandan al
 * "correo electrónico de contacto" de una transferencia (17-sep, orden Lalo:
 * "deja el correo de vicky, pero automaticemos para que la casilla de vicky lo
 * lea automáticamente").
 *
 * Formatos reales leídos en la casilla vicky@ (jul→sep 2026):
 *  - Banco de Chile (serviciodetransferencias@bancochile.cl): "Te informamos
 *    que X ha instruido la siguiente transferencia" · Cuenta de abono ·
 *    Monto Operación $70.478 · Mensaje · "Fecha y hora: 06/08/2026 18:23" ·
 *    "ID de la operación: INT_EMP…".
 *  - BCI personas (contacto@bci.cl): "Has recibido una transferencia de fondos
 *    de X hacia tu cuenta" · Razón social · RUT · Monto transferido $ 36,459
 *    (coma de miles) · Nº de comprobante · Fecha · Hora · Correo electrónico
 *    de contacto · Mensaje.
 *  - BCI empresas (transferencias@bci.cl): "De acuerdo con lo instruido por
 *    nuestro cliente X" · Monto transferido $56.837 · Titular de la cuenta de
 *    origen · Comentario para el destinatario · Numero de la operacion · Fecha
 *    abono.
 *  - Santander (mensajeria@santander.cl): "nuestro cliente X realizó una
 *    transferencia" · Monto transferido $ 29.163 · Comentario · "con fecha
 *    10/08/2026". OJO: el RUT que aparece es el de DESTINO (Victoria SA).
 *
 * Sin red, sin Zoho: recibe el correo (HTML o texto) y devuelve los datos o
 * null cuando no es un aviso de transferencia ENTRANTE.
 */

export type AvisoBanco = {
  banco: "bancochile" | "bci" | "santander" | "bancoestado" | "scotiabank" | "itau" | "otro"
  remitente: string
  ordenante: string
  rutOrdenante: string
  monto: number
  /** dd/mm/yyyy tal como venía. */
  fechaTexto: string
  hora: string
  /** ISO con offset de Chile, o "" si la fecha no se pudo leer. */
  fechaIso: string
  nroOperacion: string
  mensaje: string
  /** "COT266" si el mensaje o el asunto lo nombran; "" si no. */
  numeroCotizacion: string
  correoContacto: string
  cuentaDestino: string
  /** true cuando la cuenta de abono es la de Victoria S.A. (Banco de Chile 8001204108). */
  destinoNuestro: boolean
  /** Texto plano del correo (recortado) para la nota interna. */
  texto: string
  /** De dónde salió: el cuerpo del correo del banco o un adjunto transcrito por visión. */
  origen: OrigenAviso
}

const CUENTA_VICTORIA = "8001204108"
const RUT_VICTORIA = "761885871"

const DOMINIOS_BANCO: Array<[RegExp, AvisoBanco["banco"]]> = [
  [/bancochile\.cl|bancodechile\.cl|bch\./i, "bancochile"],
  [/\bbci\.cl/i, "bci"],
  [/santander\.cl/i, "santander"],
  [/bancoestado\.cl/i, "bancoestado"],
  [/scotiabank\.cl/i, "scotiabank"],
  [/itau\.cl/i, "itau"],
]

const ENTIDADES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", ntilde: "ñ",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Ntilde: "Ñ",
  ordm: "º", deg: "°", iquest: "¿", iexcl: "¡",
}

function decodeEntidades(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, k) => (k in ENTIDADES ? ENTIDADES[k] : m))
}

/** HTML de correo → texto plano por líneas (celdas y filas separadas). */
export function htmlATexto(html: string): string {
  let s = String(html || "")
  s = s.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
  s = s.replace(/<!--[\s\S]*?-->/g, " ")
  s = s.replace(/<\s*br\s*\/?>/gi, "\n")
  s = s.replace(/<\/\s*(td|th)\s*>/gi, " | ")
  s = s.replace(/<\/\s*(tr|p|div|li|h[1-6]|table)\s*>/gi, "\n")
  s = s.replace(/<[^>]+>/g, " ")
  s = decodeEntidades(s)
  s = s.replace(/​|‌|‍|﻿/g, "")
  s = s.replace(/[ \t\r\f\v]+/g, " ")
  return s
    .split("\n")
    .map((l) => l.replace(/\s*\|\s*/g, " | ").replace(/(\s*\|\s*)+$/g, "").trim())
    .filter((l) => l && l !== "|")
    .join("\n")
}

function soloDigitos(s: string): string {
  return String(s || "").replace(/\D/g, "")
}

function normalizarRut(s: string): string {
  const t = String(s || "").toUpperCase().replace(/[^0-9K]/g, "")
  if (t.length < 8 || t.length > 9) return ""
  return `${t.slice(0, -1)}-${t.slice(-1)}`
}

function bancoDeRemitente(remitente: string, texto: string, origen: OrigenAviso): AvisoBanco["banco"] | null {
  for (const [re, b] of DOMINIOS_BANCO) if (re.test(remitente)) return b
  // Sin remitente reconocible (p. ej. reenvío): se infiere del cuerpo.
  if (/banco de chile|bancochile|Fonobank/i.test(texto) && (origen === "adjunto" || /ha instruido la siguiente transferencia/i.test(texto))) return "bancochile"
  if (/\bBci\b|BancoBci|Banco de Credito e Inversiones/i.test(texto)) return "bci"
  if (/santander/i.test(texto)) return "santander"
  if (origen === "adjunto") {
    // Comprobante transcrito por visión: el banco viene en la línea "Banco:".
    if (/banco\s*estado/i.test(texto)) return "bancoestado"
    if (/scotiabank/i.test(texto)) return "scotiabank"
    if (/ita[uú]/i.test(texto)) return "itau"
    if (/\bBanco\s*:\s*\S/i.test(texto)) return "otro"
  }
  return null
}

/** "cuerpo" = HTML/texto del correo del banco · "adjunto" = comprobante transcrito por visión. */
export type OrigenAviso = "cuerpo" | "adjunto"

function capturar(texto: string, res: RegExp[]): string {
  for (const re of res) {
    const m = texto.match(re)
    if (m && m[1]) return m[1].replace(/\s+\|.*$/, "").trim()
  }
  return ""
}

/** Offset de Chile para un instante dado, probando -03/-04 contra Intl. */
export function isoChile(fechaTexto: string, hora: string): string {
  const m = fechaTexto.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  if (!m) return ""
  const [, dd, mm, yyyy] = m
  const hh = (hora.match(/^(\d{1,2}):(\d{2})/) || [])
  const H = hh[1] ? hh[1].padStart(2, "0") : "12"
  const M = hh[2] || "00"
  const local = `${yyyy}-${mm}-${dd}T${H}:${M}:00`
  for (const off of ["-03:00", "-04:00"]) {
    const iso = `${local}${off}`
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) continue
    try {
      const f = new Intl.DateTimeFormat("en-GB", {
        timeZone: "America/Santiago",
        hour12: false,
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      }).formatToParts(d)
      const g = (t: string) => f.find((p) => p.type === t)?.value || ""
      const h = g("hour") === "24" ? "00" : g("hour")
      if (g("day") === dd && g("month") === mm && g("year") === yyyy && h === H && g("minute") === M) return d.toISOString()
    } catch {
      return d.toISOString()
    }
  }
  return new Date(`${local}-03:00`).toISOString()
}

export function numeroCotizacionEn(texto: string): string {
  const s = String(texto || "")
  let m = s.match(/\bCOT\s*[-–_.:]?\s*0*(\d{2,5})\b/i)
  if (!m) m = s.match(/cotizaci[oó]n\s*(?:n[º°o]?\.?\s*)?[-#:]?\s*0*(\d{2,5})\b/i)
  return m ? `COT${m[1]}` : ""
}

/**
 * Devuelve el aviso parseado o null cuando el correo no es una transferencia
 * ENTRANTE a nuestra cuenta (notificación de Zoho, correo de un cliente,
 * transferencia saliente, etc.).
 */
export function parsearAvisoBanco(input: { from?: string; subject?: string; html?: string; text?: string; origen?: OrigenAviso }): AvisoBanco | null {
  const origen: OrigenAviso = input.origen || "cuerpo"
  // Con origen "adjunto" el remitente es un CLIENTE (o quien reenvió), no el
  // banco: no se usa para inferir nada.
  const remitente = origen === "adjunto" ? "" : String(input.from || "").trim().toLowerCase()
  const asunto = String(input.subject || "").trim()
  const texto = input.html ? htmlATexto(input.html) : String(input.text || "").replace(/\r/g, "")
  if (!texto) return null
  if (origen === "adjunto" && /NO_ES_COMPROBANTE/.test(texto)) return null
  const banco = bancoDeRemitente(remitente, texto, origen)
  const habla = /transferencia|comprobante de pago/i.test(`${asunto}\n${texto}`)
  if (!habla) return null
  // Saliente (nosotros transfiriendo) o rechazo: no es un abono.
  if (/has realizado una transferencia|realizaste una transferencia|transferencia (?:fue )?rechazada|no pudo ser realizada/i.test(texto)) return null

  const montoTxt = capturar(texto, [
    /Monto\s+(?:transferido|Operaci[oó]n|abonado)\s*:?\s*\|?\s*\$?\s*([\d][\d.,]*)/i,
    /Monto\s*:?\s*\|?\s*\$\s*([\d][\d.,]*)/i,
  ])
  const monto = Number(soloDigitos(montoTxt)) || 0
  if (monto <= 0) return null

  const ordenante = capturar(texto, [
    /Titular de la cuenta de origen\s*:?\s*\|?\s*([^\n|]+)/i,
    /Raz[oó]n social\s*:?\s*\|?\s*([^\n|]+)/i,
    /instruido por nuestro cliente\s+([^,\n]+?)\s*,/i,
    /nuestro cliente\s+(.+?)\s+realiz[oó]/i,
    /Te informamos que\s+(.+?)\s+ha instruido/i,
    /transferencia de fondos de\s+(.+?)\s+hacia tu cuenta/i,
    /Ordenante\s*:?\s*\|?\s*([^\n|]+)/i,
  ]).replace(/\s+/g, " ").trim()

  const cuentaDestino = capturar(texto, [
    /Cuenta de abono\s*:?\s*\|?\s*([\d-]{6,})/i,
    /N[º°o]?\.?\s*de cuenta\s*:?\s*\|?\s*([\d-]{6,})/i,
    /Cuenta destino\s*:?\s*\|?\s*([\d-]{6,})/i,
  ])
  const destinoNuestro =
    soloDigitos(cuentaDestino).replace(/^0+/, "") === CUENTA_VICTORIA ||
    soloDigitos(texto).includes(CUENTA_VICTORIA) ||
    /victoria s\.?\s*a\b|geo\s?victoria/i.test(texto)

  // RUT del ordenante: el primero que NO sea el nuestro (Santander imprime el
  // RUT de DESTINO, Victoria SA).
  let rutOrdenante = ""
  for (const m of texto.matchAll(/RUT\s*:?\s*\|?\s*([\d][\d.]{5,10}\s*-?\s*[\dkK])\b/gi)) {
    const r = normalizarRut(m[1])
    if (r && soloDigitos(r) !== RUT_VICTORIA) { rutOrdenante = r; break }
  }

  const fechaHora = texto.match(/Fecha\s+y\s+hora\s*:?\s*\|?\s*(\d{2}\/\d{2}\/\d{4})\s+(\d{1,2}:\d{2})/i)
  const fechaTexto = fechaHora
    ? fechaHora[1]
    : capturar(texto, [
        /Fecha(?:\s+abono)?\s*:?\s*\|?\s*(\d{2}\/\d{2}\/\d{4})/i,
        /con fecha\s+(\d{2}\/\d{2}\/\d{4})/i,
        /(\d{2}\/\d{2}\/\d{4})/,
      ])
  const hora = fechaHora ? fechaHora[2] : capturar(texto, [/\bHora\s*:?\s*\|?\s*(\d{1,2}:\d{2})/i])
  const nroOperacion = capturar(texto, [
    /N[º°o]?\.?\s*de\s+comprobante\s*:?\s*\|?\s*([A-Z0-9_-]{4,})/i,
    /N[uú]mero de (?:la )?operaci[oó]n\s*:?\s*\|?\s*([A-Z0-9_-]{4,})/i,
    /ID de la operaci[oó]n\s*:?\s*\|?\s*([A-Z0-9_-]{4,})/i,
    /N[º°o]?\.?\s*(?:de\s+)?operaci[oó]n\s*:?\s*\|?\s*([A-Z0-9_-]{4,})/i,
  ])
  const mensaje = capturar(texto, [
    /Comentario para el destinatario\s*:?\s*\|?\s*([^\n|]+)/i,
    /\bMensaje\s*:?\s*\|?\s*([^\n|]+)/i,
    /\bComentario\s*:?\s*\|?\s*([^\n|]+)/i,
    /\bGlosa\s*:?\s*\|?\s*([^\n|]+)/i,
  ])
  const correoContacto = capturar(texto, [/Correo electr[oó]nico de contacto\s*:?\s*\|?\s*([^\s|]+@[^\s|]+)/i])
  const numeroCotizacion = numeroCotizacionEn(`${mensaje}\n${asunto}`)

  // Sin banco reconocido y sin nuestra cuenta como destino, no se acepta: un
  // correo cualquiera con la palabra "transferencia" y un monto no es un abono.
  if (!banco && !destinoNuestro) return null
  // Un comprobante adjunto además tiene que ir dirigido a NOSOTROS: una foto de
  // una transferencia a un tercero (proveedor, sueldo) también dice "Banco:".
  if (origen === "adjunto" && !destinoNuestro) return null

  return {
    banco: banco || "otro",
    remitente: origen === "adjunto" ? String(input.from || "").trim().toLowerCase() : remitente,
    ordenante,
    rutOrdenante,
    monto,
    fechaTexto,
    hora,
    fechaIso: fechaTexto ? isoChile(fechaTexto, hora) : "",
    nroOperacion,
    mensaje,
    numeroCotizacion,
    correoContacto,
    cuentaDestino,
    destinoNuestro,
    texto: texto.slice(0, 1500),
    origen,
  }
}

/* ── Adjuntos de correo ─────────────────────────────────────────────────── */

export type AdjuntoCorreo = {
  nombre: string
  tipo: string
  base64: string
  inline: boolean
  bytes: number
}

/**
 * Normaliza la lista de adjuntos tal como la mandan Power Automate (Name /
 * ContentBytes / ContentType / IsInline / Size), Microsoft Graph (name /
 * contentBytes / contentType / isInline / size) o un POST manual (nombre /
 * base64 / tipo). Acepta la lista serializada como string JSON (pasa cuando el
 * diseñador de Power Automate deja el token entre comillas). Sin red, sin
 * decodificar el base64 más allá de estimar su tamaño.
 */
export function normalizarAdjuntos(raw: unknown): AdjuntoCorreo[] {
  let lista: unknown = raw
  if (typeof lista === "string") {
    const t = lista.trim()
    if (!t) return []
    try { lista = JSON.parse(t) } catch { return [] }
  }
  if (!Array.isArray(lista)) return []
  const out: AdjuntoCorreo[] = []
  for (const it of lista) {
    if (!it || typeof it !== "object") continue
    const o = it as Record<string, unknown>
    const pick = (...ks: string[]) => {
      for (const k of ks) if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k]
      return undefined
    }
    const base64 = String(pick("base64", "contentBytes", "ContentBytes", "contenidoBase64") || "").replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "")
    if (!base64) continue
    const nombre = String(pick("nombre", "name", "Name") || "adjunto")
    const tipo = String(pick("tipo", "contentType", "ContentType") || "").toLowerCase()
    const inlineRaw = pick("inline", "isInline", "IsInline")
    const inline = inlineRaw === true || String(inlineRaw).toLowerCase() === "true"
    const sizeRaw = Number(pick("bytes", "size", "Size"))
    const bytes = Number.isFinite(sizeRaw) && sizeRaw > 0 ? sizeRaw : Math.floor((base64.length * 3) / 4)
    out.push({ nombre, tipo, base64, inline, bytes })
  }
  return out
}

const RE_NOMBRE_LEGIBLE = /\.(pdf|jpe?g|png|webp|gif)$/i
const MIN_BYTES_COMPROBANTE = 8 * 1024
const MAX_BYTES_COMPROBANTE = 10 * 1024 * 1024

/**
 * Cuáles adjuntos vale la pena leer con visión: imagen o PDF, no inline (los
 * logos de las firmas y de los correos de los bancos vienen inline y chicos),
 * de tamaño razonable. Máximo `max` (los correos con 10 fotos no son
 * comprobantes).
 */
export function adjuntosLegibles(adjuntos: AdjuntoCorreo[], max = 3): AdjuntoCorreo[] {
  return adjuntos
    .filter((a) => !a.inline)
    .filter((a) => /pdf|image\//.test(a.tipo) || RE_NOMBRE_LEGIBLE.test(a.nombre))
    .filter((a) => a.bytes >= MIN_BYTES_COMPROBANTE && a.bytes <= MAX_BYTES_COMPROBANTE)
    .slice(0, max)
}
