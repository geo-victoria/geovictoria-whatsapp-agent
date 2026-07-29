/**
 * La venta no se pierde por el precio del RELOJ (Lalo, 29-jul).
 *
 * CASO REAL (+56952187367, 28-jul 21:00): cliente de 1 trabajador quería
 * reloj con huella. Objetó el precio de compra ("en otra parte me sale
 * $214.000, son más de $100.000 de diferencia") y la mensualidad ($8.000 más
 * cara). Vicky mencionó la app gratis DOS veces de pasada — nunca con el
 * número al lado ($12.151/mes total, cero equipo) — y remató con "déjame
 * dejarte el mejor precio posible" SIN ejecutar jamás la escalera de
 * descuentos (pref_escalon quedó null). El cliente se despidió.
 *
 * Las dos reglas que quedan en el prompt CL:
 *   1. Objeción por costo de equipo → cuantificar la opción sin reloj
 *      (marcaje gratis + solo el plan) ANTES de dejar ir al cliente.
 *   2. Prometer "mejor precio" obliga a ejecutar consultar_descuento_
 *      referencial EN ESE MISMO TURNO.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const RAIZ = new URL("..", import.meta.url).pathname
const PROMPT = readFileSync(join(RAIZ, "app/api/vic-sales-agent-v3/prompt.ts"), "utf8")

describe("objeción por costo del equipo", () => {
  test("la regla existe y exige números, no menciones de pasada", () => {
    assert.match(PROMPT, /OBJECIÓN POR COSTO DEL EQUIPO \/ RELOJ/)
    assert.match(PROMPT, /pagando SOLO el plan/)
    assert.match(PROMPT, /cero inversión en equipo/)
  })

  test("con insistencia en reloj: arriendo + verificación de autorización DT", () => {
    assert.match(PROMPT, /ofrece el ARRIENDO como salida/)
    assert.match(PROMPT, /autorización vigente de la Dirección del Trabajo/)
  })

  test("prohibido despedirse por precio de equipo sin agotar la escalera", () => {
    assert.match(PROMPT, /PROHIBIDO despedirse por precio de equipo/)
  })
})

describe("prometer mejor precio obliga a ejecutar la tool en el mismo turno", () => {
  test("la regla nombra la tool y prohíbe la promesa vacía", () => {
    assert.match(PROMPT, /SI PROMETES REVISAR EL PRECIO, LO REVISAS EN ESE MISMO TURNO/)
    assert.match(PROMPT, /consultar_descuento_referencial en ese turno es una promesa vacía/)
  })
})
