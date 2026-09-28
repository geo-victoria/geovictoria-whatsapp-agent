/**
 * CERTIFICACIÓN DE PAÍS — las 15 dimensiones que un país necesita para operar
 * con Vicky (21-sep, Lalo: "las 15 dimensiones son TODAS bloqueantes; no hay
 * deuda declarada posible sin decisión explícita"). Nació del hueco real de
 * Perú: 11 resueltas y 4 con hueco que nadie había escrito en ningún lado.
 *
 * SOLO LECTURA, CERO EFECTOS (Lalo 28-sep: "¿la certificación quemará turnos
 * de la tómbola?" → no): este módulo no tiene red, no toca vic_kv ni Zoho,
 * no dispara ninguna regla de asignación de Zoho y no consume rotaciones. Lee la ficha
 * operativa, la ficha del prompt, los adaptadores de las tools y el motor de
 * cotización, y corre el motor en memoria con datos sintéticos.
 *
 * Qué es "falta" y qué es "pendiente": una FALTA es algo que el código o la
 * ficha no declaran y que dejaría un cliente de ese país mal atendido (la
 * suite falla). Un PENDIENTE es lo que la ficha operativa declara
 * explícitamente en `pendientes` (personas, panel, decisiones de negocio):
 * está decidido y a la vista, no frena la suite pero sale en el informe.
 *
 * Lo que solo se puede medir con el TEXTO de los crons (matriz de plantillas
 * del loop, plantilla de presentación del traspaso, toque 0 del outbound) lo
 * inyecta el llamador por `Fuentes` — el test lo lee del disco; en Vercel el
 * endpoint no tiene el fuente y esas comprobaciones salen "no medible aquí".
 */
import {
  fichaOperativa,
  paisDeTelefonoOperativo,
  bancosConocidos,
  destinoNuestroEn,
  identificadoresNuestros,
  rosterSdrOperativo,
  rosterTelemarketingOperativo,
  reglaZoho,
  paisTieneProceso,
  formatearMontoOperativo,
  type CodigoPaisOperativo,
  type FichaOperativa,
} from "./paises/ficha-operativa.ts"
import { NUMERO_LINEA, channelIdPorPais, plantillaCoherenteConLinea, paisDePlantilla } from "./linea-por-pais.ts"
import { brechasDe, reglasExigidas } from "./paridad-prompt.ts"
import { textoNucleo } from "./prompt-nucleo/texto.ts"
import { FICHA_CL, type FichaPrompt } from "./prompt-nucleo/ficha.ts"
import { FICHA_PE } from "./paises/pe/ficha.ts"
import { FICHA_CO } from "./paises/co/ficha.ts"
import { FICHA_MX } from "./paises/mx/ficha.ts"
import {
  borradorVacio,
  identificadorValido,
  identificadorAdminValido,
  nombreIdentificadorAdmin,
  NOMBRE_IDENTIFICADOR,
} from "./onboarding/borrador.ts"
import { plantillasAltaPais, gatesAltaPais, renderPlantillaOnboarding } from "./onboarding/plantilla.ts"
import { revisarSalida } from "./cinturones-salida.ts"
import { cotizarPE, pctDescuentoPE, precioPlanPE } from "./paises/pe/cotizar.ts"
import { cotizarCO, precioPlanCO } from "./paises/co/cotizar.ts"
import { cotizarMX, precioPlanMX } from "./paises/mx/cotizar.ts"
import { pctDescuentoCO } from "./paises/co/descuento.ts"
import { pctDescuentoMX } from "./paises/mx/descuento.ts"
import { TOOL_SCHEMAS_PE_UNIFICADAS } from "./paises/pe/tools-unificadas.ts"
import { TOOL_SCHEMAS_CO_UNIFICADAS } from "./paises/co/tools-unificadas.ts"
import { TOOL_SCHEMAS_MX_UNIFICADAS } from "./paises/mx/tools-unificadas.ts"
import { CATALOGO_MODULOS } from "./catalogo/modulos.ts"

export type PaisCert = CodigoPaisOperativo
export const PAISES_CERT: readonly PaisCert[] = ["cl", "pe", "co", "mx"]

/** Las 15 dimensiones, en el orden del 21-sep. */
export const DIMENSIONES = [
  { id: "identidad_canal", n: 1, nombre: "Identidad y canal (prefijo, línea, zona horaria)" },
  { id: "prompt_venta", n: 2, nombre: "Prompt de venta (núcleo + ficha, 21 reglas, tools nombradas)" },
  { id: "catalogo_precios", n: 3, nombre: "Catálogo y precios (motor corre para 1-20)" },
  { id: "escalera_descuento", n: 4, nombre: "Escalera de descuento sobre el plan" },
  { id: "documento_tributario", n: 5, nombre: "Documento tributario de la empresa y del administrador" },
  { id: "emision", n: 6, nombre: "Emisión: tool de formal, entidad legal y padrón" },
  { id: "pasarela_pago", n: 7, nombre: "Pasarela y medios de pago" },
  { id: "registro_pago", n: 8, nombre: "Registro del pago (comprobante y aviso de banco)" },
  { id: "nota_venta", n: 9, nombre: "Nota de venta (moneda y solicitud de facturación)" },
  { id: "onboarding", n: 10, nombre: "Onboarding por chat (borrador, alta, kickoff)" },
  { id: "plantillas", n: 11, nombre: "Plantillas de WhatsApp coherentes con la línea" },
  { id: "cinturones", n: 12, nombre: "Cinturones de salida y blindaje de soporte" },
  { id: "personas", n: 13, nombre: "Personas: telemarketing, SDR, venta autónoma, líder" },
  { id: "legal_soporte", n: 14, nombre: "Bloque legal local y mesa de soporte" },
  { id: "calendario_reportes", n: 15, nombre: "Calendario, ventana de toques y reportes" },
] as const

export type DimensionId = (typeof DIMENSIONES)[number]["id"]

export type ResultadoDimension = {
  id: DimensionId
  n: number
  nombre: string
  ok: boolean
  /** Lo que sí está y cómo se verificó (para el informe). */
  detalle: string[]
  /** Lo que FALTA (bloqueante). */
  faltas: string[]
  /** Lo que no se pudo medir en este contexto (el endpoint sin el fuente de los crons). */
  noMedible: string[]
}

export type Certificacion = {
  pais: PaisCert
  nombre: string
  ok: boolean
  resueltas: number
  de: number
  dimensiones: ResultadoDimension[]
  /** Lo que la ficha operativa declara explícitamente como pendiente (no frena). */
  pendientesDeclarados: string[]
  soloLectura: true
}

/** Textos de los crons que el módulo no puede leer solo (los inyecta el test desde el disco). */
export type Fuentes = {
  /** app/api/vic-loop-cron/route.ts */
  loopCron?: string
  /** app/api/vic-ptv-cron/route.ts */
  ptvCron?: string
  /** app/api/vic-outbound-lead/route.ts */
  outboundLead?: string
  /** Nombres de las tools de Chile (lib/tools/index.ts); PE/CO/MX salen de sus sets únicos. */
  toolsCL?: string[]
}

const FICHAS_PROMPT: Record<PaisCert, FichaPrompt> = { cl: FICHA_CL, pe: FICHA_PE, co: FICHA_CO, mx: FICHA_MX }

/** Los 21 nombres canónicos (chilenos) que todo país expone (21-sep: "una sola tool por herramienta"). */
export const TOOLS_CANONICAS = [
  "cotizar_referencial",
  "consultar_descuento_referencial",
  "generar_link_cotizadora",
  "actualizar_cotizacion",
  "consultar_siguiente_descuento",
  "aplicar_siguiente_descuento",
  "anualizar_cotizacion",
  "derivar_a_soporte",
  "registrar_solicitud_callback",
  "consultar_disponibilidad_horario",
  "agendar_reunion",
  "reagendar_reunion",
  "registrar_comprobante_transferencia",
  "reenviar_cotizacion_correo",
  "enviar_cotizacion_whatsapp",
  "enviar_ficha_reloj",
  "enviar_certificacion",
  "consultar_agente_soporte",
  "programar_seguimiento",
  "marcar_no_contactar",
  "buscar_prospect_en_zoho",
] as const

function toolsDe(pais: PaisCert, f: Fuentes): string[] {
  if (pais === "pe") return TOOL_SCHEMAS_PE_UNIFICADAS.map((t) => t.name)
  if (pais === "co") return TOOL_SCHEMAS_CO_UNIFICADAS.map((t) => t.name)
  if (pais === "mx") return TOOL_SCHEMAS_MX_UNIFICADAS.map((t) => t.name)
  return f.toolsCL || []
}

/** Tools que el núcleo nombra (mismo extractor que tests/ficha-pe). */
function toolsNombradasEn(texto: string): string[] {
  return [
    ...new Set(
      (texto.match(/\b[a-z]+(?:_[a-z]+){1,4}\b/g) || []).filter((n) =>
        /^(cotizar|consultar|generar|derivar|agendar|reagendar|registrar|enviar|marcar|programar|reenviar|aplicar|actualizar|anualizar|buscar)_/.test(n),
      ),
    ),
  ]
}

/** Un ejemplo de celular del país, para las funciones que deciden por teléfono. */
function celularEjemplo(f: FichaOperativa): string {
  return f.prefijo + "9".padEnd(f.digitosCelular, "0")
}

// ── Lectura de la matriz de plantillas del loop desde el texto del cron ────────
/** tplCelda("ENV", cl, co, mx, pe) → {cl, co, mx, pe}; constantes como CO_PREFORM se resuelven. */
export function matrizLoopDesdeTexto(src: string): Array<{ env: string; cl: string; co: string; mx: string; pe: string }> {
  const consts = new Map<string, string>()
  for (const m of src.matchAll(/const\s+([A-Z_0-9]+)\s*=\s*"([^"]*)"/g)) consts.set(m[1], m[2])
  const val = (raw: string | undefined): string => {
    if (!raw) return ""
    const t = raw.trim()
    if (/^"/.test(t)) return t.slice(1, -1)
    return consts.get(t) ?? ""
  }
  const out: Array<{ env: string; cl: string; co: string; mx: string; pe: string }> = []
  // Quita comentarios de línea para que tplCelda(...) multilínea se parsee limpio.
  const limpio = src.replace(/\/\/[^\n]*/g, "")
  for (const m of limpio.matchAll(/tplCelda\(\s*"([A-Z_0-9]+)"\s*,([^)]*)\)/g)) {
    const args = m[2].split(",").map((a) => a.trim()).filter((a) => a.length)
    out.push({ env: m[1], cl: val(args[0]), co: val(args[1]), mx: val(args[2]), pe: val(args[3]) })
  }
  return out
}

function textoPlantillaPresentacion(src: string, pais: PaisCert): string | null {
  const re =
    pais === "cl"
      ? /VICKY_TM_TEMPLATE_PRESENTACION\s*\|\|\s*"([^"]*)"/
      : new RegExp(`VICKY_TM_TEMPLATE_PRESENTACION_${pais.toUpperCase()}\\s*\\|\\|\\s*(?:"([^"]*)"|TM_TEMPLATE)`)
  const m = src.match(re)
  if (!m) return null
  if (m[1] !== undefined) return m[1]
  const base = src.match(/VICKY_TM_TEMPLATE_PRESENTACION\s*\|\|\s*"([^"]*)"/)
  return base ? base[1] : null
}

function textoPlantillaToque0(src: string, pais: PaisCert): string | null {
  if (pais === "cl") return src.includes("OUTBOUND_TEMPLATE_LEAD") ? "(env OUTBOUND_TEMPLATE_LEAD)" : null
  if (pais === "pe") return /vicky_pe_lead_apertura/.test(src) ? "vicky_pe_lead_apertura" : null
  const m = src.match(new RegExp(`OUTBOUND_TEMPLATE_LEAD_${pais.toUpperCase()}\\s*\\|\\|\\s*"([^"]*)"`))
  return m ? m[1] : null
}

// ── Las 15 verificaciones ──────────────────────────────────────────────────────
type Ctx = { pais: PaisCert; fo: FichaOperativa; fp: FichaPrompt; f: Fuentes; prompt: string }

const CHEQUEOS: Record<DimensionId, (c: Ctx, r: ResultadoDimension) => void> = {
  identidad_canal(c, r) {
    const { fo, fp, pais } = c
    if (!/^\d{2}$/.test(fo.prefijo)) r.faltas.push("prefijo telefónico no declarado")
    if (!(fo.digitosCelular >= 8)) r.faltas.push("largo del celular no declarado")
    const cel = celularEjemplo(fo)
    if (paisDeTelefonoOperativo(cel) !== pais) r.faltas.push(`un celular ${cel} no se reconoce como ${pais}`)
    if (!NUMERO_LINEA[pais]) r.faltas.push("sin línea de WhatsApp declarada (NUMERO_LINEA)")
    // Chile toma su channelId de BOTMAKER_CHANNEL_V3 (env de Vercel): sin env no se mide, no es falta.
    if (!channelIdPorPais(pais)) {
      if (pais === "cl") r.noMedible.push("channelId de Chile (env BOTMAKER_CHANNEL_V3)")
      else r.faltas.push("sin channelId de Botmaker para la línea")
    }
    if (!fo.tz) r.faltas.push("sin zona horaria")
    if (fp.zonaTz !== fo.tz) r.faltas.push(`la ficha del prompt (${fp.zonaTz}) y la operativa (${fo.tz}) no coinciden en zona horaria`)
    if (!fo.zonaNombre) r.faltas.push("sin nombre de la zona para el cliente")
    r.detalle.push(`+${fo.prefijo} · línea ${NUMERO_LINEA[pais]} · ${fo.tz}`)
  },

  prompt_venta(c, r) {
    const { pais, prompt } = c
    const brechas = brechasDe(pais, prompt)
    const nuevas = brechas.filter((b) => !b.declarada)
    for (const b of nuevas) r.faltas.push(`regla global sin cumplir: ${b.id}`)
    r.detalle.push(`${reglasExigidas(pais).length - brechas.length}/${reglasExigidas(pais).length} reglas globales en el render`)
    const set = new Set(toolsDe(pais, c.f))
    if (!set.size) {
      r.noMedible.push("nombres de las tools (Chile: inyectar toolsCL)")
    } else {
      const nombradas = toolsNombradasEn(prompt)
      const sinSchema = nombradas.filter((n) => !set.has(n))
      if (sinSchema.length) r.faltas.push(`tools nombradas por el prompt sin schema: ${sinSchema.join(", ")}`)
      const canonFaltan = TOOLS_CANONICAS.filter((n) => !set.has(n))
      if (canonFaltan.length) r.faltas.push(`tools canónicas ausentes del set único: ${canonFaltan.join(", ")}`)
      r.detalle.push(`${set.size} tools en el set; ${nombradas.length} nombradas por el prompt`)
    }
    if (prompt.length < 50_000) r.faltas.push(`el prompt armado es sospechosamente corto (${prompt.length} chars)`)
  },

  catalogo_precios(c, r) {
    const { pais, fo, fp } = c
    try {
      if (pais === "cl") {
        const asis = CATALOGO_MODULOS.find((m) => m.id === "asistencia")
        if (!asis) throw new Error("catálogo CL sin módulo asistencia")
        for (const n of [1, 10, 11, 20]) {
          const t = asis.tiers.find((x) => n >= x.minUsuarios && n <= x.maxUsuarios)
          if (!t || !(t.precioUF > 0)) r.faltas.push(`sin tramo de asistencia para ${n} personas`)
        }
        r.detalle.push(`asistencia CL: ${asis.tiers.length} tramos en UF`)
      } else {
        const plan = pais === "pe" ? precioPlanPE : pais === "co" ? precioPlanCO : precioPlanMX
        for (const n of [1, 10, 11, 20]) if (!(plan(n) > 0)) r.faltas.push(`sin precio del plan para ${n} personas`)
        const ejec =
          pais === "pe"
            ? cotizarPE({ userCount: 15, reloj: { modalidad: "arriendo", cantidad: 1 }, puntos: [{ ubicacion: "Miraflores", zona: "lima", autoInstalada: true }], tipoCambio: 3.4 })
            : pais === "co"
              ? cotizarCO({ userCount: 15, reloj: { modalidad: "arriendo", cantidad: 1 }, puntos: [{ ubicacion: "Bogotá", zona: "capital", autoInstalada: true }] })
              : cotizarMX({ userCount: 15, reloj: { modalidad: "arriendo", cantidad: 1 }, puntos: [{ ubicacion: "CDMX", zona: "cdmx_metro", autoInstalada: true }] })
        if (!(ejec.mensualTotal > 0)) r.faltas.push("el motor no devuelve mensualidad para 15 personas + equipo")
        if (!ejec.itemsCotizador?.length) r.faltas.push("el motor no arma ítems para el cotizador")
        const soloApp = pais === "pe" ? cotizarPE({ userCount: 10, tipoCambio: 3.4 }) : pais === "co" ? cotizarCO({ userCount: 10 }) : cotizarMX({ userCount: 10 })
        if (!(soloApp.mensualTotal > 0)) r.faltas.push("el motor no devuelve mensualidad para 10 personas solo app")
        r.detalle.push(`15p + equipo → ${formatearMontoOperativo(ejec.mensualTotal, pais)} · 10p app → ${formatearMontoOperativo(soloApp.mensualTotal, pais)}`)
      }
    } catch (e) {
      r.faltas.push(`el motor de cotización falla: ${(e as Error).message}`)
    }
    if (!fp.ejemploMonto || !fp.ejemploMonto.includes(fo.moneda.simbolo.trim()))
      r.faltas.push(`el ejemplo de monto del prompt (${fp.ejemploMonto}) no lleva el símbolo del país (${fo.moneda.simbolo})`)
    if (!fo.moneda.codigo || !fo.moneda.simbolo) r.faltas.push("moneda sin código o símbolo")
    if (!(fo.impuesto.pct > 0) || fo.impuesto.pct !== fp.impuestoPct) r.faltas.push(`impuesto inconsistente: operativa ${fo.impuesto.pct} vs prompt ${fp.impuestoPct}`)
  },

  escalera_descuento(c, r) {
    const { pais } = c
    // Chile: la escalera vive en el cotizador (REC_PCTS [10,20] del orquestador) y en la tool consultar_descuento_referencial.
    if (pais === "cl") {
      r.detalle.push("escalera 10→20 del plan por 6 meses (cotizador + tools chilenas)")
      return
    }
    const pct = pais === "pe" ? pctDescuentoPE : pais === "co" ? pctDescuentoCO : pctDescuentoMX
    const e1 = Number(pct(1))
    const e2 = Number(pct(2))
    if (!(e1 > 0)) r.faltas.push("escalón 1 sin porcentaje")
    if (!(e2 > e1)) r.faltas.push("escalón 2 no sube sobre el 1")
    if (Math.round(e1 * 100) / 100 !== 0.1 && e1 !== 10) r.faltas.push(`escalón 1 = ${e1}, la regla global es 10 %`)
    if (Math.round(e2 * 100) / 100 !== 0.2 && e2 !== 20) r.faltas.push(`escalón 2 = ${e2}, la regla global es 20 %`)
    const set = new Set(toolsDe(pais, c.f))
    for (const t of ["consultar_descuento_referencial", "consultar_siguiente_descuento", "aplicar_siguiente_descuento"])
      if (!set.has(t)) r.faltas.push(`sin tool ${t}`)
    // Lo que el cliente lee: el descuento sale con el motor.
    try {
      const con = pais === "pe" ? cotizarPE({ userCount: 12, escalonDescuento: 1, tipoCambio: 3.4 }) : pais === "co" ? cotizarCO({ userCount: 12, escalonDescuento: 1 }) : cotizarMX({ userCount: 12, escalonDescuento: 1 })
      const sin = pais === "pe" ? cotizarPE({ userCount: 12, tipoCambio: 3.4 }) : pais === "co" ? cotizarCO({ userCount: 12 }) : cotizarMX({ userCount: 12 })
      const antes = pais === "pe" ? sin.mensualTotal : sin.mensualNetoPlan
      const despues = pais === "pe" ? (con as { mensualTotalConDescuento: number }).mensualTotalConDescuento : con.mensualNetoPlan
      if (!(despues > 0 && despues < antes)) r.faltas.push("el escalón 1 no rebaja el plan en el motor")
      else r.detalle.push(`12p: ${formatearMontoOperativo(antes, pais)} → ${formatearMontoOperativo(despues, pais)} con escalón 1`)
    } catch (e) {
      r.faltas.push(`el motor falla con descuento: ${(e as Error).message}`)
    }
  },

  documento_tributario(c, r) {
    const { pais, fo, fp } = c
    if (!fo.documento.etiqueta) r.faltas.push("documento de la empresa sin nombre")
    if (fo.documento.etiqueta !== fp.documento) r.faltas.push(`documento operativo (${fo.documento.etiqueta}) ≠ prompt (${fp.documento})`)
    if (!fo.documento.patron.test(fo.documento.ejemplo.replace(/\./g, "")) && !fo.documento.patron.test(fo.documento.ejemplo))
      r.faltas.push(`el ejemplo ${fo.documento.ejemplo} no pasa su propio patrón`)
    if (NOMBRE_IDENTIFICADOR[pais] !== fo.documento.etiqueta) r.faltas.push(`el borrador del onboarding llama ${NOMBRE_IDENTIFICADOR[pais]} al documento y la ficha ${fo.documento.etiqueta}`)
    if (!identificadorValido(fo.documento.ejemplo, pais)) r.faltas.push(`el validador del onboarding rechaza el ejemplo ${fo.documento.ejemplo}`)
    const admin = nombreIdentificadorAdmin(pais)
    if (!admin) r.faltas.push("sin nombre del documento del administrador")
    if (admin.toLowerCase() !== fp.documentoAdmin.toLowerCase()) r.faltas.push(`documento del admin: borrador ${admin} vs prompt ${fp.documentoAdmin}`)
    const ejAdmin: Record<PaisCert, string> = { cl: "12345678-5", pe: "12345678", co: "1020304050", mx: "GOMA800101HDFRRL09" }
    if (!identificadorAdminValido(ejAdmin[pais], pais)) r.faltas.push(`el validador del admin rechaza un ${admin} válido (${ejAdmin[pais]})`)
    r.detalle.push(`empresa ${fo.documento.etiqueta} (padrón ${fo.documento.padron || "ninguno"}) · admin ${admin}`)
    if (!fo.documento.padron && !/raz[oó]n social/i.test(fp.datosCierre + fp.bloques.minimoParaEmitir))
      r.faltas.push("sin padrón y el cierre no pide la razón social: la formal saldría sin nombre de empresa")
  },

  emision(c, r) {
    const { pais, fo, fp } = c
    const set = new Set(toolsDe(pais, c.f))
    if (set.size && !set.has("generar_link_cotizadora")) r.faltas.push("sin tool generar_link_cotizadora")
    if (set.size && !set.has("actualizar_cotizacion")) r.faltas.push("sin tool actualizar_cotizacion")
    if (!fo.entidad.razonSocial || !fo.entidad.identificador) r.faltas.push("entidad legal (razón social / identificador) sin declarar")
    if (!fp.bloques.minimoParaEmitir) r.faltas.push("la ficha del prompt no declara el mínimo para emitir")
    if (!fp.gatilloEmision) r.faltas.push("sin gatillo de emisión en la ficha del prompt")
    if (!fp.sitioPais) r.faltas.push("sin sección del sitio (links que Vicky comparte)")
    r.detalle.push(`${fo.entidad.razonSocial} ${fo.entidad.identificador} · mínimo para emitir declarado`)
    r.noMedible.push("aceptación, PDF y T&C del país viven en el cotizador (tests/pais-cotizacion.test.js)")
  },

  pasarela_pago(c, r) {
    const { fo, fp } = c
    const ofreceTransferencia = /transferencia/i.test(fp.bloques.tools + fp.bloques.minimoParaEmitir + fp.datosCierre)
    if (!fo.cuentas.length && ofreceTransferencia) r.faltas.push("el prompt ofrece transferencia y la ficha no tiene cuenta bancaria")
    for (const cta of fo.cuentas) {
      if (!cta.numero || !cta.banco || !cta.titular) r.faltas.push(`cuenta incompleta: ${JSON.stringify(cta)}`)
      if (cta.moneda !== fo.moneda.codigo && !/USD/.test(cta.moneda)) r.faltas.push(`cuenta en ${cta.moneda} para un país que cobra en ${fo.moneda.codigo}`)
    }
    if (!(fo.toleranciaMonto > 0)) r.faltas.push("sin tolerancia de monto para cruzar el aviso del banco")
    r.detalle.push(fo.cuentas.length ? `${fo.cuentas.length} cuenta(s): ${fo.cuentas.map((x) => x.banco).join(", ")}` : "solo tarjeta (sin cuenta declarada)")
    r.noMedible.push("credenciales de Mercado Pago del país (cotizador: /api/payments/mp-diag)")
  },

  registro_pago(c, r) {
    const { pais, fo } = c
    const set = new Set(toolsDe(pais, c.f))
    if (set.size && !set.has("registrar_comprobante_transferencia")) r.faltas.push("sin tool registrar_comprobante_transferencia")
    const bancos = bancosConocidos().filter((b) => b.pais === pais)
    if (fo.cuentas.length && !bancos.length) r.faltas.push("hay cuenta bancaria pero ningún banco conocido para leer el aviso")
    for (const cta of fo.cuentas) {
      if (destinoNuestroEn(`transferencia a la cuenta ${cta.numero}`) !== pais) r.faltas.push(`la cuenta ${cta.numero} no se reconoce como nuestra`)
    }
    if (!identificadoresNuestros().has(fo.entidad.identificadorDigitos)) r.faltas.push("el identificador de la entidad no está entre los nuestros (el aviso lo imprime como destino)")
    r.detalle.push(`${bancos.length} banco(s) reconocidos · identificador ${fo.entidad.identificadorDigitos}`)
  },

  nota_venta(c, r) {
    const { fo } = c
    const s = fo.solicitudes
    if (!s?.facturacionLayoutId) r.faltas.push("sin layout de Solicitud de Facturación")
    if (!s?.facturacionNombre?.includes("{empresa}")) r.faltas.push("la convención de nombre de la solicitud no lleva {empresa}")
    if (!s?.facturacionArea) r.faltas.push("sin área solicitante para la solicitud")
    if (!s?.stLayoutId) r.faltas.push("sin layout de TicketsST")
    if (!fo.moneda.codigo) r.faltas.push("sin código de moneda para el maestro de Creator")
    r.detalle.push(`SF layout ${s?.facturacionLayoutId} · ST layout ${s?.stLayoutId} · moneda ${fo.moneda.codigo}`)
    r.noMedible.push("escalera de la tabla de cobro y artículos de Books viven en el cotizador (escaleras-pais, creator-articulos)")
  },

  onboarding(c, r) {
    const { pais } = c
    const b = borradorVacio(pais)
    if (b.pais !== pais) r.faltas.push("el borrador vacío no nace con el país")
    const tpl = plantillasAltaPais(pais)
    if (!tpl.qr.name) r.faltas.push("sin plantilla quick-reply del alta")
    const gates = gatesAltaPais(pais)
    if (!gates.flow || !gates.qr) r.faltas.push("sin llaves de gate del alta por formulario")
    const conv = renderPlantillaOnboarding({ nombre: "X", empresa: "Y", rut_empresa: "Z" } as never, pais)
    if (!conv || conv.length < 40) r.faltas.push("sin plantilla conversacional del alta")
    if (pais !== "cl" && /\bRUT\b/.test(conv)) r.faltas.push("la plantilla conversacional del alta habla de RUT fuera de Chile")
    r.detalle.push(`QR ${tpl.qr.name}${tpl.flow.name ? ` · FLOW ${tpl.flow.name}` : " · sin FLOW propia (cae a la QR/conversacional)"} · gates ${gates.qr}/${gates.flow}`)
    r.noMedible.push("IMP con país/moneda y job NDV→IMP (lib/implementacion-vicky, lib/ndv-alta) se verifican en sus tests")
  },

  plantillas(c, r) {
    const { pais, f } = c
    const linea = NUMERO_LINEA[pais]
    const nombres: string[] = []
    const tplAlta = plantillasAltaPais(pais)
    nombres.push(tplAlta.qr.name)
    if (tplAlta.flow.name) nombres.push(tplAlta.flow.name)
    if (f.loopCron) {
      const matriz = matrizLoopDesdeTexto(f.loopCron)
      if (!matriz.length) r.faltas.push("no se pudo leer la matriz de plantillas del loop")
      const vacias: string[] = []
      for (const fila of matriz) {
        const v = fila[pais]
        // T3 va vacía a propósito en todos; el resto de las celdas debe tener plantilla.
        if (!v && fila.env !== "LOOP_TPL_T3") vacias.push(fila.env)
        if (v) nombres.push(v)
      }
      if (vacias.length) r.faltas.push(`celdas de la matriz del loop sin plantilla: ${[...new Set(vacias)].join(", ")}`)
      r.detalle.push(`matriz del loop: ${matriz.length} celdas leídas`)
    } else r.noMedible.push("matriz de plantillas del loop (fuente del cron)")
    if (f.ptvCron) {
      const t = textoPlantillaPresentacion(f.ptvCron, pais)
      if (!t) r.faltas.push("sin plantilla de presentación del traspaso fuera de ventana")
      else nombres.push(t)
    } else r.noMedible.push("plantilla de presentación del traspaso (fuente del cron)")
    if (f.outboundLead) {
      const t = textoPlantillaToque0(f.outboundLead, pais)
      if (!t) r.faltas.push("sin plantilla de apertura del toque 0")
      else if (!t.startsWith("(")) nombres.push(t)
    } else r.noMedible.push("plantilla de apertura del toque 0 (fuente del endpoint)")
    const incoherentes = [...new Set(nombres)].filter((n) => n && !plantillaCoherenteConLinea(n, linea))
    if (incoherentes.length) r.faltas.push(`plantillas de otro país en la línea ${linea}: ${incoherentes.join(", ")}`)
    const ajenas = [...new Set(nombres)].filter((n) => n && paisDePlantilla(n) && paisDePlantilla(n) !== pais && !plantillaCoherenteConLinea(n, linea))
    if (ajenas.length) r.faltas.push(`plantillas con marcador de otro país: ${ajenas.join(", ")}`)
    r.detalle.push(`${new Set(nombres).size} plantillas verificadas contra la línea`)
  },

  cinturones(c, r) {
    const { pais, fo } = c
    // El juez único tiene contención para el país: un precio sin tool NO sale tal cual.
    const v = revisarSalida({
      pais,
      reply: "Para 8 personas el plan queda en 0,55 UF + IVA al mes.",
      toolCalls: [],
      historialAsistente: [],
      userMessage: "cuánto cuesta",
    })
    if (v.accion === "ok") r.faltas.push("el cinturón de precio sin tool deja pasar un precio inventado")
    else r.detalle.push(`precio sin tool → ${v.accion} (${v.cinturon || v.motivos[0] || "?"})`)
    if (pais !== "cl" && !fo.soporte) r.faltas.push("sin tarjeta de soporte del país: el blindaje no tiene con qué reemplazar la Mesa chilena")
  },

  personas(c, r) {
    const { pais, fo } = c
    const tlmk = rosterTelemarketingOperativo(pais)
    const sdr = rosterSdrOperativo(pais)
    if (!tlmk.length) r.faltas.push("sin telemarketing declarado")
    if (!sdr.length) r.faltas.push("sin SDR declarada (los leads sin calificar no tienen a quién ir)")
    if (!fo.equipo.ventaAutonoma) r.faltas.push("sin gestor de la venta autónoma")
    if (!fo.equipo.lider) r.faltas.push("sin líder comercial (copias de traspasos y alarma de espejos)")
    const todas = [...tlmk, ...sdr, ...(fo.equipo.ventaAutonoma ? [fo.equipo.ventaAutonoma] : [])]
    for (const p of todas) {
      if (!/^\d{19}$/.test(p.zohoId)) r.faltas.push(`${p.email}: zohoId inválido`)
      if (!/@geovictoria\./.test(p.email)) r.faltas.push(`${p.email}: correo fuera del dominio`)
    }
    // El teléfono para presentar al ejecutivo sale de la ficha o de la ficha de
    // usuario de Zoho (telefonoFicha, 26-sep). Sin red no se puede afirmar que
    // falte: el endpoint en vivo lo completa leyendo Zoho (solo lectura).
    const sinFono = tlmk.filter((p) => !p.telefono).map((p) => p.nombre)
    if (sinFono.length) r.noMedible.push(`teléfono en Zoho de: ${sinFono.join(", ")} (se mide en vivo)`)
    if (!reglaZoho(pais, "deals") && paisTieneProceso(pais, "tombolaZoho")) r.faltas.push("tómbola por Zoho encendida sin regla de deals")
    r.detalle.push(`tlmk ${tlmk.length} · sdr ${sdr.length} · venta autónoma ${fo.equipo.ventaAutonoma?.nombre || "-"} · líder ${fo.equipo.lider || "-"} · tómbola ${paisTieneProceso(pais, "tombolaZoho") ? "Zoho" : "interna"}`)
  },

  legal_soporte(c, r) {
    const { pais, fo, fp } = c
    if (!fp.bloques.legal || fp.bloques.legal.length < 200) r.faltas.push("bloque legal del país vacío o demasiado corto")
    if (pais !== "cl" && /Direcci[oó]n del Trabajo|Resoluci[oó]n Exenta|art[ií]culo 22\b/i.test(fp.bloques.legal))
      r.faltas.push("el bloque legal arrastra normativa chilena")
    if (pais !== "cl") {
      if (!fo.soporte?.email || !fo.soporte?.telefono || !fo.soporte?.horario) r.faltas.push("mesa de soporte del país incompleta (correo, teléfono, horario)")
      else r.detalle.push(`soporte ${fo.soporte.email} · ${fo.soporte.telefono}`)
    } else r.detalle.push("soporte CL: tarjeta en la tool chilena (WA + 600)")
    if (!fp.reglaTuteo) r.faltas.push("sin regla de registro/tuteo local")
    r.detalle.push(`bloque legal ${fp.bloques.legal.length} chars`)
  },

  calendario_reportes(c, r) {
    const { pais, fo, fp } = c
    if (!(fo.horarioToques.desde >= 0 && fo.horarioToques.hasta > fo.horarioToques.desde)) r.faltas.push("ventana de toques mal declarada")
    if (!fo.offsets.length) r.faltas.push("sin offsets UTC para fechar avisos")
    try {
      new Intl.DateTimeFormat("es", { timeZone: fo.tz }).format(new Date(0))
    } catch {
      r.faltas.push(`zona horaria inválida: ${fo.tz}`)
    }
    if (!fp.bloques.agenda) r.faltas.push("la ficha del prompt no dice cómo se agenda en el país (con o sin agenda en línea)")
    const fmt = formatearMontoOperativo(1234.5, pais)
    if (!fmt || !fmt.includes(fo.moneda.simbolo.trim())) r.faltas.push(`el formateador de montos no usa el símbolo ${fo.moneda.simbolo}`)
    r.detalle.push(`toques ${fo.horarioToques.desde}-${fo.horarioToques.hasta} · ${fmt}`)
    r.noMedible.push("feriados del país viven en vic_holidays (vic-admin-holidays?country=)")
  },
}

export function certificarPais(pais: PaisCert, fuentes: Fuentes = {}): Certificacion {
  const fo = fichaOperativa(pais)
  const fp = FICHAS_PROMPT[pais]
  const prompt = textoNucleo(fp, "")
  const ctx: Ctx = { pais, fo, fp, f: fuentes, prompt }
  const dimensiones: ResultadoDimension[] = DIMENSIONES.map((d) => {
    const r: ResultadoDimension = { id: d.id, n: d.n, nombre: d.nombre, ok: true, detalle: [], faltas: [], noMedible: [] }
    try {
      CHEQUEOS[d.id](ctx, r)
    } catch (e) {
      r.faltas.push(`la verificación reventó: ${(e as Error).message}`)
    }
    r.ok = r.faltas.length === 0
    return r
  })
  const resueltas = dimensiones.filter((d) => d.ok).length
  return {
    pais,
    nombre: fo.nombre,
    ok: resueltas === dimensiones.length,
    resueltas,
    de: dimensiones.length,
    dimensiones,
    pendientesDeclarados: fo.pendientes,
    soloLectura: true,
  }
}

export function certificarTodos(fuentes: Fuentes = {}): Record<PaisCert, Certificacion> {
  return Object.fromEntries(PAISES_CERT.map((p) => [p, certificarPais(p, fuentes)])) as Record<PaisCert, Certificacion>
}
