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

import {
  bancosConocidos,
  destinoNuestroEn,
  fichaOperativa,
  identificadoresNuestros,
  paisPorSimboloMoneda,
  parsearMontoOperativo,
  type CodigoPaisOperativo,
} from "./paises/ficha-operativa.ts"

export type AvisoBanco = {
  /** id del banco según la ficha operativa ("bancochile", "bci", "bbva", "bancolombia"…) u "otro". */
  banco: string
  /** País del aviso: por el banco, por nuestra cuenta de destino o por el símbolo de la moneda. "" si no se pudo saber. */
  pais: CodigoPaisOperativo | ""
  /** Código de la moneda del monto (CLP, PEN, COP, MXN) según el país; "" sin país. */
  moneda: string
  remitente: string
  ordenante: string
  /** Documento tributario del ordenante normalizado (RUT "76543210-K", RUC "20123456789", NIT "900123456-7"). Nombre histórico: nació con Chile. */
  rutOrdenante: string
  monto: number
  /** dd/mm/yyyy tal como venía. */
  fechaTexto: string
  hora: string
  /** ISO con el offset del país del aviso (Chile si no se sabe), o "" si la fecha no se pudo leer. */
  fechaIso: string
  nroOperacion: string
  mensaje: string
  /** "COT266" si el mensaje o el asunto lo nombran; "" si no. */
  numeroCotizacion: string
  correoContacto: string
  cuentaDestino: string
  /** true cuando la cuenta de abono es una de las NUESTRAS (cualquier país, lib/paises/ficha-operativa). */
  destinoNuestro: boolean
  /** Texto plano del correo (recortado) para la nota interna. */
  texto: string
  /** De dónde salió: el cuerpo del correo del banco o un adjunto transcrito por visión. */
  origen: OrigenAviso
}

/** Nuestros identificadores tributarios (dígitos) en todos los países: un aviso los imprime como DESTINO. */
const IDS_NUESTROS = identificadoresNuestros()

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

/**
 * Normaliza el documento tributario de una empresa según su forma: RUT
 * chileno (7-8 dígitos + DV → "76543210-K"), RUC peruano (11 dígitos), NIT
 * colombiano (9-10 dígitos, DV opcional → "900123456-7"). "" si no calza.
 */
export function normalizarDocumento(s: string, etiqueta = ""): string {
  const t = String(s || "").toUpperCase().replace(/[^0-9K]/g, "")
  const e = etiqueta.toUpperCase()
  if (e === "RUC" || (!e && /^\d{11}$/.test(t))) return /^\d{11}$/.test(t) ? t : ""
  if (e === "NIT" || (!e && /^\d{9,10}$/.test(t) && !t.includes("K"))) {
    if (/^\d{9,10}$/.test(t)) return t.length === 10 ? `${t.slice(0, 9)}-${t.slice(9)}` : t
    if (/^\d{9,10}[0-9]$/.test(t)) return `${t.slice(0, -1)}-${t.slice(-1)}`
    return ""
  }
  if (t.length < 8 || t.length > 9) return ""
  return `${t.slice(0, -1)}-${t.slice(-1)}`
}

type BancoDetectado = { id: string; pais: CodigoPaisOperativo } | { id: "otro"; pais: "" } | null

/**
 * Banco del aviso: primero por el DOMINIO del remitente (cualquier país de la
 * ficha operativa), después por cómo se nombra en el cuerpo. Los bancos
 * chilenos conservan las guardas que nacieron de los formatos reales; para el
 * resto basta el nombre. Devuelve el país del banco, que es la primera pista
 * del país del aviso.
 */
function bancoDeRemitente(
  remitente: string,
  texto: string,
  origen: OrigenAviso,
  paisPista: CodigoPaisOperativo | null,
  paisDestino: CodigoPaisOperativo | null,
): BancoDetectado {
  const todos = bancosConocidos()
  for (const { pais, banco } of todos) if (remitente && banco.dominios.test(remitente)) return { id: banco.id, pais }
  // Sin remitente reconocible (p. ej. reenvío): se infiere del cuerpo.
  if (/banco de chile|bancochile|Fonobank/i.test(texto) && (origen === "adjunto" || /ha instruido la siguiente transferencia/i.test(texto))) return { id: "bancochile", pais: "cl" }
  if (/\bBci\b|BancoBci|Banco de Credito e Inversiones/i.test(texto)) return { id: "bci", pais: "cl" }
  // Bancos con el mismo nombre en dos países (Santander, Scotiabank, BBVA): la
  // pista del país (cuenta de destino o moneda) desempata; sin pista, Chile.
  const porNombre = todos.filter(({ banco }) => !/^(bancochile|bci)$/.test(banco.id) && banco.nombres.test(texto))
  if (porNombre.length) {
    const pref = porNombre.find((b) => b.pais === (paisPista || "cl")) || porNombre[0]
    // En el CUERPO de un correo solo se acepta por nombre lo que ya se aceptaba
    // (Santander, formato real de la casilla) o lo que va a NUESTRA cuenta de
    // ese país (un reenvío del cliente sin dominio del banco); el símbolo de
    // la moneda solo desempata, no acredita — una constancia a un tercero
    // reenviada por un cliente también dice "BBVA" y "S/". En un comprobante
    // transcrito (línea "Banco:") vale cualquiera: ahí el destino se exige aparte.
    if (origen === "adjunto" || pref.banco.id === "santander" || (paisDestino && pref.pais === paisDestino)) return { id: pref.banco.id, pais: pref.pais }
  }
  if (origen === "adjunto" && /\bBanco\s*:\s*\S/i.test(texto)) return { id: "otro", pais: "" }
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

/** Fecha local de un país → ISO, probando sus offsets posibles contra Intl. */
export function isoPais(fechaTexto: string, hora: string, pais: string | null | undefined): string {
  const ficha = fichaOperativa(pais)
  const m = fechaTexto.match(/^(\d{2})[\/-](\d{2})[\/-](\d{4})$/)
  if (!m) return ""
  const [, dd, mm, yyyy] = m
  const hh = (hora.match(/^(\d{1,2}):(\d{2})/) || [])
  const H = hh[1] ? hh[1].padStart(2, "0") : "12"
  const M = hh[2] || "00"
  const local = `${yyyy}-${mm}-${dd}T${H}:${M}:00`
  for (const off of ficha.offsets) {
    const iso = `${local}${off}`
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) continue
    try {
      const f = new Intl.DateTimeFormat("en-GB", {
        timeZone: ficha.tz,
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
  return new Date(`${local}${ficha.offsets[0]}`).toISOString()
}

/** Compatibilidad: la firma chilena original. */
export function isoChile(fechaTexto: string, hora: string): string {
  return isoPais(fechaTexto, hora, "cl")
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
  const habla = /transferencia|comprobante de pago|constancia de (?:operaci[oó]n|transferencia)/i.test(`${asunto}\n${texto}`)
  if (!habla) return null
  // Saliente (nosotros transfiriendo) o rechazo: no es un abono.
  if (/has realizado una transferencia|realizaste una transferencia|transferencia (?:fue )?rechazada|no pudo ser realizada/i.test(texto)) return null

  const cuentaDestino = capturar(texto, [
    /Cuenta de abono\s*:?\s*(?:\|\s*)*([\d-]{6,})/i,
    /N[º°o]?\.?\s*de cuenta\s*:?\s*(?:\|\s*)*([\d-]{6,})/i,
    /Cuenta destino\s*:?\s*(?:\|\s*)*([\d-]{6,})/i,
    /Cuenta de destino\s*:?\s*(?:\|\s*)*([\d-]{6,})/i,
    /CCI\s*(?:destino)?\s*:?\s*(?:\|\s*)*([\d-]{6,})/i,
  ])
  // ¿A quién va? Nuestra cuenta (de cualquier país) o nuestro nombre.
  const paisDestino = destinoNuestroEn(texto, cuentaDestino)
  const destinoNuestro = paisDestino !== null

  // El monto se captura CON su símbolo: "S/ 118.00" ya dice que es Perú.
  const montoTxt = capturar(texto, [
    /(?:Monto|Importe)\s+(?:transferido|Operaci[oó]n|abonado|total|de (?:la )?transferencia)\s*:?\s*(?:\|\s*)*((?:\$|S\/\.?|US\$|COP|MXN|PEN|CLP)?\s*[\d][\d.,]*)/i,
    /(?:Monto|Importe)\s*:?\s*(?:\|\s*)*((?:\$|S\/\.?|US\$|COP|MXN|PEN|CLP)\s*[\d][\d.,]*)/i,
  ])
  const paisMoneda = paisPorSimboloMoneda(montoTxt)

  const banco = bancoDeRemitente(remitente, texto, origen, paisDestino || paisMoneda, paisDestino)
  // País del aviso: banco → cuenta de destino → símbolo de la moneda. Un banco
  // "otro" no trae país.
  const pais: CodigoPaisOperativo | "" = (banco && banco.pais) || paisDestino || paisMoneda || (destinoNuestro ? "cl" : "")
  const monto = parsearMontoOperativo(montoTxt, pais || "cl")
  if (monto <= 0) return null

  const ordenante = capturar(texto, [
    /Titular de la cuenta de origen\s*:?\s*(?:\|\s*)*([^\n|]+)/i,
    /Raz[oó]n social\s*:?\s*(?:\|\s*)*([^\n|]+)/i,
    /instruido por nuestro cliente\s+([^,\n]+?)\s*,/i,
    /nuestro cliente\s+(.+?)\s+realiz[oó]/i,
    /Te informamos que\s+(.+?)\s+ha instruido/i,
    // Scotiabank empresas: "nuestro(a) cliente ITALSE SPA., con fecha …"
    /nuestro\(a\) cliente\s+(.+?)\s*,\s*con fecha/i,
    // Itaú: "transferencia realizada por DECO CHILE SPA." · BICE: "X ha instruido realizar una transferencia".
    /transferencia realizada por\s+(.+?)\s*\.?\s*$/im,
    /^\s*(.+?)\s+ha instruido realizar una transferencia/im,
    /transferencia de fondos de\s+(.+?)\s+hacia tu cuenta/i,
    /Ordenante\s*:?\s*(?:\|\s*)*([^\n|]+)/i,
    /Nombre del ordenante\s*:?\s*(?:\|\s*)*([^\n|]+)/i,
    /Titular\s*(?:de )?origen\s*:?\s*(?:\|\s*)*([^\n|]+)/i,
  ]).replace(/\s+/g, " ").trim()

  // Documento del ordenante: el primero que NO sea el nuestro (Santander
  // imprime el RUT de DESTINO, Victoria SA; un aviso peruano trae nuestro RUC).
  let rutOrdenante = ""
  for (const m of texto.matchAll(/\b(RUT|RUC|NIT|RFC)\s*:?\s*(?:\|\s*)*([\dA-Z][\d.\-A-Z]{6,14}?)(?=\s|\||$)/gi)) {
    const r = normalizarDocumento(m[2], m[1])
    if (r && !IDS_NUESTROS.has(soloDigitos(r))) { rutOrdenante = r; break }
  }

  const fechaHora = texto.match(/Fecha\s+y\s+hora\s*:?\s*(?:\|\s*)*(\d{2}[\/-]\d{2}[\/-]\d{4})\s+(\d{1,2}:\d{2})/i)
  const fechaTexto = (fechaHora
    ? fechaHora[1]
    : capturar(texto, [
        /Fecha(?:\s+(?:abono|de operaci[oó]n|y hora de operaci[oó]n))?\s*:?\s*(?:\|\s*)*(\d{2}[\/-]\d{2}[\/-]\d{4})/i,
        /con fecha\s+(\d{2}[\/-]\d{2}[\/-]\d{4})/i,
        /(\d{2}[\/-]\d{2}[\/-]\d{4})/,
      ])).replace(/-/g, "/")
  const hora = fechaHora ? fechaHora[2] : capturar(texto, [/\bHora\s*(?:de operaci[oó]n)?\s*:?\s*(?:\|\s*)*(\d{1,2}:\d{2})/i, /\d{2}\/\d{2}\/\d{4}\s+(\d{1,2}:\d{2})/])
  const nroOperacion = capturar(texto, [
    /N[º°o]?\.?\s*de\s+comprobante\s*:?\s*(?:\|\s*)*([A-Z0-9_-]{4,})/i,
    /N[uú]mero de (?:la )?operaci[oó]n\s*:?\s*(?:\|\s*)*([A-Z0-9_-]{4,})/i,
    /ID de la operaci[oó]n\s*:?\s*(?:\|\s*)*([A-Z0-9_-]{4,})/i,
    /N[º°o]?\.?\s*(?:de\s+)?operaci[oó]n\s*:?\s*(?:\|\s*)*([A-Z0-9_-]{4,})/i,
    /(?:Referencia|Clave de rastreo|Folio)\s*:?\s*(?:\|\s*)*([A-Z0-9_-]{4,})/i,
  ])
  const mensaje = capturar(texto, [
    /Comentario para el destinatario\s*:?\s*(?:\|\s*)*([^\n|]+)/i,
    // Itaú: "Mensaje de DECO CHILE SPA:\nPAGO INICIAL…"
    /\bMensaje de [^\n:]+:\s*(?:\|\s*)*([^\n|]+)/i,
    /\bMensaje\s*:?\s*(?:\|\s*)*([^\n|]+)/i,
    /\bComentario\s*:?\s*(?:\|\s*)*([^\n|]+)/i,
    /\bGlosa\s*:?\s*(?:\|\s*)*([^\n|]+)/i,
    /\bConcepto\s*:?\s*(?:\|\s*)*([^\n|]+)/i,
    /\bDescripci[oó]n\s*:?\s*(?:\|\s*)*([^\n|]+)/i,
    /\bDetalle\s*:\s*(?:\|\s*)*([^\n|]+)/i,
  ])
  const correoContacto = capturar(texto, [/Correo electr[oó]nico de contacto\s*:?\s*(?:\|\s*)*([^\s|]+@[^\s|]+)/i])
  const numeroCotizacion = numeroCotizacionEn(`${mensaje}\n${asunto}`)

  // Sin banco reconocido y sin nuestra cuenta como destino, no se acepta: un
  // correo cualquiera con la palabra "transferencia" y un monto no es un abono.
  if (!banco && !destinoNuestro) return null
  // Un comprobante adjunto además tiene que ir dirigido a NOSOTROS: una foto de
  // una transferencia a un tercero (proveedor, sueldo) también dice "Banco:".
  if (origen === "adjunto" && !destinoNuestro) return null

  return {
    banco: banco ? banco.id : "otro",
    pais,
    moneda: pais ? fichaOperativa(pais).moneda.codigo : "",
    remitente: origen === "adjunto" ? String(input.from || "").trim().toLowerCase() : remitente,
    ordenante,
    rutOrdenante,
    monto,
    fechaTexto,
    hora,
    fechaIso: fechaTexto ? isoPais(fechaTexto, hora, pais || "cl") : "",
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
/** Un pantallazo PEGADO en el cuerpo (Outlook lo manda inline) pesa mucho más que un logo de firma. */
const MIN_BYTES_INLINE = 25 * 1024
const MAX_BYTES_COMPROBANTE = 10 * 1024 * 1024

/**
 * Cuáles adjuntos vale la pena leer con visión: imagen o PDF de tamaño
 * razonable. Lo inline (logos de firmas y de los correos de los bancos) se
 * descarta solo si es chico: un comprobante pegado en el cuerpo del correo
 * también llega inline y hay que leerlo. Máximo `max` (los correos con 10
 * fotos no son comprobantes); los adjuntos "de verdad" van primero.
 */
export function adjuntosLegibles(adjuntos: AdjuntoCorreo[], max = 3): AdjuntoCorreo[] {
  const ok = adjuntos
    .filter((a) => /pdf|image\//.test(a.tipo) || RE_NOMBRE_LEGIBLE.test(a.nombre))
    .filter((a) => a.bytes >= (a.inline ? MIN_BYTES_INLINE : MIN_BYTES_COMPROBANTE) && a.bytes <= MAX_BYTES_COMPROBANTE)
  return [...ok.filter((a) => !a.inline), ...ok.filter((a) => a.inline)].slice(0, max)
}
