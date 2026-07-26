/**
 * Honestidad sobre la entrega de correos.
 *
 * CASOS REALES QUE ORIGINAN ESTE ARCHIVO (revisión de conversaciones, 26-jul):
 *   +56983757162 (22-jul) — Vicky: "la cotización ya fue enviada automáticamente
 *     a admin@simpro.cl cuando la generé. Revisa tu bandeja…" → cliente: "no llegó"
 *   +56922041679 (20-jul) — Vicky: "La cotización ya te llegó al correo
 *     gfuentes@wgservicios.cl cuando la generé." → cliente: "No ha llegado nada"
 *
 * Vicky no podía saberlo. El envío va por send_mail de Zoho y ese registro solo
 * guarda status "sent" — verificado con 5 envíos reales por el stack productivo
 * el 26-jul. No existe "delivered" ni "bounced" en ninguna parte del camino.
 *
 * Lo que protegen estos casos: que Vicky nunca vuelva a asegurarle a un cliente
 * algo que el sistema no sabe, mientras el cliente le dice lo contrario.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import {
  honestarEntregaCorreo,
  corregirDondeBuscar,
  honestarMencionesDeCorreo,
} from "../lib/honestidad-entrega.ts"

// Nada de lo que salga puede afirmar RECEPCIÓN.
// OJO: límites con \p{L}, no \b — "llegó\b" no matchea nunca en JS (la ó no es
// word char ASCII). Con \b este regex daba falsos negativos y el test pasaba
// aunque el texto siguiera afirmando la recepción.
const AFIRMA_RECEPCION = new RegExp(
  "(?<!\\p{L})(?:" +
    "(?:ya\\s+)?(?:te|le|les)\\s+lleg[oó]" +
    "|ya\\s+l[oa]s?\\s+recib(?:iste|i[oó]|ieron)" +
    "|(?:deber[ií]a|debe)\\s+estar\\s+en\\s+tu\\s+(?:bandeja|correo|casilla)" +
    "|ya\\s+est[aá]\\s+en\\s+tu\\s+(?:bandeja|correo|casilla)" +
    "|(?:el\\s+correo|la\\s+cotizaci[oó]n|el\\s+mail)\\s+(?:ya\\s+)?lleg[oó]" +
    ")(?!\\p{L})",
  "iu",
)

// Guarda de cordura: si el propio detector se rompiera (como pasó con \b), los
// tests de abajo pasarían en falso. Esto lo hace fallar en vez de mentir.
test("el detector de afirmaciones realmente detecta", () => {
  for (const frase of [
    "La cotización ya te llegó al correo.",
    "Te llegó la cotización.",
    "Ya la recibiste en tu bandeja.",
    "El correo llegó esta mañana.",
    "Debe estar en tu bandeja de entrada.",
  ]) {
    assert.ok(AFIRMA_RECEPCION.test(frase), `el detector NO vio la afirmación: ${frase}`)
  }
})

describe("los dos casos reales", () => {
  test("caso +56922041679: 'ya te llegó al correo' se degrada a envío", () => {
    const original =
      "Hola Wili! La cotización ya te llegó al correo gfuentes@wgservicios.cl cuando la generé."
    const out = honestarEntregaCorreo(original)
    assert.ok(!AFIRMA_RECEPCION.test(out), `sigue afirmando recepción: ${out}`)
    assert.match(out, /envié/)
    // El dato verdadero (a qué dirección salió) se conserva.
    assert.match(out, /gfuentes@wgservicios\.cl/)
  })

  test("caso +56983757162: 'ya fue enviada' se respeta — eso SÍ es cierto", () => {
    // No hay que corregir de más: enviar es lo que efectivamente hicimos.
    const original =
      "Johanna, la cotización ya fue enviada automáticamente a admin@simpro.cl cuando la generé."
    assert.equal(honestarEntregaCorreo(original), original)
  })
})

describe("afirmaciones de recepción, en todas sus formas", () => {
  test("degrada las variantes que usa el modelo", () => {
    for (const frase of [
      "La cotización ya te llegó al correo.",
      "Ya te llegó a tu correo el PDF.",
      "Te llegó la cotización hace un rato.",
      "Ya la recibiste en tu bandeja.",
      "El correo llegó esta mañana.",
      "Debe estar en tu bandeja de entrada.",
      "Ya está en tu correo.",
    ]) {
      const out = honestarEntregaCorreo(frase)
      assert.ok(!AFIRMA_RECEPCION.test(out), `no se corrigió: ${JSON.stringify(frase)} → ${out}`)
    }
  })

  test("conserva la mayúscula cuando la afirmación abre la frase", () => {
    assert.match(honestarEntregaCorreo("Te llegó la cotización."), /^Te la envié/)
  })

  test("es idempotente: aplicarla dos veces no deforma el texto", () => {
    const una = honestarEntregaCorreo("La cotización ya te llegó al correo.")
    assert.equal(honestarEntregaCorreo(una), una)
  })
})

describe("no toca lo que no debe", () => {
  test("un mensaje comercial normal pasa intacto", () => {
    for (const frase of [
      "El plan mensual queda en 29.163 pesos con IVA incluido.",
      "Te comparto el link para revisar y aceptar la cotización.",
      "Cuántos trabajadores necesitas marcar?",
      "El reloj llegó a nuestras oficinas la semana pasada.",
    ]) {
      assert.equal(honestarEntregaCorreo(frase), frase, `alteró: ${frase}`)
    }
  })

  test("'llegó' referido a cosas que NO son correo no se toca", () => {
    // El despacho del reloj sí es algo que podemos afirmar.
    const frase = "El equipo llegó a la sucursal el martes."
    assert.equal(honestarEntregaCorreo(frase), frase)
  })
})

describe("dónde mandar a buscar el correo", () => {
  test("mandar solo a spam es mandar al lugar equivocado", () => {
    // El correo pasa SPF/DMARC (verificado 26-jul): no cae en spam, cae en
    // Promociones u Otros — que es donde el cliente no mira.
    const out = corregirDondeBuscar("Revisa tu carpeta de spam por si acaso.")
    assert.match(out, /Promociones/)
    assert.match(out, /Otros/)
  })

  test("cubre las formas de decirlo", () => {
    for (const frase of [
      "Revisa spam.",
      "Mira en correo no deseado.",
      "Chequea tu bandeja de spam.",
      "Fíjate en la carpeta de no deseados.",
    ]) {
      assert.match(corregirDondeBuscar(frase), /Promociones/, `no se completó: ${frase}`)
    }
  })

  test("si ya menciona las pestañas, no las duplica", () => {
    const ya = "Revisa spam y también la pestaña Promociones de Gmail."
    assert.equal(corregirDondeBuscar(ya), ya)
  })

  test("no agrega nada donde no se habla de buscar el correo", () => {
    const frase = "El plan incluye soporte y capacitación."
    assert.equal(corregirDondeBuscar(frase), frase)
  })
})

describe("las dos correcciones juntas (lo que corre en la ruta)", () => {
  test("el mensaje real del caso Wili queda honesto y útil", () => {
    const original =
      "Hola Wili! La cotización ya te llegó al correo gfuentes@wgservicios.cl cuando la generé. " +
      "Si no la encuentras, revisa tu carpeta de spam."
    const out = honestarMencionesDeCorreo(original)
    assert.ok(!AFIRMA_RECEPCION.test(out), `sigue afirmando recepción: ${out}`)
    assert.match(out, /envié/)
    assert.match(out, /Promociones/)
    assert.match(out, /Otros/)
  })

  test("respeta el estilo de Vicky", () => {
    const out = honestarMencionesDeCorreo("Ya te llegó al correo. Revisa spam.")
    assert.ok(!/\*/.test(out), "sin negritas")
    assert.ok(!/[¿¡]/.test(out), "sin signos de apertura")
    assert.ok(!/\bOye\b/.test(out))
  })
})
