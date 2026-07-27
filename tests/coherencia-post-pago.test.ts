/**
 * Coherencia entre lo que Vicky PROMETE al entregar la cotización y lo que el
 * sistema HACE cuando el cliente paga.
 *
 * CASO QUE ORIGINA ESTE ARCHIVO (26-jul): el mensaje de entrega decía
 *
 *   "Con el pago confirmado, yo misma te acompaño con la puesta en marcha"
 *
 * y el traspaso post-pago, minutos después, decía
 *
 *   "De aquí en adelante te acompaña Anderson Díaz, tu ejecutivo comercial,
 *    quien te contactará para coordinar la puesta en marcha"
 *
 * La MISMA frase — "la puesta en marcha" — en los dos mensajes, con sujetos
 * distintos. No fue descuido: son decisiones de fechas distintas (el traspaso
 * a ejecutivo es anterior; "Vicky acompaña post-pago" se definió el 25-jul) que
 * viven en archivos distintos y nunca se cruzaron.
 *
 * Es el mismo patrón que el bug de los correos: dos partes del sistema
 * afirmando cosas incompatibles, y el cliente en el medio. Un eval de un solo
 * archivo no lo puede ver — por eso este compara los DOS.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const RAIZ = new URL("..", import.meta.url).pathname
const PROMPT = readFileSync(join(RAIZ, "app/api/vic-sales-agent-v3/prompt.ts"), "utf8")
const TRASPASO = readFileSync(join(RAIZ, "lib/traspaso-postpago.ts"), "utf8")

describe("lo que Vicky promete vs. lo que pasa al pagar", () => {
  test("el traspaso sigue derivando a un ejecutivo (premisa de este archivo)", () => {
    // Si esto deja de ser cierto —porque se encendió Vicky onboarding para
    // todos y el bloque del ejecutivo desapareció— las reglas de abajo dejan de
    // aplicar y hay que revisarlas, no borrarlas sin pensar.
    assert.match(
      TRASPASO,
      /te acompaña \*\$\{ejecutivo\.nombre\}\*/,
      "el traspaso ya no presenta ejecutivo: revisar si el prompt puede volver a prometer acompañamiento propio",
    )
  })

  test("Vicky NO promete que ella conduce la puesta en marcha", () => {
    // Mientras el traspaso derive al ejecutivo, prometerlo en primera persona
    // es una promesa que el propio sistema desmiente en el mensaje siguiente.
    const enPrimeraPersona =
      /\b(yo misma|yo mismo)\s+te\s+acompañ\w*\s+(con|en)\s+la\s+puesta\s+en\s+marcha/i
    const infractoras = PROMPT.split("\n").filter(
      (l) =>
        enPrimeraPersona.test(l) &&
        // La línea que ENUNCIA la prohibición contiene la frase a propósito.
        !/NUNCA|PROHIBIDO|jam[aá]s|no digas|en vez de/i.test(l),
    )
    assert.deepEqual(
      infractoras.map((l) => l.trim().slice(0, 90)),
      [],
      'el prompt volvió a prometer "yo misma te acompaño con la puesta en marcha"',
    )
  })

  test("pero sigue prometiendo que el cliente no queda solo", () => {
    // Quitar la contradicción no puede convertirse en despedirse: la promesa
    // de acompañamiento es la que sostiene el cierre.
    assert.match(PROMPT, /seguimos contigo en la puesta en marcha/)
  })

  test("y sigue siendo el único contacto ANTES del pago", () => {
    assert.match(PROMPT, /el único contacto eres tú/i)
    assert.match(PROMPT, /me escribes por aquí mismo y lo veo yo/)
  })
})
