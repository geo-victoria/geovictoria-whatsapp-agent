/**
 * Dos fallas del 27-jul que comparten raíz: Vicky pierde de vista dónde está
 * parada y qué ya sabe.
 *
 * CASO A (Victor Bravo, Transportes Vibra, +56998216318). Después de acordar
 * que lo llamara un ejecutivo, Vicky cerró con:
 *
 *   "Para que un ejecutivo te contacte, me confirmas tu teléfono?
 *    (ya tengo tu nombre, email y empresa del formulario)"
 *
 * Le pidió el teléfono a alguien que le estaba escribiendo POR TELÉFONO. La
 * regla ya existía en el prompt en dos lugares distintos y el modelo la saltó
 * igual — de ahí que la segunda capa sea determinista.
 *
 * CASO B, mismo cliente: ya tenía precio ($29.060/mes) y solo faltaba el RUT.
 * Al derivar al ejecutivo, Vicky soltó la cotización. El cliente se fue con la
 * duda resuelta y sin cotización, y el ejecutivo parte de cero.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { corregirPedidoDeTelefono, pideTelefono } from "../lib/no-pedir-telefono.ts"

/** El texto exacto que salió a producción. */
const REAL =
  "Para que un ejecutivo te contacte, me confirmas tu teléfono? (ya tengo tu nombre, email y empresa del formulario)"

describe("el detector detecta de verdad", () => {
  // Sanity check: un detector roto deja pasar todo y los tests de abajo
  // aprueban sin que nada esté arreglado (lección del bug de \b en
  // honestidad-entrega, donde el patrón nunca matcheaba).
  test("reconoce el mensaje real que salió a producción", () => {
    assert.equal(pideTelefono(REAL), true)
  })

  for (const frase of [
    "me confirmas tu teléfono?",
    "¿Me das tu número?",
    "me compartes tu celular",
    "¿Cuál es tu teléfono?",
    "Necesito tu número para que te llamen",
    "me falta tu teléfono",
    "¿A qué número te llamamos?",
    "me pasas tu fono",
  ]) {
    test(`reconoce: "${frase}"`, () => {
      assert.equal(pideTelefono(frase), true)
    })
  }

  for (const frase of [
    "Te contactamos a este mismo número, sí?",
    "El reloj se conecta por número de serie",
    "Cuántas personas marcarían asistencia?",
    "Me confirmas el RUT de la empresa?",
    "¿Cuál es tu correo?",
  ]) {
    test(`NO se activa con: "${frase}"`, () => {
      assert.equal(pideTelefono(frase), false)
    })
  }
})

describe("la corrección deja un mensaje que se puede mandar", () => {
  test("el caso real queda sin la pregunta y sin perder el resto", () => {
    const out = corregirPedidoDeTelefono(REAL)
    assert.equal(pideTelefono(out), false)
    assert.match(out, /Para que un ejecutivo te contacte/)
    assert.match(out, /este mismo número de WhatsApp/)
    // El paréntesis con lo que ya sabemos NO se pierde.
    assert.match(out, /ya tengo tu nombre, email y empresa/)
  })

  test("nunca devuelve vacío, aunque el mensaje fuera solo la pregunta", () => {
    const out = corregirPedidoDeTelefono("¿Me confirmas tu teléfono?")
    assert.ok(out.trim().length > 10, `quedó "${out}"`)
    assert.equal(pideTelefono(out), false)
  })

  test("no quedan costuras: dobles espacios, puntos repetidos ni comas sueltas", () => {
    for (const entrada of [REAL, "Genial. ¿Me das tu número? Te llamamos hoy.", "me falta tu celular."]) {
      const out = corregirPedidoDeTelefono(entrada)
      assert.doesNotMatch(out, /\s{2,}/, `doble espacio en "${out}"`)
      assert.doesNotMatch(out, /\.{2,}/, `punto repetido en "${out}"`)
      assert.doesNotMatch(out, /\s[,.;]/, `espacio antes de puntuación en "${out}"`)
    }
  })

  test("un mensaje sin petición pasa intacto", () => {
    const sano = "Perfecto, 3 personas. ¿Con app o con reloj control?"
    assert.equal(corregirPedidoDeTelefono(sano), sano)
  })
})

const RAIZ = new URL("..", import.meta.url).pathname
const PROMPT = readFileSync(join(RAIZ, "app/api/vic-sales-agent-v3/prompt.ts"), "utf8")
const WEBHOOK = readFileSync(join(RAIZ, "app/api/vic-botmaker-v3/route.ts"), "utf8")
const LOOP = readFileSync(join(RAIZ, "app/api/vic-loop-cron/route.ts"), "utf8")

describe("el guardrail está cableado en la salida real", () => {
  test("el webhook lo aplica al reply", () => {
    assert.match(WEBHOOK, /reply = corregirPedidoDeTelefono\(reply\)/)
  })

  test("va DESPUÉS de la honestidad de correo, sobre el texto ya corregido", () => {
    const i = WEBHOOK.indexOf("reply = honestarMencionesDeCorreo(reply)")
    const j = WEBHOOK.indexOf("reply = corregirPedidoDeTelefono(reply)")
    assert.ok(i > 0 && j > i, "el orden de los guardrails cambió")
  })
})

describe("derivar a un ejecutivo no cancela la cotización", () => {
  test("la regla está escrita en el prompt", () => {
    assert.match(PROMPT, /DERIVAR A UN EJECUTIVO NO CANCELA LA COTIZACIÓN/)
    assert.match(PROMPT, /Una cosa no frena la otra/)
  })

  test("y trae el ejemplo de cómo se cierra el turno con las dos puntas", () => {
    assert.match(PROMPT, /le paso tu caso a un ejecutivo/)
    assert.match(PROMPT, /me pasas el RUT de la empresa/)
  })
})

/**
 * CASO C (Ignacia, Tierra del Carmen, +56982716616): recibió el valor completo
 * a las 12:31 y a las 13:35 el loop le preguntó cuántas personas marcarían
 * asistencia y cómo querían marcar. Los dos datos ya los había entregado.
 *
 * La etapa se derivaba de pref_escalon / pref_params, que solo se escriben si
 * hubo negociación de DESCUENTO. cotizar_referencial —el camino normal— no
 * toca ninguno. De 110 conversaciones con precio, 100 eran invisibles.
 */
describe("el loop no le pregunta al cliente algo que ya le respondió", () => {
  test("deriva la etapa del historial, no solo de los punteros", () => {
    assert.match(LOOP, /async function contactosQueVieronPrecio/)
    assert.match(LOOP, /content=like\.\*Total mensual\*/)
  })

  test("'Total mensual' es el marcador, y sirve para los tres países", () => {
    // CL "Total mensual con IVA", CO "Total mensual: $…", MX "Total mensual: … + IVA (16%)".
    assert.match(LOOP, /Total mensual/)
  })

  test("si ya vio precio, la etapa sube a con_precio", () => {
    assert.match(LOOP, /yaVieronPrecio\.has\(r\.contact\)\s*\n?\s*\?\s*"con_precio"/)
  })

  test("una query por batch, no una por contacto", () => {
    assert.match(LOOP, /const yaVieronPrecio = await contactosQueVieronPrecio\(convs\)/)
    const cuerpo = LOOP.slice(LOOP.indexOf("for (const r of rows)"))
    assert.ok(
      !cuerpo.includes("await contactosQueVieronPrecio("),
      "quedó dentro del loop por contacto: son 20 queries por tick",
    )
  })

  test("si la query falla NO se asume que hubo precio", () => {
    // Un fallo silencioso que devolviera 'todos' haría que Vicky hable de una
    // cotización que nunca existió. El default seguro es preguntar de más.
    const fn = LOOP.slice(
      LOOP.indexOf("async function contactosQueVieronPrecio"),
      LOOP.indexOf("function supa("),
    )
    assert.match(fn, /catch[\s\S]*return new Set\(\)/)
    assert.match(fn, /if \(!res\.ok\) return new Set\(\)/)
  })
})
