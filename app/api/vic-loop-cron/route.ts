/**
 * CRON — Loop v2: motor unificado de toques proactivos (WhatsApp + llamada).
 *
 * DETRÁS DEL FLAG LOOP_V2_ENABLED (default off): con el flag apagado responde
 * {ok:true, skipped:"flag off"} sin tocar nada — se puede desplegar y agendar
 * el cron ANTES de encender el motor.
 *
 * Cada tick procesa hasta 20 filas de vic_loop en estado 'activo' con
 * next_touch_at vencido. ANTES de tocar, aplica los supresores:
 *   a) compromiso_at futuro → 'pausado_compromiso' hasta esa fecha.
 *   b) señal de humano (regla XV): mensajes de operador en el chat de Botmaker
 *      en las últimas 48h — o, como proxy, reunión en vic_v3_meetings a ±48h —
 *      → pospone el toque 48h (el humano ya está encima del lead).
 *   c) followup_closed_reason opt_out/perdido/soporte/rechazo → loop 'cerrado'.
 *   d) last_user_at posterior a t0 → el re-anclaje del webhook se perdió:
 *      se re-ancla acá (t0 = last_user_at, toque 1) y solo se toca si ya pasó
 *      la hora de inactividad.
 *
 * Toques 1,4,5,6,7 = WhatsApp (texto libre si la ventana de 24h de Meta está
 * abierta; plantilla HSM por TOQUE × ETAPA si no — matriz LOOP_TPL_MATRIZ con
 * los nombres reales de Botmaker como default CL y override por env; celda
 * vacía NO envía nada, patrón del repo).
 *
 * Toques 2,3 eran LLAMADA (Dapta). APAGADOS desde el 27-jul: con
 * DAPTA_ENABLED ausente el toque se salta y la cadencia avanza al siguiente
 * toque de WhatsApp. Ver lib/dapta-voice.ts para el motivo.
 *
 * Auth: x-cron-secret == vic_kv.followup_cron_secret (o Bearer/?key=CRON_SECRET),
 * mismo esquema que vic-outbound-cadence-cron.
 */

import { NextResponse } from "next/server"
import { sendBotmakerMessage, sendBotmakerTemplate } from "@/lib/botmaker-push-v3"
import { appendAssistantV3, getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import {
  ajustarAHabil,
  calcularProximoToque,
  loopV2Enabled,
  tzDePais,
  type LoopRow,
  type LoopStage,
} from "@/lib/loop-v2"
import { isTestContact, testContactSet } from "@/lib/funnel-analysis"
import { ptvHabilitado, debeTraspasar } from "@/lib/ptv"
import { duenoDealVigente, duenoCotizacionVigente } from "@/lib/tools/agendar-reunion"
import { llamadasDaptaHabilitadas } from "@/lib/dapta-voice"
import { PERFIL_CO } from "@/lib/paises/co"
import { PERFIL_MX } from "@/lib/paises/mx"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const BM_TOKEN = (process.env.BOTMAKER_ACCESS_TOKEN || "").trim()
const BATCH = 20

// Plantillas HSM (fuera de la ventana de 24h) por TOQUE × ETAPA — la matriz
// del Excel cerrado con Rodrigo/Lalo (24-jul); Lalo creó estas plantillas en
// Botmaker con variables ${nombre}/${empresa}. Los defaults de Chile son los
// nombres reales; cada celda es sobreescribible por env (LOOP_TPL_T<toque>_
// <ETAPA>). Colombia parte VACÍA (gemelas _co pendientes de crear): sin
// nombre configurado NO se envía plantilla (seguro por defecto) — al crearlas
// se setean los envs *_CO o se agregan defaults acá.
// Toques 6 y 7 son genéricos: una sola plantilla para las tres etapas.
// CO (decisión 25-jul: solo se tropicaliza lo imprescindible). Las plantillas
// del workspace sirven en TODAS las líneas (verificado por API), así que CO
// reutiliza: react_preform (sin_precio + toque VI, tono colombiano),
// vicky_loop_pago ("¿te ayudo con el pago?", neutra) para formal, y
// vicky_loop_despedida (neutra) para el VII. La única gemela de contenido es
// vicky_loop_con_precio_co (NIT en vez de RUT), creada por API el 25-jul.
function tplCelda(
  envName: string,
  defaultCl: string,
  defaultCo = "",
  defaultMx = "",
): { cl: string; co: string; mx: string } {
  return {
    cl: (process.env[envName] || defaultCl).trim(),
    co: (process.env[`${envName}_CO`] || defaultCo).trim(),
    mx: (process.env[`${envName}_MX`] || defaultMx).trim(),
  }
}
const CO_PREFORM = "vicky_co_react_preform"
const CO_CON_PRECIO = "vicky_loop_con_precio_co"
// MX (25-jul, número +52 conectado en Dapta): reutiliza las neutras
// multi-línea; con_precio pide RFC (vicky_loop_con_precio_mx, creada por
// API); toque VI usa la corta mexicana existente.
const MX_SIN_PRECIO = "vicky_loop_sin_precio"
const MX_CON_PRECIO = "vicky_loop_con_precio_mx"
const LOOP_TPL_T6 = tplCelda("LOOP_TPL_T6", "vicky_react_47_razones_v2", CO_PREFORM, "vicky_mx_react_corta")
const LOOP_TPL_T7 = tplCelda("LOOP_TPL_T7", "vicky_loop_despedida", "vicky_loop_despedida", "vicky_loop_despedida")
const LOOP_TPL_MATRIZ: Record<number, Record<LoopStage, { cl: string; co: string; mx: string }>> = {
  1: {
    // NO usar vicky_lead_nudge acá: es la única plantilla de la matriz que NO
    // pertenece a la familia vicky_loop_*, y está DESINCRONIZADA con Meta —
    // Botmaker guarda el texto largo con ${nombre}/${empresa} y Meta tiene
    // otro, corto y sin variables ("¿Todo ok? ¿Quieres que te cotice?"). Manda
    // el de Meta, y como los conteos de parámetros no calzan sale el #132000.
    // Métricas de Meta del 27-jul: 2 enviadas, 2 entregadas, 100% leídas, 0
    // respuestas. Ver el bloque VARS_PLANTILLA para el detalle.
    sin_precio: tplCelda("LOOP_TPL_T1_SIN_PRECIO", "vicky_loop_sin_precio", CO_PREFORM, MX_SIN_PRECIO),
    con_precio: tplCelda("LOOP_TPL_T1_CON_PRECIO", "vicky_loop_con_precio", CO_CON_PRECIO, MX_CON_PRECIO),
    formal: tplCelda("LOOP_TPL_T1_FORMAL", "vicky_loop_pago", "vicky_loop_pago", "vicky_loop_pago"),
  },
  4: {
    sin_precio: tplCelda("LOOP_TPL_T4_SIN_PRECIO", "vicky_loop_sin_precio", CO_PREFORM, MX_SIN_PRECIO),
    con_precio: tplCelda("LOOP_TPL_T4_CON_PRECIO", "vicky_loop_con_precio", CO_CON_PRECIO, MX_CON_PRECIO),
    formal: tplCelda("LOOP_TPL_T4_FORMAL", "vicky_loop_pago", "vicky_loop_pago", "vicky_loop_pago"),
  },
  5: {
    sin_precio: tplCelda("LOOP_TPL_T5_SIN_PRECIO", "vicky_loop_retoma", CO_PREFORM, "vicky_loop_retoma"),
    con_precio: tplCelda("LOOP_TPL_T5_CON_PRECIO", "vicky_loop_retoma_rut", CO_CON_PRECIO, MX_CON_PRECIO),
    formal: tplCelda("LOOP_TPL_T5_FORMAL", "vicky_loop_pago", "vicky_loop_pago", "vicky_loop_pago"),
  },
  6: { sin_precio: LOOP_TPL_T6, con_precio: LOOP_TPL_T6, formal: LOOP_TPL_T6 },
  7: { sin_precio: LOOP_TPL_T7, con_precio: LOOP_TPL_T7, formal: LOOP_TPL_T7 },
}

// Variables que cada plantilla DECLARA en su cuerpo, leídas de la API de
// Botmaker el 27-jul (GET /v2.0/whatsapp/templates?phoneLineNumber=...).
//
// Existe porque mandar un param que la plantilla NO declara no es inocuo:
// Botmaker ESCRIBE cada param en las variables del contacto antes de
// renderizar. Le estábamos mandando `empresa` a plantillas cuyo cuerpo ni
// siquiera la menciona — un write sin ningún efecto en el texto. De toda la
// matriz solo vicky_mx_react_corta usa ${empresa}; el resto usa ${nombre} o
// nada.
//
// Celda vacía = plantilla sin variables: no se le manda NADA. Plantilla que
// no esté en este mapa tampoco recibe params (default conservador): antes de
// agregarla, mirar su cuerpo real en Botmaker.
const VARS_PLANTILLA: Record<string, readonly string[]> = {
  vicky_loop_sin_precio: [],
  vicky_loop_con_precio: [],
  vicky_loop_con_precio_co: [],
  vicky_loop_con_precio_mx: [],
  vicky_loop_pago: ["nombre"],
  vicky_loop_retoma: ["nombre"],
  vicky_loop_retoma_rut: ["nombre"],
  vicky_loop_despedida: ["nombre"],
  vicky_react_47_razones_v2: ["nombre"],
  vicky_co_react_preform: ["nombre"],
  vicky_mx_react_corta: ["nombre", "empresa"],
}

/**
 * Params a mandar para `tpl`: solo las variables que la plantilla declara Y
 * de las que tenemos el valor REAL. Lo que se omite lo resuelve Botmaker con
 * la variable que ya guardó del mensaje de apertura, que es el dato bueno.
 */
function paramsParaPlantilla(
  tpl: string,
  disponibles: Record<string, string>,
): Record<string, string> {
  const declaradas = VARS_PLANTILLA[tpl] || []
  const out: Record<string, string> = {}
  for (const v of declaradas) {
    const valor = (disponibles[v] || "").trim()
    if (valor) out[v] = valor
  }
  return out
}

// ── Fallback SOLO cuando ni nosotros ni Botmaker tienen la variable ─────────
// Meta EXIGE valor para todo parámetro declarado: si nadie lo aporta, la
// plantilla completa rebota con "Parameter of type text is missing text
// value" (aviso de Botmaker 28-jul: vicky_loop_pago a un contacto sin
// ${nombre} guardado). Pero mandar un relleno A CIEGAS pisa la variable real
// del contacto (desastre del 27-jul). El orden correcto es de tres niveles:
//   1. valor local real → se manda;
//   2. la variable existe en el CHAT de Botmaker → se omite y resuelve él;
//   3. no existe en ningún lado → fallback inofensivo (no hay dato que pisar).
// Si el GET del chat falla, se omite como siempre (mejor un rebote raro que
// arriesgar un pisotón de datos).
const FALLBACK_VAR: Record<string, string> = {
  nombre: "👋",
  empresa: "tu negocio",
}

async function completarParamsConChat(
  contact: string,
  canal: string | undefined,
  tpl: string,
  params: Record<string, string>,
): Promise<Record<string, string>> {
  const declaradas = VARS_PLANTILLA[tpl] || []
  const faltantes = declaradas.filter((v) => !(params[v] || "").trim())
  if (faltantes.length === 0) return params
  try {
    const token = (process.env.BOTMAKER_ACCESS_TOKEN || "").trim()
    // Sin token o sin canal no hay cómo consultar el chat: se omite como
    // siempre (conservador).
    if (!token || !canal) return params
    const ref = `${canal}:${contact}`
    const res = await fetch(`https://api.botmaker.com/v2.0/chats/${encodeURIComponent(ref)}`, {
      headers: { "access-token": token, Accept: "application/json" },
      cache: "no-store",
    })
    if (!res.ok) {
      console.warn(`[loop-cron] GET chat ${contact} → ${res.status}: params quedan como están`)
      return params
    }
    const varsChat = ((await res.json())?.variables || {}) as Record<string, string>
    for (const v of faltantes) {
      if (!(varsChat[v] || "").trim()) {
        params[v] = FALLBACK_VAR[v] || "-"
        console.warn(`[loop-cron] ${contact}: sin ${v} local ni en Botmaker — fallback "${params[v]}" (${tpl})`)
      }
    }
  } catch (e) {
    console.warn(`[loop-cron] completarParamsConChat falló para ${contact}:`, e)
  }
  return params
}

// ── Toque de PRESENTACIÓN DE LA EJECUTIVA (Rodrigo, 27-jul) ─────────────────
// A las 2 HORAS de inactividad tras un preform o cotización (stages
// con_precio/formal), el toque 1 deja de ser un nudge genérico: presenta a la
// ejecutiva del país con su correo y WhatsApp, para que el cliente tenga un
// humano con nombre desde ese momento. Es la ÚNICA presentación de ejecutivo
// pre-pago permitida (excepción explícita a la regla del 17-jul) y la manda
// el SISTEMA, no el modelo. Nota consciente: las cotizaciones viejas de
// Anderson ya pasaron su toque 1 hace días, así que este texto solo alcanza a
// las nuevas — no hace falta resolver el Owner por fila.
const EJECUTIVA_LOOP: Record<"cl" | "co" | "mx", { nombre: string; email: string; whatsapp: string; trato: string }> = {
  cl: { nombre: "Eddyluz Mujica", email: "emujica@geovictoria.com", whatsapp: "+56 9 3932 1687", trato: "ella" },
  co: { nombre: "Alejandro Gordillo", email: "agordillo@geovictoria.com", whatsapp: "+57 314 267 7765", trato: "él" },
  mx: { nombre: "Yahel Segura", email: "ysegura@geovictoria.com", whatsapp: "+52 55 3763 6604", trato: "ella" },
}
// Teléfonos de los vendedores de la tómbola (extensible sin deploy por env
// VICKY_TELEFONOS_EJECUTIVOS="email:+56 9 ...,email:+56 9 ..."). Si no
// conocemos el teléfono, la línea de WhatsApp se OMITE — jamás el de otro.
const TEL_EJECUTIVO: Record<string, string> = {
  "emujica@geovictoria.com": "+56 9 3932 1687",
  "adiazg@geovictoria.com": "+56 9 3937 2058",
  "tmartinezq@geovictoria.com": "+56 9 3452 9937",
  "alopez@geovictoria.com": "+56 9 6647 4270",
}
function telefonoDeEjecutivo(email: string): string {
  for (const par of (process.env.VICKY_TELEFONOS_EJECUTIVOS || "").split(",")) {
    const idx = par.indexOf(":")
    if (idx > 0 && par.slice(0, idx).trim().toLowerCase() === email.toLowerCase()) {
      return par.slice(idx + 1).trim()
    }
  }
  return TEL_EJECUTIVO[email.toLowerCase()] || ""
}

function textoPresentacion(
  pais: "cl" | "co" | "mx",
  duenoReal?: { nombre: string; email: string } | null,
): string {
  // El dueño REAL del deal/cotización (tómbola, 31-jul) manda sobre el símil
  // fijo del país: presentar a Eddyluz cuando el registro es de Ana Paula le
  // pone DOS nombres al mismo prospecto (caso Alan/vaitiare). El directorio
  // fijo queda solo como fallback cuando aún no hay dueño humano.
  const e =
    duenoReal?.nombre && duenoReal?.email
      ? {
          nombre: duenoReal.nombre,
          email: duenoReal.email,
          whatsapp: telefonoDeEjecutivo(duenoReal.email),
          trato: duenoReal.nombre.split(" ")[0],
        }
      : EJECUTIVA_LOOP[pais]
  return (
    `Te presento a ${e.nombre}, quien te ayudará con el resto del proceso 😊\n` +
    `✉️ ${e.email}\n` +
    (e.whatsapp ? `📱 WhatsApp: ${e.whatsapp}\n` : "") +
    `\nTu cotización sigue vigente — cualquier duda la resolvemos ${e.trato} o yo por aquí.`
  )
}

// Texto libre por stage y país (ventana de 24h abierta). Cortos, sin inventar
// precios ni links: solo empujan el siguiente paso del embudo. CL en tono
// chileno cálido; CO en tuteo colombiano ("de una", "te cuento").
const TEXTOS: Record<LoopStage, { cl: string; co: string; mx: string }> = {
  sin_precio: {
    cl:
      "Hola! Soy Vicky de GeoVictoria 😊 Para armarte el valor de inmediato solo me falta saber cuántas personas marcarían asistencia y cómo les gustaría marcar (app, huella o reconocimiento facial).\n¿Me cuentas y lo dejamos listo?",
    co:
      "Hola! Soy Vicky de GeoVictoria 😊 Te cuento: para armarte el valor de una solo necesito saber cuántas personas marcarían asistencia y cómo les gustaría marcar (app, huella o reconocimiento facial).\nMe cuentas y lo dejamos listo?",
    mx:
      "Hola! Soy Vicky de GeoVictoria 😊 Para armarte el valor de inmediato solo me falta saber cuántas personas registrarían su asistencia y cómo les gustaría checar (app, huella o reconocimiento facial).\n¿Me cuentas y lo dejamos listo?",
  },
  con_precio: {
    cl:
      "Hola! Soy Vicky de GeoVictoria 😊 Tu valor ya está listo — solo me falta el RUT (o tu ok) para dejarte la cotización formal.\n¿Avanzamos?",
    co:
      "Hola! Soy Vicky de GeoVictoria 😊 Te cuento que tu valor ya está listo — solo me falta el NIT (o tu ok) para dejarte la cotización formal.\nLa armamos de una?",
    mx:
      "Hola! Soy Vicky de GeoVictoria 😊 Tu valor ya está listo — solo me falta el RFC (o tu ok) para dejarte la cotización formal.\n¿Avanzamos?",
  },
  formal: {
    cl:
      "Hola! Soy Vicky de GeoVictoria 😊 Tu cotización sigue vigente y la puedes aceptar y pagar en línea cuando quieras.\nSi te quedó alguna duda, la vemos enseguida por acá.",
    co:
      "Hola! Soy Vicky de GeoVictoria 😊 Te cuento que tu cotización sigue vigente y la puedes aceptar y pagar en línea cuando quieras.\nSi te queda alguna duda, la resolvemos de una por acá.",
    mx:
      "Hola! Soy Vicky de GeoVictoria 😊 Tu cotización sigue vigente y la puedes aceptar cuando gustes.\nSi te quedó alguna duda, la resolvemos por aquí.",
  },
}

type ConvRow = {
  id: string | null
  contact: string
  last_user_at: string | null
  followup_closed_reason: string | null
  followup_status: string | null
  followup_next_at: string | null
  formal_quote_id: string | null
  pref_escalon: number | null
  pref_params: unknown | null
}

/**
 * Razón social REAL del contacto, desde el puntero de su cotización formal.
 * "" si no la tenemos — y en ese caso NO se manda el param: es preferible que
 * Botmaker resuelva ${empresa} con la variable que ya guardó del mensaje de
 * apertura, antes que pisarla con un relleno.
 */
async function empresaDeCotizacion(contact: string): Promise<string> {
  try {
    const res = await supa(
      `vic_v3_quote_pointers?contact=eq.${encodeURIComponent(contact)}` +
        `&select=empresa&order=updated_at.desc&limit=1`,
    )
    if (!res.ok) return ""
    const rows = (await res.json().catch(() => [])) as Array<{ empresa?: string | null }>
    return (rows?.[0]?.empresa || "").trim()
  } catch {
    return ""
  }
}

/**
 * Contactos a los que Vicky YA les mostró un precio, leído del historial real.
 *
 * CASO QUE ORIGINA ESTA FUNCIÓN (27-jul, Ignacia de Tierra del Carmen): a las
 * 12:31 recibió el valor completo — $46.011/mes más $48.433 de instalación —,
 * a las 12:33 Vicky le pidió el RUT, y a las 13:35 el loop le escribió "solo
 * me falta saber cuántas personas marcarían asistencia y cómo les gustaría
 * marcar". Le preguntó dos datos que ella había entregado una hora antes.
 *
 * El motivo: la etapa se derivaba de `pref_escalon` / `pref_params`, que solo
 * se escriben cuando hubo NEGOCIACIÓN DE DESCUENTO. `cotizar_referencial` —el
 * camino normal, el que usa la enorme mayoría— no toca ninguno de los dos. Un
 * lead con precio pero sin descuento negociado quedaba en `sin_precio` para
 * siempre.
 *
 * No es un caso aislado: de 110 conversaciones que recibieron precio, 100 eran
 * invisibles para el loop.
 *
 * La señal correcta es el mensaje mismo. "Total mensual" aparece en el
 * resumen de precio de los tres países (CL "Total mensual con IVA", CO "Total
 * mensual: $…", MX "Total mensual: … + IVA (16%)"), y en ningún otro texto de
 * Vicky. Una query por batch, no por contacto.
 */
async function contactosQueVieronPrecio(convs: Map<string, ConvRow>): Promise<Set<string>> {
  const porId = new Map<string, string>()
  for (const [contact, c] of convs) if (c.id) porId.set(c.id, contact)
  if (porId.size === 0) return new Set()
  try {
    const ids = [...porId.keys()].map((id) => `"${id}"`).join(",")
    const res = await supa(
      `vic_v3_messages?conversation_id=in.(${ids})&role=eq.assistant` +
        `&content=like.*Total mensual*&select=conversation_id`,
    )
    if (!res.ok) return new Set()
    const filas = (await res.json().catch(() => [])) as Array<{ conversation_id?: string }>
    const out = new Set<string>()
    for (const f of filas) {
      const contacto = f.conversation_id ? porId.get(f.conversation_id) : undefined
      if (contacto) out.add(contacto)
    }
    return out
  } catch (e) {
    // Ante la duda NO se asume precio: se cae al comportamiento anterior, que
    // pregunta de más pero no inventa que ya cotizamos.
    console.error("[loop-cron] contactosQueVieronPrecio falló:", e)
    return new Set()
  }
}

function supa(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    cache: "no-store",
  })
}

async function authorized(req: Request): Promise<boolean> {
  const xcron = (req.headers.get("x-cron-secret") || "").trim()
  if (xcron) {
    const expected = await getFollowupCronSecret().catch(() => "")
    if (expected && xcron === expected) return true
  }
  if (CRON_SECRET) {
    const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
    if (bearer === CRON_SECRET) return true
    const key = (new URL(req.url).searchParams.get("key") || "").trim()
    if (key === CRON_SECRET) return true
  }
  return false
}

/** PATCH sobre la fila del loop del contacto (best-effort, patrón del repo). */
async function patchLoop(contact: string, body: Record<string, unknown>): Promise<void> {
  await supa(`vic_loop?contact=eq.${encodeURIComponent(contact)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ ...body, updated_at: new Date().toISOString() }),
  }).catch(() => {})
}

/**
 * Señal de HUMANO por Botmaker (regla XV): mensajes de las últimas 48h del
 * workspace cuyo `from` NO es ni 'user' ni el bot automático — un operador
 * humano entró al chat. Se trae UNA página por tick (no una consulta por
 * contacto) y se devuelve el set de contactos con señal. Si la API no es
 * concluyente para un contacto, el llamador usa el proxy de reuniones.
 */
async function contactosConOperador(contacts: Set<string>): Promise<Set<string>> {
  const conHumano = new Set<string>()
  if (!BM_TOKEN || contacts.size === 0) return conHumano
  try {
    const desde = new Date(Date.now() - 48 * 3600e3).toISOString()
    const r = await fetch(
      `https://api.botmaker.com/v2.0/messages?chat-platform=whatsapp&limit=250&from=${encodeURIComponent(desde)}`,
      { headers: { "access-token": BM_TOKEN, Accept: "application/json" }, cache: "no-store" },
    )
    const data = (await r.json().catch(() => ({}))) as {
      items?: Array<{
        from?: string
        // Campos de agente que Botmaker adjunta cuando un operador escribe
        // (el shape exacto varía por workspace; cualquiera truthy cuenta).
        operatorId?: string
        agentId?: string
        chat?: { contactId?: string }
      }>
    }
    for (const m of data.items || []) {
      const c = m.chat?.contactId || ""
      if (!c || !contacts.has(c)) continue
      const from = (m.from || "").toLowerCase()
      // 'user' = el cliente; 'bot' = Vicky automática. Cualquier otro emisor
      // (o marca explícita de operador) = humano metido en el chat.
      const esHumano = Boolean(m.operatorId || m.agentId) || (from !== "" && from !== "user" && from !== "bot")
      if (esHumano) conHumano.add(c)
    }
  } catch (e) {
    console.error("[loop-cron] consulta de mensajes Botmaker falló:", e)
  }
  return conHumano
}

/** Proxy de señal humana: reunión agendada a ±48h del contacto (vic_v3_meetings). */
async function tieneReunionCercana(contact: string): Promise<boolean> {
  const desde = new Date(Date.now() - 48 * 3600e3).toISOString()
  const hasta = new Date(Date.now() + 48 * 3600e3).toISOString()
  const r = await supa(
    `vic_v3_meetings?contact=eq.${encodeURIComponent(contact)}&status=eq.scheduled` +
      `&start_at=gte.${desde}&start_at=lte.${hasta}&select=booking_uid&limit=1`,
  ).catch(() => null)
  if (!r || !r.ok) return false
  const rows = ((await r.json().catch(() => [])) as unknown[]) || []
  return rows.length > 0
}

export async function GET(req: Request): Promise<Response> {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  // Flag maestro: apagado = no-op total (deploy seguro antes del switch-on).
  if (!loopV2Enabled()) {
    return NextResponse.json({ ok: true, skipped: "flag off" })
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return NextResponse.json({ ok: false, error: "Supabase no configurado" }, { status: 503 })
  }

  const nowIso = new Date().toISOString()
  const res = await supa(
    `vic_loop?estado=eq.activo&next_touch_at=lte.${nowIso}` +
      `&select=contact,country,stage,t0,next_touch,next_touch_at,estado,compromiso_at,motivo_cierre` +
      `&order=next_touch_at.asc&limit=${BATCH}`,
  )
  const rows = (res.ok ? ((await res.json().catch(() => [])) as LoopRow[]) : []).filter(
    (r) => r.contact && !isTestContact(r.contact, testContactSet()),
  )

  let procesados = 0
  let enviadosTexto = 0
  let enviadosPlantilla = 0
  let llamadas = 0
  let pospuestos = 0
  let cerrados = 0
  const detalle: Array<Record<string, unknown>> = []

  if (rows.length === 0) {
    return NextResponse.json({
      ok: true,
      procesados,
      enviados_texto: enviadosTexto,
      enviados_plantilla: enviadosPlantilla,
      llamadas,
      pospuestos,
      cerrados,
    })
  }

  // Estado conversacional de todos los contactos en una sola query (mismo
  // patrón batch que la cadencia outbound).
  const contactsIn = rows.map((r) => `"${r.contact}"`).join(",")
  const convRes = await supa(
    `vic_v3_conversations?contact=in.(${contactsIn})&select=id,contact,last_user_at,followup_closed_reason,followup_status,followup_next_at,formal_quote_id,pref_escalon,pref_params`,
  )
  const convs = new Map<string, ConvRow>()
  for (const c of (convRes.ok ? await convRes.json() : []) as ConvRow[]) convs.set(c.contact, c)

  const yaVieronPrecio = await contactosQueVieronPrecio(convs)

  // Señal de humano por Botmaker: UNA página del workspace para todo el batch.
  const conOperador = await contactosConOperador(new Set(rows.map((r) => r.contact)))

  // Contactos con PTV ACTIVO (un vendedor ya está encima). El cron del PTV
  // cierra el loop al traspasar, pero los traspasos que NO pasan por él (p.
  // ej. los `presentacion_manual` del 31-jul) dejaban la fila viva y el toque
  // de presentación salía con la ejecutiva FIJA del país: el prospecto
  // recibía DOS nombres distintos (caso Alan/vaitiare: Ana Paula 11:21,
  // Eddyluz 18:00). Con vendedor asignado, Vicky no manda toques.
  const ptvRes = await supa(`vic_ptv?estado=eq.activo&select=contact&limit=1000`)
  const ptvActivos = new Set<string>(
    ((ptvRes.ok ? await ptvRes.json().catch(() => []) : []) as Array<{ contact: string }>).map((p) => p.contact),
  )

  for (const r of rows) {
    procesados++
    const now = Date.now()
    const country = (r.country || "cl").trim().toLowerCase()
    const esCO = country === "co"
    const conv = convs.get(r.contact)
    let t0 = r.t0 || nowIso
    let touch = Math.min(Math.max(r.next_touch || 1, 1), 7)

    // (a-0) Traspasado a vendedor: el loop muere con el mismo motivo que pone
    // el cron del PTV. Va antes que todo — con un humano a cargo, ni
    // compromisos ni toques: solo el chequeo de calidad de las 9 h (del PTV).
    if (ptvActivos.has(r.contact)) {
      await patchLoop(r.contact, { estado: "cerrado", motivo_cierre: "ptv_traspasado" })
      cerrados++
      detalle.push({ contact: r.contact, accion: "cerrado", motivo: "ptv_traspasado" })
      continue
    }

    // (a) Ventana de compromiso: el cliente acordó retomar en una fecha — se
    // respeta a rajatabla, ningún toque antes de esa fecha.
    if (r.compromiso_at && new Date(r.compromiso_at).getTime() > now) {
      await patchLoop(r.contact, {
        estado: "pausado_compromiso",
        next_touch_at: r.compromiso_at,
      })
      pospuestos++
      detalle.push({ contact: r.contact, accion: "pausado_compromiso", hasta: r.compromiso_at })
      continue
    }

    // (c) Cierres definitivos del ciclo conversacional: si el contacto ya se
    // cerró en el motor de followups por opt-out/perdido/soporte/rechazo, el
    // loop muere con el mismo motivo (paridad con la reactivación, que excluye
    // exactamente estas razones). Va antes que la señal de humano: un opt-out
    // no se "pospone", se respeta.
    //
    // 'derivado' se sumó el 27-jul. Es el motivo que pone el webhook cuando la
    // conversación pasó a un HUMANO (ejecutivo o Foundry). El loop lo ignoraba
    // y seguía escribiendo en paralelo: de los 7 toques por plantilla desde el
    // encendido, 3 fueron a contactos 'derivado' — uno de ellos había cerrado
    // con "Gracias, espero contacto el próximo lunes". Es exactamente la venta
    // paralela a ciegas que el commit f4fc0b7 (caso Ingesub) vino a matar, y
    // el loop la reabrió por la puerta de atrás.
    const reason = conv?.followup_closed_reason || ""
    if (["opt_out", "perdido", "soporte", "rechazo", "derivado"].includes(reason)) {
      await patchLoop(r.contact, { estado: "cerrado", motivo_cierre: reason })
      cerrados++
      detalle.push({ contact: r.contact, accion: "cerrado", motivo: reason })
      continue
    }

    // (c-bis) GATE DE HORARIO HÁBIL AL EJECUTAR (fix 25-jul, encendido): una
    // fila con next_touch_at vencido (migración vieja, cron detenido) NO puede
    // disparar un toque a las 23:00 de un viernes — si AHORA no es L-V 9-19 en
    // la zona del país, el toque se pospone al próximo bloque hábil.
    // ajustarAHabil devuelve el mismo instante cuando ya estamos en hábil.
    const ahoraHabil = ajustarAHabil(new Date(now), tzDePais(country), r.contact)
    if (ahoraHabil.getTime() > now + 60_000) {
      await patchLoop(r.contact, { next_touch_at: ahoraHabil.toISOString() })
      pospuestos++
      detalle.push({ contact: r.contact, accion: "pospuesto_horario", hasta: ahoraHabil.toISOString() })
      continue
    }

    // (c-ter) SEGUIMIENTO CONSENSUADO (fix 25-jul, caso Tamara): si el cliente
    // acordó con Vicky un momento para retomar (followup_status 'consensuado'
    // con fecha futura), el loop NO lo pisa — el toque se pospone a esa fecha.
    const consensuadoMs =
      conv?.followup_status === "consensuado" && conv?.followup_next_at
        ? new Date(conv.followup_next_at).getTime()
        : 0
    if (consensuadoMs > now) {
      await patchLoop(r.contact, { next_touch_at: new Date(consensuadoMs).toISOString() })
      pospuestos++
      detalle.push({
        contact: r.contact,
        accion: "pospuesto_consensuado",
        hasta: new Date(consensuadoMs).toISOString(),
      })
      continue
    }

    // (b) Señal de humano (regla XV): un operador escribió en el chat en las
    // últimas 48h (Botmaker) o hay reunión a ±48h (proxy) → el humano está
    // encima del lead; el loop solo POSPONE 48h (corrido a hábil) y sigue
    // activo. Simple a propósito: sin estado intermedio persistido.
    if (conOperador.has(r.contact) || (await tieneReunionCercana(r.contact))) {
      const en48h = ajustarAHabil(new Date(now + 48 * 3600e3), tzDePais(country), r.contact)
      await patchLoop(r.contact, {
        estado: "activo",
        next_touch_at: en48h.toISOString(),
      })
      pospuestos++
      detalle.push({ contact: r.contact, accion: "pospuesto_humano" })
      continue
    }

    // (d) Re-anclaje perdido: si el cliente habló DESPUÉS del t0, el webhook
    // debió resetear el loop y no lo hizo (deploy a medias, race). Se re-ancla
    // acá: t0 = último mensaje del cliente, toque 1. Solo se toca AHORA si ya
    // pasó la hora de inactividad; si no, queda programado y sale otro tick.
    const lastUserMs = conv?.last_user_at ? new Date(conv.last_user_at).getTime() : 0
    if (lastUserMs && lastUserMs > new Date(t0).getTime()) {
      t0 = new Date(lastUserMs).toISOString()
      touch = 1
      const nt = calcularProximoToque(t0, 1, country, r.contact)
      await patchLoop(r.contact, {
        t0,
        next_touch: 1,
        next_touch_at: nt.toISOString(),
        estado: "activo",
        compromiso_at: null,
      })
      if (nt.getTime() > now) {
        pospuestos++
        detalle.push({ contact: r.contact, accion: "re_anclado", next: nt.toISOString() })
        continue
      }
      // La hora de inactividad ya pasó (y estamos en hábil): toca el 1 ahora.
    }

    // ── Ejecutar el toque ──────────────────────────────────────────────────
    const esMX = country === "mx"
    const paisKey: "cl" | "co" | "mx" = esMX ? "mx" : esCO ? "co" : "cl"
    const canal = esMX ? PERFIL_MX.canal.channelId : esCO ? PERFIL_CO.canal.channelId : undefined
    // Etapa DERIVADA del estado real de la conversación (nadie escribe stage
    // en vic_loop de forma confiable): cotización formal emitida → 'formal';
    // precio/preform ya mostrado (puntero pref_*) → 'con_precio'; si no, lo
    // guardado o 'sin_precio'. Así el toque siempre pide el paso correcto.
    const stage: LoopStage = conv?.formal_quote_id
      ? "formal"
      : conv?.pref_escalon !== null && conv?.pref_escalon !== undefined
        ? "con_precio"
        : conv?.pref_params
          ? "con_precio"
          : // El historial manda sobre los punteros: si Vicky ya mostró un
            // precio, preguntar de nuevo cuántas personas marcarían es
            // insultante. Ver contactosQueVieronPrecio (caso Ignacia).
            yaVieronPrecio.has(r.contact)
            ? "con_precio"
            : (r.stage as LoopStage) || "sin_precio"

    // (e) ANTI-EMPALME con el PTV (doc "Vicky paso a paso", 30-jul): si el
    // traspaso a vendedor está a menos de 1 h de dispararse para este
    // contacto, el toque se pospone 1 h — un toque seguido de la presentación
    // del vendedor son dos mensajes de Vicky casi juntos, y el vendedor va a
    // retomar con todo el contexto de todos modos. Proyección con el MISMO
    // motor de decisión del cron PTV, evaluado a ahora+1h.
    if (ptvHabilitado() && lastUserMs > 0) {
      const proyeccion = debeTraspasar({
        referenciaRelojAt: new Date(lastUserMs),
        clienteRespondioDespues: false,
        precioMostrado: stage !== "sin_precio",
        pais: paisKey,
        ahora: new Date(now + 3600e3),
        compromisoAt: r.compromiso_at ? new Date(r.compromiso_at) : null,
        traspasoActivo: false,
      })
      if (proyeccion.traspasar) {
        await patchLoop(r.contact, { next_touch_at: new Date(now + 3600e3).toISOString() })
        pospuestos++
        detalle.push({ contact: r.contact, accion: "pospuesto_ptv_cercano", touch })
        continue
      }
    }

    let ejecutado = false

    // Rodrigo 27-jul: la presentación con precio sale a las 2 HORAS de
    // inactividad, no a la 1h del toque 1 genérico. EXCEPCIÓN 08-ago (punto 4
    // de Lalo): con cotización FORMAL emitida el primer toque sale a los 35
    // MINUTOS — la mediana histórica emisión→pago es 36 min, y el empujón
    // ("¿te ayudo con el pago?") debe caer DENTRO de la ventana real de
    // compra, no cuando el cliente ya se enfrió.
    if (touch === 1 && (stage === "con_precio" || stage === "formal")) {
      const espera = stage === "formal" ? 35 * 60e3 : 2 * 3600e3
      const objetivo = new Date(new Date(t0).getTime() + espera)
      if (now < objetivo.getTime()) {
        const habil = ajustarAHabil(objetivo, tzDePais(country), r.contact)
        await patchLoop(r.contact, { next_touch_at: habil.toISOString() })
        pospuestos++
        detalle.push({ contact: r.contact, accion: stage === "formal" ? "pospuesto_formal_35m" : "pospuesto_presentacion_2h", hasta: habil.toISOString() })
        continue
      }
    }

    if ((touch === 2 || touch === 3) && !llamadasDaptaHabilitadas()) {
      // Llamadas Dapta apagadas (27-jul): el toque NO se agenda, pero SÍ se
      // marca ejecutado para que la cadencia avance al siguiente toque de
      // WhatsApp en vez de quedarse trabada reintentando una llamada que no
      // va a ocurrir.
      ejecutado = true
      detalle.push({ contact: r.contact, accion: "llamada", touch, skip: "dapta apagado" })
    } else if (touch === 2 || touch === 3) {
      // Llamada: se agenda en vic_scheduled_calls y la dispara el
      // vic-callback-cron existente (con todos sus candados: no-llamar,
      // horario del país, flujo por línea). NUNCA Dapta directo desde acá.
      const ins = await supa(`vic_scheduled_calls`, {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          contact: r.contact,
          due_at: new Date().toISOString(),
          payload: { tipo: "loop_v2", motivo: "Toque de llamada del loop", touch },
          status: "pending",
        }),
      }).catch(() => null)
      if (ins && ins.ok) {
        llamadas++
        ejecutado = true
        detalle.push({ contact: r.contact, accion: "llamada", touch })
      } else {
        detalle.push({ contact: r.contact, accion: "llamada", touch, ok: false })
      }
    } else {
      // WhatsApp: la ventana de 24h de Meta decide texto libre vs plantilla.
      const ventanaAbierta = lastUserMs > 0 && now - lastUserMs < 24 * 3600e3
      // Toque 1 con precio = presentación de la ejecutiva (Rodrigo 27-jul).
      // Fuera de ventana cae a la plantilla del stage, como siempre — a las
      // 2h de una cotización la ventana está prácticamente siempre abierta.
      // En CL se presenta al DUEÑO REAL del deal/cotización si existe
      // (tómbola 31-jul); CO/MX conservan su símil fijo (reglas antiguas).
      const esPresentacion = touch === 1 && (stage === "con_precio" || stage === "formal")
      const duenoReal =
        esPresentacion && paisKey === "cl"
          ? (await duenoDealVigente(r.contact).catch(() => null)) ||
            (await duenoCotizacionVigente(r.contact).catch(() => null))
          : null
      const texto = esPresentacion
        ? textoPresentacion(paisKey, duenoReal)
        : TEXTOS[stage][paisKey]
      if (ventanaAbierta) {
        const ok = await sendBotmakerMessage(r.contact, texto, canal).catch(() => false)
        if (ok) {
          await appendAssistantV3(r.contact, texto, country).catch(() => {})
          enviadosTexto++
          ejecutado = true
          detalle.push({ contact: r.contact, accion: "texto", touch, stage })
        } else {
          detalle.push({ contact: r.contact, accion: "texto", touch, ok: false })
        }
      } else {
        const tpl = (LOOP_TPL_MATRIZ[touch] || LOOP_TPL_MATRIZ[7])[stage][paisKey]
        if (!tpl) {
          // Sin plantilla configurada NO se envía nada (patrón del repo). El
          // toque igual avanza para no reintentar el mismo skip en cada tick.
          console.warn(
            `[loop-cron] ${r.contact}: sin plantilla toque ${touch}/${stage}${esCO ? " (CO)" : ""} — omitido`,
          )
          ejecutado = true
          detalle.push({ contact: r.contact, accion: "plantilla", touch, skip: "sin plantilla" })
        } else {
          // NUNCA mandar neutros de relleno. Botmaker no solo sustituye los
          // params en el texto: los ESCRIBE en las variables del contacto. Los
          // "de nuevo" / "tu empresa" que iban acá destruían el dato real —
          // caso verificado el 27-jul: ${nombre} pasó de "alejandro" a "de
          // nuevo" y ${empresa} de "Bar & Restaurant" a "tu empresa", de forma
          // irreversible y para todas las plantillas futuras de ese contacto.
          //
          // Solo se manda lo que sabemos de verdad. Lo que se omite lo resuelve
          // Botmaker con la variable que ya tiene guardada del mensaje de
          // apertura, que es justamente el valor real.
          // Y solo se manda lo que la plantilla DECLARA: un param que su
          // cuerpo no menciona no cambia el texto, pero igual pisa la variable
          // del contacto. Ver VARS_PLANTILLA.
          const empresaReal = (await empresaDeCotizacion(r.contact)) || ""
          // Tercer nivel (28-jul): si una variable declarada no está ni acá ni
          // en el chat de Botmaker, va el fallback — sin él, Meta rebota la
          // plantilla entera ("missing text value") y el toque se pierde.
          const params = await completarParamsConChat(
            r.contact,
            canal,
            tpl,
            paramsParaPlantilla(tpl, { empresa: empresaReal }),
          )

          const ok = await sendBotmakerTemplate(r.contact, tpl, params, canal).catch(() => false)
          if (ok) {
            // El toque queda en el historial como turno de Vicky para que
            // retome con continuidad cuando el cliente responda.
            await appendAssistantV3(r.contact, texto, country).catch(() => {})
            enviadosPlantilla++
            ejecutado = true
            detalle.push({ contact: r.contact, accion: "plantilla", touch, tpl })
          } else {
            detalle.push({ contact: r.contact, accion: "plantilla", touch, tpl, ok: false })
          }
        }
      }
    }

    // Avance del ciclo: solo si el toque se ejecutó (un envío fallido se
    // reintenta al próximo tick, igual que la cadencia outbound). Tras el
    // toque 7 el loop termina.
    if (!ejecutado) continue
    if (touch >= 7) {
      await patchLoop(r.contact, { estado: "finalizado" })
    } else {
      await patchLoop(r.contact, {
        next_touch: touch + 1,
        next_touch_at: calcularProximoToque(t0, touch + 1, country, r.contact).toISOString(),
      })
    }
  }

  return NextResponse.json({
    ok: true,
    procesados,
    enviados_texto: enviadosTexto,
    enviados_plantilla: enviadosPlantilla,
    llamadas,
    pospuestos,
    cerrados,
    detalle,
  })
}

// pg_cron llama con http_post.
export async function POST(req: Request): Promise<Response> {
  return GET(req)
}
