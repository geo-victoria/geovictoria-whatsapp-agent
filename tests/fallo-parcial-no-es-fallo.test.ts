/**
 * Un paso secundario que falla NO puede reportarse como fallo de todo.
 *
 * CASO QUE ORIGINA ESTE ARCHIVO (27-jul, Andirent +573112895086): el cliente
 * pidió reunión para el martes a las 10:00. Los logs:
 *
 *   [calendar] booking created: nUt9coHsuFkyxVU5gg7ETV status: accepted
 *   [zoho-leads] Error creando Lead: {"code":"INVALID_TOKEN", ...}
 *   [agendar_reunion] createZohoLead falló: Zoho devolvió status 401
 *   [vic-co] ALUCINACION_SIN_TOOL replyOriginal="Listo!! La reunión está
 *            confirmada para mañana, martes 28 de julio, a las 10:00 AM 🎉"
 *
 * La reunión EXISTÍA. Lo que falló fue el papeleo en el CRM. Pero
 * agendar_reunion devolvía ok:false, el guardrail anti-alucinación —que solo
 * mira ese flag— pisaba la respuesta correcta de Vicky, y al cliente se le
 * dijo "tuve un problema técnico y tu reunión quedó pendiente de registro".
 *
 * Es la mentira más cara del sistema: el cliente no se conecta y el KAM se
 * queda esperando en una reunión que sí estaba agendada.
 *
 * La regla que queda: el booking manda. Si existe, ok:true.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const RAIZ = new URL("..", import.meta.url).pathname
const TOOL = readFileSync(join(RAIZ, "lib/tools/agendar-reunion.ts"), "utf8")
const ALERTA = readFileSync(join(RAIZ, "lib/alerta-interna.ts"), "utf8")

describe("agendar_reunion: el booking manda", () => {
  test("el único return con ok:false es cuando Cal.com falla", () => {
    // Se cuentan los RETURN que cortan con ok:false, no las apariciones del
    // texto (el tipo de la unión y los comentarios también lo contienen).
    // Debe quedar exactamente uno: el de bookMeeting. Cualquier otro es un
    // paso de CRM cobrándole al cliente un problema que no es suyo.
    const codigo = TOOL.split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n")
    const cortes = [...codigo.matchAll(/return\s*\{\s*\n?\s*ok:\s*false/g)]
    assert.equal(
      cortes.length,
      1,
      `hay ${cortes.length} returns con ok:false: solo el de Cal.com puede existir`,
    )
    const bloque = TOOL.slice(TOOL.indexOf("if (!booking.success)"), TOOL.indexOf("const { bookingId"))
    assert.match(bloque, /ok: false/, "el ok:false que queda debe ser el de Cal.com")
  })

  test("el fallo del Lead ya no corta: marca crmPendiente y sigue", () => {
    assert.match(TOOL, /crmPendiente = true/)
    const bloque = TOOL.slice(
      TOOL.indexOf("if (!leadResult.success)"),
      TOOL.indexOf("let eventId"),
    )
    assert.doesNotMatch(bloque, /return \{/, "el fallo del Lead volvió a cortar con un return")
  })

  test("el resultado expone crmPendiente para quien quiera actuar", () => {
    assert.match(TOOL, /crmPendiente\?: boolean/)
    assert.match(TOOL, /crmPendiente,\s*\n\s*\}/)
  })

  test("el Event se salta si no hay Lead al que asociarlo", () => {
    // Desde la regla de asignación (27-jul) el gate usa responsableEmail (el
    // dueño de la cotización si existe; el organizador de Cal si no).
    assert.match(TOOL, /if \(responsableEmail && effectiveLeadId\)/)
  })

  test("y el equipo se entera para registrarlo a mano", () => {
    const bloque = TOOL.slice(
      TOOL.indexOf("if (!leadResult.success)"),
      TOOL.indexOf("let eventId"),
    )
    assert.match(bloque, /sendBotmakerMessage\(\s*\n?\s*NOTIFY_TO/)
    assert.match(bloque, /La reunión EXISTE/)
  })

  test("el encabezado documenta la regla, no el comportamiento viejo", () => {
    assert.match(TOOL, /si el booking de Cal\.com existe, la tool devuelve ok:true\. Siempre\./)
    assert.doesNotMatch(TOOL, /pero Lead falla → ok: false/)
  })
})

/**
 * El aviso interno era el respaldo de todos los fallbacks, y era ciego:
 * mandaba TEXTO LIBRE por WhatsApp a un número interno que casi nunca le
 * escribe a Vicky. Fuera de la ventana de 24h, Meta lo descarta en silencio y
 * la función igual devolvía ok. El 27-jul ese número llevaba 47 horas sin
 * escribir: todos los "ya avisé al equipo" del día no llegaron a nadie.
 */
describe("el aviso interno no puede fallar en silencio", () => {
  test("persiste en la base ANTES de intentar el push", () => {
    const i = ALERTA.indexOf("const persistida = await persistirAlerta(texto)")
    const j = ALERTA.indexOf("sendBotmakerMessage(NOTIFY_TO, texto)")
    assert.ok(i > 0 && j > i, "el push quedó antes que la persistencia")
  })

  test("la alerta queda en una tabla consultable, no en un log", () => {
    assert.match(ALERTA, /vic_v3_inbox/)
    assert.match(ALERTA, /CONTACTO_ALERTAS = "equipo:alerta"/)
  })

  test("devuelve si el push salió, en vez de tragárselo", () => {
    assert.match(ALERTA, /export async function avisarEquipoInterno\(texto: string\): Promise<boolean>/)
  })

  test("deja traza de los DOS canales por separado", () => {
    // Si un día nadie ve las alertas, el log tiene que decir si fue el push o
    // la base lo que falló.
    assert.match(ALERTA, /persistida=\$\{persistida\} push=\$\{enviada\}/)
  })

  test("nunca lanza: un aviso roto no puede tumbar el turno del cliente", () => {
    assert.match(ALERTA, /catch \(e\) \{[\s\S]*?return false/)
    assert.match(ALERTA, /\.catch\(\(e\) => \{[\s\S]*?return false/)
  })
})
