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
 * Toques 2-3 son WhatsApp con textos propios desde el 10-ago (las llamadas
 * de Dapta se eliminaron en la demolición de la biblia, 12-ago).
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
  contactosTraspasados,
  loopV2Enabled,
  tzDePais,
  type LoopRow,
  type LoopStage,
} from "@/lib/loop-v2"
import { isTestContact, testContactSet } from "@/lib/funnel-analysis"
import { ptvHabilitado, debeTraspasar } from "@/lib/ptv"
import { duenoDealVigente, duenoCotizacionVigente } from "@/lib/tools/agendar-reunion"
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
const ACEPTADA_CELDA = tplCelda("LOOP_TPL_ACEPTADA", "vicky_loop_pago", "vicky_loop_pago", "vicky_loop_pago")
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
    aceptada: ACEPTADA_CELDA,
  },
  // Toques 2-3 fuera de ventana: plantillas PROPIAS vicky_loop_toque2/3
  // (creadas 12-ago vía API, estado BOTMAKER_PENDING). Mientras Meta no las
  // apruebe, la celda por defecto va VACÍA → skip limpio y la cadencia avanza
  // (celda vacía NO envía — patrón del repo). Antes estas filas NO existían y
  // el fallback caía a la DESPEDIDA del toque 7: caso ROSA 12-ago, "no te
  // escribo más" DOS veces seguidas con el loop aún vivo.
  // vicky_loop_toque2 fue APROBADA por Meta el 13-ago AM → cableada. La del
  // toque 3 sigue ACCOUNT_PENDING: su celda queda vacía y se enciende con
  // LOOP_TPL_T3=vicky_loop_toque3 (o cambiando el default) al aprobarse.
  2: {
    sin_precio: tplCelda("LOOP_TPL_T2", "vicky_loop_toque2"),
    con_precio: tplCelda("LOOP_TPL_T2", "vicky_loop_toque2"),
    formal: tplCelda("LOOP_TPL_T2", "vicky_loop_toque2"),
    aceptada: ACEPTADA_CELDA,
  },
  3: {
    sin_precio: tplCelda("LOOP_TPL_T3", ""),
    con_precio: tplCelda("LOOP_TPL_T3", ""),
    formal: tplCelda("LOOP_TPL_T3", ""),
    aceptada: ACEPTADA_CELDA,
  },
  4: {
    sin_precio: tplCelda("LOOP_TPL_T4_SIN_PRECIO", "vicky_loop_sin_precio", CO_PREFORM, MX_SIN_PRECIO),
    con_precio: tplCelda("LOOP_TPL_T4_CON_PRECIO", "vicky_loop_con_precio", CO_CON_PRECIO, MX_CON_PRECIO),
    formal: tplCelda("LOOP_TPL_T4_FORMAL", "vicky_loop_pago", "vicky_loop_pago", "vicky_loop_pago"),
    aceptada: ACEPTADA_CELDA,
  },
  5: {
    sin_precio: tplCelda("LOOP_TPL_T5_SIN_PRECIO", "vicky_loop_retoma", CO_PREFORM, "vicky_loop_retoma"),
    con_precio: tplCelda("LOOP_TPL_T5_CON_PRECIO", "vicky_loop_retoma_rut", CO_CON_PRECIO, MX_CON_PRECIO),
    formal: tplCelda("LOOP_TPL_T5_FORMAL", "vicky_loop_pago", "vicky_loop_pago", "vicky_loop_pago"),
    aceptada: ACEPTADA_CELDA,
  },
  6: { sin_precio: LOOP_TPL_T6, con_precio: LOOP_TPL_T6, formal: LOOP_TPL_T6, aceptada: ACEPTADA_CELDA },
  7: { sin_precio: LOOP_TPL_T7, con_precio: LOOP_TPL_T7, formal: LOOP_TPL_T7, aceptada: ACEPTADA_CELDA },
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
  // Toque 5 personalizado fuera de ventana (26-ago): nombre lo resuelve el
  // chat de Botmaker; contexto viene generado por conversación.
  campana_contexto_vicky_p1_v2: ["nombre", "contexto"],
  vicky_loop_sin_precio: [],
  vicky_loop_con_precio: [],
  vicky_loop_con_precio_co: [],
  vicky_loop_con_precio_mx: [],
  vicky_loop_pago: ["nombre"],
  vicky_loop_retoma: ["nombre"],
  vicky_loop_retoma_rut: ["nombre"],
  vicky_loop_despedida: ["nombre"],
  vicky_loop_toque2: ["nombre"],
  vicky_loop_toque3: ["nombre"],
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
// Textos de los toques 2 (+60 min) y 3 (+22 h) — cadencia Rodrigo 10-ago.
// Distintos del toque 1 a propósito: tres toques en 24 horas con el MISMO
// texto se leen como robot (regla anti-repetición del 09-ago).
const TEXTOS_T2: Record<LoopStage, { cl: string; co: string; mx: string }> = {
  sin_precio: {
    cl: "¿Retomamos tu cotización? Me faltaba solo un dato para dejarte el valor — me lo confirmas y te lo mando enseguida 😊",
    co: "Retomamos tu cotización? Me faltaba solo un dato para dejarte el valor — me lo confirmas y te lo mando de una 😊",
    mx: "¿Retomamos tu cotización? Me faltaba solo un dato para dejarte el valor — me lo confirmas y te lo mando enseguida 😊",
  },
  con_precio: {
    cl: "¿Qué te pareció el valor que te pasé? Si te acomoda, te dejo la cotización formal lista en un minuto — y si algo no te convence, lo ajustamos 😊",
    co: "Qué te pareció el valor que te pasé? Si te sirve, te dejo la cotización formal lista en un minuto — y si algo no te convence, lo ajustamos 😊",
    mx: "¿Qué te pareció el valor que te pasé? Si te acomoda, te dejo la cotización formal lista en un minuto — y si algo no te convence, lo ajustamos 😊",
  },
  formal: {
    cl: "¿Pudiste revisar tu cotización? Cualquier duda o ajuste me dices por aquí — y si quieres avanzar, en el mismo link la aceptas y pagas 😊",
    co: "Pudiste revisar tu cotización? Cualquier duda o ajuste me dices por aquí — y si quieres avanzar, en el mismo link la aceptas y pagas 😊",
    mx: "¿Pudiste revisar tu cotización? Cualquier duda o ajuste me dices por aquí — y si quieres avanzar, en el mismo link la aceptas y pagas 😊",
  },
  aceptada: {
    cl: "¿Pudiste avanzar con el pago? Si algo te complica — tarjeta, transferencia o una duda del plan — lo vemos por aquí, o te contacto con un ejecutivo y lo cierran juntos. Recuerda que pagando activamos tu cuenta de inmediato por este mismo chat, sin trámites extra. El link: {LINK_PAGO}",
    co: "¿Pudiste avanzar con el pago? Si algo te complica — tarjeta, transferencia o una duda del plan — lo vemos por aquí, o te contacto con un ejecutivo y lo cierran juntos. Recuerda que pagando activamos tu cuenta de una por este mismo chat, sin trámites extra. El link: {LINK_PAGO}",
    mx: "¿Pudiste avanzar con el pago? Si algo te complica — tarjeta, transferencia o una duda del plan — lo vemos por aquí, o te contacto con un ejecutivo y lo cierran juntos. Recuerda que pagando activamos tu cuenta de inmediato por este mismo chat, sin trámites extra. El link: {LINK_PAGO}",
  },
}
const TEXTOS_T3: Record<LoopStage, { cl: string; co: string; mx: string }> = {
  sin_precio: {
    cl: "Ayer quedamos a mitad de camino con tu cotización — ¿la retomamos? Con un par de datos te dejo el valor de inmediato 😊",
    co: "Ayer quedamos a mitad de camino con tu cotización — la retomamos? Con un par de datos te dejo el valor de una 😊",
    mx: "Ayer quedamos a mitad de camino con tu cotización — ¿la retomamos? Con un par de datos te dejo el valor de inmediato 😊",
  },
  con_precio: {
    cl: "Te escribo para retomar lo de ayer: el valor que te pasé sigue vigente. ¿Avanzamos con la cotización formal o prefieres ajustar algo primero?",
    co: "Te escribo para retomar lo de ayer: el valor que te pasé sigue vigente. Avanzamos con la cotización formal o prefieres ajustar algo primero?",
    mx: "Te escribo para retomar lo de ayer: el valor que te pasé sigue vigente. ¿Avanzamos con la cotización formal o prefieres ajustar algo primero?",
  },
  formal: {
    cl: "Tu cotización sigue vigente 😊 ¿Te ayudo a resolver alguna duda o a completar el pago? Cualquier ajuste también lo hacemos por aquí.",
    co: "Tu cotización sigue vigente 😊 Te ayudo a resolver alguna duda o a completar el pago? Cualquier ajuste también lo hacemos por aquí.",
    mx: "Tu cotización sigue vigente 😊 ¿Te ayudo a resolver alguna duda o a completar el pago? Cualquier ajuste también lo hacemos por aquí.",
  },
  aceptada: {
    cl: "Te aviso para que no se te pase: tu cotización está vigente hasta el {VIGENCIA} con el precio tomado a la UF del día — vencida habría que recotizar. Si la dejamos lista hoy, hoy mismo parto con la activación de tu cuenta por este chat: {LINK_PAGO}",
    co: "Te aviso para que no se te pase: tu cotización está vigente hasta el {VIGENCIA} con el precio del día congelado — vencida habría que recotizar. Si la dejamos lista hoy, hoy mismo arrancamos con la activación de tu cuenta por este chat: {LINK_PAGO}",
    mx: "Te aviso para que no se te pase: tu cotización está vigente hasta el {VIGENCIA} con el precio del día congelado — vencida habría que recotizar. Si la dejamos lista hoy, hoy mismo arrancamos con la activación de tu cuenta por este chat: {LINK_PAGO}",
  },
}

const TEXTOS: Record<LoopStage, { cl: string; co: string; mx: string }> = {
  // REGLA DE ORO (biblia, caso 12-ago +56945820380): Vicky se presenta UNA
  // sola vez por conversación — el t1 cae a los 10 minutos DENTRO de una
  // conversación viva, así que entra directo al tema, sin "Soy Vicky".
  sin_precio: {
    cl:
      "Para armarte el valor de inmediato solo me falta saber cuántas personas marcarían asistencia y cómo les gustaría marcar (app, huella o reconocimiento facial).\n¿Me cuentas y lo dejamos listo?",
    co:
      "Para armarte el valor de una solo necesito saber cuántas personas marcarían asistencia y cómo les gustaría marcar (app, huella o reconocimiento facial).\nMe cuentas y lo dejamos listo?",
    mx:
      "Para armarte el valor de inmediato solo me falta saber cuántas personas registrarían su asistencia y cómo les gustaría checar (app, huella o reconocimiento facial).\n¿Me cuentas y lo dejamos listo?",
  },
  con_precio: {
    cl:
      "Tu valor ya está listo — solo me falta el RUT (o tu ok) para dejarte la cotización formal.\n¿Avanzamos?",
    co:
      "Tu valor ya está listo — solo me falta el NIT (o tu ok) para dejarte la cotización formal.\nLa armamos de una?",
    mx:
      "Tu valor ya está listo — solo me falta el RFC (o tu ok) para dejarte la cotización formal.\n¿Avanzamos?",
  },
  formal: {
    cl:
      "Tu cotización quedó lista y la puedes aceptar y pagar en línea cuando quieras.\nSi te quedó alguna duda, la vemos enseguida por acá.",
    co:
      "Tu cotización quedó lista y la puedes aceptar y pagar en línea cuando quieras.\nSi te queda alguna duda, la resolvemos de una por acá.",
    mx:
      "Tu cotización quedó lista y la puedes aceptar cuando gustes.\nSi te quedó alguna duda, la resolvemos por aquí.",
  },
  aceptada: {
    // Propuesta de valor de INMEDIATEZ (Lalo 25-ago): pagado el plan, la
    // activación parte al tiro por este mismo chat — ese es el argumento de
    // cierre, no presión falsa (principio central 25-jul).
    cl: "Vi que aceptaste tu cotización ✅ ¿Te ayudo a dejar el pago listo? En este mismo link lo haces en un minuto:\n{LINK_PAGO}\nApenas quede el pago partimos al tiro con la activación de tu cuenta por este mismo chat — sin esperar a nadie. Y si prefieres transferencia, me dices y te paso los datos 😊",
    co: "Vi que aceptaste tu cotización ✅ ¿Te ayudo a dejar el pago listo? En este mismo link lo haces en un minuto:\n{LINK_PAGO}\nApenas quede el pago arrancamos de una con la activación de tu cuenta por este mismo chat — sin esperar a nadie. Y si prefieres transferencia, me dices y te paso los datos 😊",
    mx: "Vi que aceptaste tu cotización ✅ ¿Te ayudo a dejar el pago listo? En este mismo link lo haces en un minuto:\n{LINK_PAGO}\nEn cuanto quede el pago arrancamos enseguida con la activación de tu cuenta por este mismo chat — sin esperar a nadie. Y si prefieres transferencia, me dices y te paso los datos 😊",
  },
}

// Toques 4-7 dentro de ventana: textos PROPIOS (biblia F3) — antes reusaban
// el texto del t1 y la regla anti-repetición quedaba rota en la cola larga.
const TEXTOS_T4PLUS: Record<LoopStage, { cl: string; co: string; mx: string }> = {
  sin_precio: {
    cl: "Sigo disponible para dejarte el valor cuando quieras — me dices cuántas personas marcarían y lo armo en un minuto 😊",
    co: "Sigo disponible para dejarte el valor cuando quieras — me dices cuántas personas marcarían y lo armo en un minuto 😊",
    mx: "Sigo disponible para dejarte el valor cuando gustes — me dices cuántas personas checarían y lo armo en un minuto 😊",
  },
  con_precio: {
    cl: "El valor que te preparé sigue disponible — si quieres lo dejamos en cotización formal, o lo ajusto a lo que necesites 😊",
    co: "El valor que te preparé sigue disponible — si quieres lo dejamos en cotización formal, o lo ajusto a lo que necesites 😊",
    mx: "El valor que te preparé sigue disponible — si gustas lo dejamos en cotización formal, o lo ajusto a lo que necesites 😊",
  },
  formal: {
    cl: "Tu cotización sigue disponible para aceptar y pagar en línea — y si algo cambió en lo que necesitas, la ajustamos por aquí 😊",
    co: "Tu cotización sigue disponible para aceptar y pagar en línea — y si algo cambió en lo que necesitas, la ajustamos por aquí 😊",
    mx: "Tu cotización sigue disponible para aceptar en línea — y si algo cambió en lo que necesitas, la ajustamos por aquí 😊",
  },
  aceptada: {
    cl: "Te aviso para que no se te pase: tu cotización está vigente hasta el {VIGENCIA} con el precio tomado a la UF del día — vencida habría que recotizar. Si la dejamos lista hoy, hoy mismo parto con la activación de tu cuenta por este chat: {LINK_PAGO}",
    co: "Te aviso para que no se te pase: tu cotización está vigente hasta el {VIGENCIA} con el precio del día congelado — vencida habría que recotizar. Si la dejamos lista hoy, hoy mismo arrancamos con la activación de tu cuenta por este chat: {LINK_PAGO}",
    mx: "Te aviso para que no se te pase: tu cotización está vigente hasta el {VIGENCIA} con el precio del día congelado — vencida habría que recotizar. Si la dejamos lista hoy, hoy mismo arrancamos con la activación de tu cuenta por este chat: {LINK_PAGO}",
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

/** Registro durable de cada toque ENVIADO (punto 4, Lalo 08-ago): fila
 * vic_kv `tqlog_<ts>_<contact>` con plantilla/texto, toque y etapa, TTL 15
 * días. El panel "Respuesta por plantilla" del dashboard agrega sobre esto
 * cuáles toques generan respuesta del cliente y cuáles queman contactos. */
async function logToque(contact: string, tpl: string, touch: number, stage: string, pais: string): Promise<void> {
  await supa(`vic_kv?on_conflict=key`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      key: `tqlog_${Date.now()}_${contact}`,
      value: JSON.stringify({ c: contact, tpl, touch, stage, pais, at: new Date().toISOString() }),
      expires_at: new Date(Date.now() + 15 * 24 * 3600e3).toISOString(),
    }),
  }).catch(() => undefined)
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
    {
      const { estamparLatido } = await import("@/lib/latido")
      await estamparLatido("loop").catch(() => undefined)
    }
    return NextResponse.json({ ok: true, skipped: "flag off" })
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return NextResponse.json({ ok: false, error: "Supabase no configurado" }, { status: 503 })
  }

  // Candado de turno (barrido acelerado 10-ago): este cron ahora lo disparan
  // DOS agendas (la externa de siempre + vic-callback-cron cada 2 min). Dos
  // ticks solapados leerían las mismas filas vencidas y el cliente recibiría
  // el MISMO toque dos veces. El que no toma el candado se retira limpio.
  const { reclamarTurno, liberarTurno } = await import("@/lib/cron-lock")
  if (!(await reclamarTurno("loop"))) {
    return NextResponse.json({ ok: true, skipped: "otro tick en curso" })
  }
  try {

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
    const { estamparLatido } = await import("@/lib/latido")
    await estamparLatido("loop").catch(() => undefined)
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

  // Contactos traspasados Y ATENDIDOS DE VERDAD por el vendedor (candado v3,
  // Lalo 07-ago). El cron del PTV cierra el loop al traspasar, pero los
  // traspasos que NO pasan por él (p. ej. los `presentacion_manual` del
  // 31-jul) dejaban la fila viva y el toque de presentación salía con la
  // ejecutiva FIJA del país: el prospecto recibía DOS nombres distintos (caso
  // Alan/vaitiare: Ana Paula 11:21, Eddyluz 18:00).
  //
  // OJO — bug encontrado el 10-ago (auditoría de toques 27-jul→10-ago): acá se
  // leía `vic_ptv?estado=eq.activo` CRUDO, o sea el candado CLÁSICO: bastaba
  // el traspaso para callar a Vicky. Eso peleaba con la reconciliación del
  // candado v3 (`reconciliarSilencioTraspasos`, cada 10' en vic-ptv-cron): ella
  // reabría el loop del cliente que el vendedor nunca contactó y este cron lo
  // volvía a cerrar minutos después. Resultado neto: 56 conversaciones
  // traspasadas sin UN solo toque, 35 de ellas con cotización formal viva.
  // `contactosTraspasados()` aplica la regla correcta: silencio solo con
  // contacto humano REAL (mensaje del vendedor por su WhatsApp espejado o
  // llamada contestada) posterior al traspaso — y respeta el rollback
  // VICKY_PTV_CANDADO_CLASICO=1.
  const ptvActivos = await contactosTraspasados(rows.map((r) => r.contact)).catch(
    () => new Set<string>(),
  )

  // Contactos en fase ONBOARDING (Lalo 25-ago): cliente creando su cuenta con
  // Vicky Onboarding — la venta ya cerró, el loop comercial muere. Una sola
  // query batch sobre vic_kv (fase_vicky_<fono> = "onboarding").
  const enOnboarding = new Set<string>()
  try {
    const fasesIn = rows.map((r) => `"fase_vicky_${r.contact}"`).join(",")
    const fasesRes = await supa(`vic_kv?key=in.(${fasesIn})&select=key,value`)
    for (const f of (fasesRes.ok ? await fasesRes.json().catch(() => []) : []) as Array<{
      key?: string
      value?: string
    }>) {
      if (String(f.value || "").trim() === "onboarding") {
        enOnboarding.add(String(f.key || "").replace(/^fase_vicky_/, ""))
      }
    }
  } catch {
    /* best-effort: sin la señal, el toque de un onboarding se atrapa al tick siguiente */
  }

  // Mapa RAW de traspasos ACTIVOS (contact → traspasado_at). Distinto del set
  // de arriba: aquel es "traspasado Y atendido" (cierra el loop); este es
  // "traspasado a secas", y lo necesita el anti-empalme de abajo — un
  // traspaso que YA ocurrió no puede seguir posponiendo toques (hallazgo
  // 10-ago, prueba de Lalo: la proyección post-formal da "traspasar" para
  // SIEMPRE con el cliente en silencio, así que el toque se corría de hora
  // en hora y el acompañamiento del candado v3 nunca partía).
  const traspasoRes = await supa(`vic_ptv?estado=eq.activo&select=contact,traspasado_at&limit=1000`)
  const traspasadoAtDe = new Map<string, number>()
  for (const p of (traspasoRes.ok ? await traspasoRes.json().catch(() => []) : []) as Array<{
    contact: string
    traspasado_at?: string
  }>) {
    const ms = Date.parse(p.traspasado_at || "")
    if (p.contact && Number.isFinite(ms)) traspasadoAtDe.set(p.contact, ms)
  }

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

    // (a-0b) Fase ONBOARDING (Lalo 25-ago): el cliente está creando su cuenta
    // con Vicky Onboarding — el flujo comercial no se le cruza nunca más.
    if (enOnboarding.has(r.contact)) {
      await patchLoop(r.contact, { estado: "cerrado", motivo_cierre: "onboarding" })
      cerrados++
      detalle.push({ contact: r.contact, accion: "cerrado", motivo: "onboarding" })
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

    // (c-bis) GATE DE VENTANA AL EJECUTAR (fix 25-jul; ventana ampliada 09-ago
    // a TODOS los días 9-21, Rodrigo: el finde también se hace seguimiento):
    // una fila con next_touch_at vencido (migración vieja, cron detenido) NO
    // puede disparar un toque a las 23:00 — si AHORA está fuera de la ventana,
    // el toque se pospone al próximo bloque. ajustarAHabil devuelve el mismo
    // instante cuando ya estamos dentro.
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
    //
    // PERO solo aplica a traspasos FUTUROS (corrección 10-ago): con el
    // traspaso YA disparado, la presentación ya salió y no hay empalme
    // posible. Ahí manda el candado v3: 20 minutos de ventana para que el
    // vendedor contacte y después el toque FLUYE — si el vendedor atendió,
    // este loop ni llega acá (el paso a-0 lo cerró por atención real).
    //
    // Y el TOQUE 1 quedó EXENTO de la proyección (orden de Lalo 10-ago:
    // "resucita el toque a los 10 minutos en horario hábil"): antes el
    // anti-empalme lo posponía SIEMPRE en hábil (con precio dado, la
    // proyección a +1h da "traspasar" sin excepción) y el primer contacto
    // era la presentación de los 15'. Hoy el toque 1 no presenta a nadie
    // (esPresentacion=false desde la mañana), así que puede convivir con la
    // presentación 5 minutos después sin revivir el bug de los dos nombres
    // (Alan/vaitiare). El anti-empalme sigue vivo para los toques 2+.
    const traspasadoMs = traspasadoAtDe.get(r.contact)
    if (traspasadoMs) {
      const ventanaVendedor = traspasadoMs + 20 * 60e3
      if (now < ventanaVendedor) {
        await patchLoop(r.contact, { next_touch_at: new Date(ventanaVendedor + 60e3).toISOString() })
        pospuestos++
        detalle.push({ contact: r.contact, accion: "pospuesto_ventana_vendedor", touch })
        continue
      }
      // ≥20 min traspasado y sin atención: el toque sale (candado v3).
    } else if (ptvHabilitado() && lastUserMs > 0 && touch !== 1) {
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

    // Primer toque SIEMPRE a los 10 minutos, independiente de la etapa
    // (Rodrigo 10-ago — reemplaza el 35' de la formal y las 2h antiguas):
    // el cliente que acaba de conversar está caliente AHORA.
    if (touch === 1 && (stage === "con_precio" || stage === "formal")) {
      const espera = 10 * 60e3
      const objetivo = new Date(new Date(t0).getTime() + espera)
      if (now < objetivo.getTime()) {
        const habil = ajustarAHabil(objetivo, tzDePais(country), r.contact)
        await patchLoop(r.contact, { next_touch_at: habil.toISOString() })
        pospuestos++
        detalle.push({ contact: r.contact, accion: "pospuesto_10m", hasta: habil.toISOString() })
        continue
      }
    }

    // Toques 2-3: eran LLAMADAS (Dapta, muerto por decisión del 08-ago y sin
    // volver). Desde el 10-ago son WhatsApp con textos propios — la cadencia
    // nueva de Rodrigo (10' / +60' / +22h) necesita que el cliente RECIBA
    // algo en cada toque, no un hueco mudo.
    {
      // WhatsApp: la ventana de 24h de Meta decide texto libre vs plantilla.
      const ventanaAbierta = lastUserMs > 0 && now - lastUserMs < 24 * 3600e3
      // Toque 1 con precio = presentación de la ejecutiva (Rodrigo 27-jul).
      // Fuera de ventana cae a la plantilla del stage, como siempre — a las
      // 2h de una cotización la ventana está prácticamente siempre abierta.
      // En CL se presenta al DUEÑO REAL del deal/cotización si existe
      // (tómbola 31-jul); CO/MX conservan su símil fijo (reglas antiguas).
      // Presentación del loop APAGADA (10-ago): con el primer toque a los 10
      // minutos en TODAS las etapas, cualquier presentación aquí chocaría con
      // la del traspaso de los 15' (dos nombres en 5 minutos — bug
      // Alan/vaitiare). Los nombres los pone SOLO el traspaso. La maquinaria
      // (textoPresentacion/dueño real) queda dormida por si vuelve.
      const esPresentacion = false as boolean
      const duenoReal =
        esPresentacion && paisKey === "cl"
          ? (await duenoDealVigente(r.contact).catch(() => null)) ||
            (await duenoCotizacionVigente(r.contact).catch(() => null))
          : null
      const texto = esPresentacion
        ? textoPresentacion(paisKey, duenoReal)
        : touch === 2
          ? TEXTOS_T2[stage][paisKey]
          : touch === 3
            ? TEXTOS_T3[stage][paisKey]
            : touch >= 4
              ? TEXTOS_T4PLUS[stage][paisKey]
              : TEXTOS[stage][paisKey]
      // TOQUE 5 PERSONALIZADO (Rodrigo/Lalo 26-ago, doc v21 — solo CL, etapas
      // de venta): texto libre generado con el dolor del cliente y la etapa
      // donde quedó. Si la generación falla, `contextoT5` queda null y todo
      // sigue por el camino fijo de siempre.
      let contextoT5: string | null = null
      if (touch === 5 && paisKey === "cl" && !esPresentacion && stage !== "aceptada") {
        const { generarToqueContexto } = await import("@/lib/toque-contexto")
        contextoT5 = await generarToqueContexto(r.contact, stage).catch(() => null)
        if (contextoT5) console.log(`[loop-cron] t5 personalizado ${r.contact} (${contextoT5.length} chars)`)
      }
      // Etapa ACEPTADA (25-ago): los textos llevan el link real de la
      // cotización y, en el toque de urgencia, la fecha de vigencia (emisión
      // + 30 días). Sin puntero no se inventa nada: el toque se salta limpio.
      let textoFinal = texto
      if (stage === "aceptada") {
        const { getQuotePointer } = await import("@/lib/supabase-persistence-v3")
        const puntero = await getQuotePointer(r.contact).catch(() => null)
        if (!puntero?.acceptanceUrl) {
          console.warn(`[loop-cron] ${r.contact}: etapa aceptada sin puntero de cotización — toque omitido`)
          ejecutado = true
          detalle.push({ contact: r.contact, accion: "aceptada", touch, skip: "sin puntero" })
          continue
        }
        const emitida = Date.parse(puntero.updatedAt || "")
        const vigencia = Number.isFinite(emitida)
          ? new Date(emitida + 30 * 86400e3).toLocaleDateString("es-CL", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "America/Santiago" })
          : "vencimiento próximo"
        textoFinal = texto.replaceAll("{LINK_PAGO}", puntero.acceptanceUrl).replaceAll("{VIGENCIA}", vigencia)
      }
      if (ventanaAbierta) {
        // T5 personalizado = el MISMO mix de la campaña (Lalo 26-ago): marco
        // fijo + contexto libre al medio — dentro de ventana se arma acá; fuera
        // de ventana lo arma la plantilla con la variable ${contexto}.
        const cuerpo = contextoT5
          ? `Hola, todo bien? ${contextoT5}\n\nTe escribo porque quería retomar lo que quedó pendiente.`
          : textoFinal
        const ok = await sendBotmakerMessage(r.contact, cuerpo, canal).catch(() => false)
        if (ok) {
          await appendAssistantV3(r.contact, cuerpo, country).catch(() => {})
          void logToque(r.contact, contextoT5 ? "texto_t5_contexto" : `texto_${stage}`, touch, stage, paisKey)
          enviadosTexto++
          ejecutado = true
          detalle.push({ contact: r.contact, accion: contextoT5 ? "texto_contexto" : "texto", touch, stage })
        } else {
          detalle.push({ contact: r.contact, accion: "texto", touch, ok: false })
        }
      } else if (contextoT5) {
        // Fuera de ventana el contexto viaja como variable de la plantilla de
        // retome (misma mecánica probada en vivo con la campaña del 10% hoy):
        // el texto fijo de la plantilla enmarca y `${contexto}` personaliza.
        const { contextoParaPlantilla } = await import("@/lib/toque-contexto")
        const tplCtx = (process.env.LOOP_TPL_T5_CONTEXTO || "campana_contexto_vicky_p1_v2").trim()
        const params = await completarParamsConChat(r.contact, canal, tplCtx, {
          contexto: contextoParaPlantilla(contextoT5),
        })
        const ok = await sendBotmakerTemplate(r.contact, tplCtx, params, canal).catch(() => false)
        if (ok) {
          await appendAssistantV3(
            r.contact,
            `${contextoT5}\nTe escribo porque quería retomar lo que quedó pendiente.`,
            country,
          ).catch(() => {})
          void logToque(r.contact, tplCtx, touch, stage, paisKey)
          enviadosPlantilla++
          ejecutado = true
          detalle.push({ contact: r.contact, accion: "plantilla_contexto", touch, tpl: tplCtx })
        } else {
          detalle.push({ contact: r.contact, accion: "plantilla_contexto", touch, tpl: tplCtx, ok: false })
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
            void logToque(r.contact, tpl, touch, stage, paisKey)
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
    // Cadencia de cierre post-aceptación: 3 toques y a la Cartera (motivo
    // propio para que el cobro asistido la encuentre de una).
    if (stage === "aceptada" && touch >= 3) {
      await patchLoop(r.contact, { estado: "finalizado", motivo_cierre: "aceptada_sin_pago" })
      cerrados++
      detalle.push({ contact: r.contact, accion: "finalizado", motivo: "aceptada_sin_pago" })
      continue
    }
    if (touch >= 7) {
      await patchLoop(r.contact, { estado: "finalizado" })
    } else {
      // TOPE DE ATRASO (biblia F3, caso ROSA 12-ago): los relojes se calculan
      // desde T0, así que un loop que despierta tarde (posposición de 48h,
      // caída del cron) tenía TODOS los toques vencidos y el barrido de 2 min
      // drenaba la cadencia completa — 3 toques en 3 minutos. Regla nueva: si
      // el reloj del siguiente toque ya venció, se reprograma al FUTURO con el
      // espaciado NATURAL entre ambos toques (mínimo 30 min) — jamás se
      // "reponen" toques atrasados de golpe.
      const ntBase = calcularProximoToque(t0, touch + 1, country, r.contact)
      const toqueActualAt = calcularProximoToque(t0, touch, country, r.contact)
      const gapMs = Math.max(ntBase.getTime() - toqueActualAt.getTime(), 30 * 60e3)
      const nt = ntBase.getTime() > Date.now() ? ntBase : new Date(Date.now() + gapMs)
      await patchLoop(r.contact, {
        next_touch: touch + 1,
        next_touch_at: nt.toISOString(),
      })
    }
  }

  // VIGÍA DE CERO TRASPASOS (10-ago, autopsia del viernes 08-ago): el PTV
  // corrió TODO ese día hábil respondiendo 200 y no traspasó a NADIE (¿flag
  // apagado?), y nadie se enteró hasta el lunes — la Fundación Amigos de
  // Jesús y Residencia San Sebastián se perdieron ahí. Este cron es
  // independiente del flag del PTV, así que puede acusarlo: día hábil CL
  // pasado el mediodía y ni UN traspaso en vic_ptv hoy → alerta interna,
  // una sola vez por día (marca vic_kv).
  try {
    const tz = "America/Santiago"
    const ahoraCl = new Date()
    const diaCl = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(ahoraCl)
    const horaCl =
      Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(ahoraCl)) % 24
    if (diaCl !== "Sat" && diaCl !== "Sun" && horaCl >= 12 && horaCl < 18) {
      const fechaCl = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(ahoraCl)
      const marca = `alerta_cero_traspasos_${fechaCl}`
      const { getKvValue, setKvValue } = await import("@/lib/supabase-persistence-v3")
      if (!(await getKvValue(marca).catch(() => "ya"))) {
        const desdeHoy = new Date(`${fechaCl}T04:00:00Z`).toISOString()
        const res = await supa(
          `vic_ptv?traspasado_at=gte.${encodeURIComponent(desdeHoy)}&select=id&limit=1`,
        )
        const filas = res.ok ? ((await res.json().catch(() => [])) as unknown[]) : ["asumo-ok"]
        if (!filas.length) {
          const { avisarEquipoInterno } = await import("@/lib/alerta-interna")
          await avisarEquipoInterno(
            `⚠️ CERO traspasos hoy siendo día hábil (van ${horaCl}:00 en Chile). ` +
              `El viernes 08-ago pasó exactamente esto y se perdió el día completo. ` +
              `Revisar VICKY_PTV_ENABLED, vic_kv traspaso_v2_enabled y los logs de vic-ptv-cron.`,
          ).catch(() => false)
          await setKvValue(marca, new Date().toISOString()).catch(() => {})
        }
      }
    }
  } catch {
    /* vigía best-effort: jamás tumba el tick */
  }

  // Latido (Lalo 08-ago): tick exitoso queda estampado; este cron vigila a los demás.
  {
    const { estamparLatido, vigilarLatidos } = await import("@/lib/latido")
    await estamparLatido("loop").catch(() => undefined)
    await vigilarLatidos("loop").catch(() => undefined)
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
  } finally {
    await liberarTurno("loop").catch(() => undefined)
  }
}

// pg_cron llama con http_post.
export async function POST(req: Request): Promise<Response> {
  return GET(req)
}
