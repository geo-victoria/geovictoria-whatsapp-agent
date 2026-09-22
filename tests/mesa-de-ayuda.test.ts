/**
 * Mesas de Ayuda por país — datos OFICIALES de las tarjetas (Lalo, 27-jul).
 *
 * Antes: Chile daba los canales sin horario ni política; Colombia y México
 * escalaban al correo GENÉRICO soporte@ con un horario inventado (8:30-18:30,
 * que no calza con ninguna de las tres tarjetas). Cada país tiene mesa propia:
 *
 *   CL: WhatsApp +56 9 4401 3873 · 600 914 3819 · soporte@ · L-V 08:30-18:00
 *   CO: soporte.co@ (continuado) · +57 601 508 8941 · L-V 7:30-18:30
 *   MX: soportemx@ (continuado) · +52 33 4160 5435 · L-V 9:00-18:00
 *
 * Y la política común de las tres: solo los ADMINISTRADORES tienen soporte
 * directo — el colaborador va primero con el administrador de su empresa.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const RAIZ = new URL("..", import.meta.url).pathname
const CL = readFileSync(join(RAIZ, "lib/tools/consultar-agente-soporte.ts"), "utf8")
const CO = readFileSync(join(RAIZ, "lib/paises/co/tools.ts"), "utf8")
const MX = readFileSync(join(RAIZ, "lib/paises/mx/tools.ts"), "utf8")

describe("Chile", () => {
  test("canales oficiales con horario y ventana fuera de horario", () => {
    assert.match(CL, /\+56 9 4401 3873/)
    assert.match(CL, /600 914 3819/)
    assert.match(CL, /soporte@geovictoria\.com/)
    assert.match(CL, /lunes a viernes de 08:30 a 18:00/)
    assert.match(CL, /primera hora del día hábil siguiente/)
  })
})

describe("Colombia", () => {
  test("correo propio, teléfono local y su horario real (7:30, no 8:30)", () => {
    assert.match(CO, /soporte\.co@geovictoria\.com/)
    assert.match(CO, /\+57 601 508 8941/)
    assert.match(CO, /lunes a viernes de 7:30 a 18:30/)
  })

  test("el scrub de números chilenos apunta al canal colombiano", () => {
    // Un +56 o el 600 chileno que se cuele en la respuesta del agente de
    // soporte se reemplaza por el canal CO, no por el correo genérico.
    const scrubs = [...CO.matchAll(/soporte\.co@geovictoria\.com"\)/g)]
    assert.ok(scrubs.length >= 2, `los dos reemplazos deben apuntar a soporte.co@ (hay ${scrubs.length})`)
    assert.doesNotMatch(CO, /"soporte@geovictoria\.com"\)/)
  })
})

describe("México", () => {
  test("correo propio soportemx@, teléfono local y su horario real", () => {
    assert.match(MX, /soportemx@geovictoria\.com/)
    assert.match(MX, /\+52 33 4160 5435/)
    assert.match(MX, /lunes a viernes de 9:00 a 18:00/)
    // El genérico ya no aparece en el escalamiento mexicano.
    assert.doesNotMatch(MX, /Email: \*soporte@geovictoria\.com\*/)
  })
})

describe("política común de las tres mesas", () => {
  test("solo administradores: el colaborador va primero con su administrador", () => {
    for (const [pais, src] of [["CL", CL], ["CO", CO], ["MX", MX]] as const) {
      assert.match(
        src,
        /si eres colaborador, el primer paso es contactar al administrador de tu empresa/,
        `falta la política de administradores en ${pais}`,
      )
    }
  })
})
