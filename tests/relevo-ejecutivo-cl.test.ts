/**
 * RELEVO DE EJECUTIVO CL (Lalo, 27-jul): todo lo NUEVO va a Eddyluz Mujica;
 * lo ya asignado queda con Anderson Díaz. Cero cambios retroactivos.
 *
 * La consecuencia sutil que estos tests fijan: "el ejecutivo de Chile" dejó
 * de ser un nombre — es una función de CADA cotización. Cualquier código que
 * presente un ejecutivo al cliente por una cotización existente debe resolver
 * el Owner real (lib/zoho-quote-owner.ts) y no asumir un hardcode, porque
 * durante la transición conviven deals de los dos.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const RAIZ = new URL("..", import.meta.url).pathname
const leer = (p: string) => readFileSync(join(RAIZ, p), "utf8")

const PERFIL = leer("lib/paises/cl/index.ts")
const TRASPASO = leer("lib/traspaso-postpago.ts")
const CALLBACK = leer("lib/tools/registrar-solicitud-callback.ts")
const LOOP = leer("lib/agent-loop.ts")
const GENERAR = leer("lib/tools/generar-link-cotizadora.ts")
const FUNNEL = leer("lib/funnel-analysis.ts")

describe("lo nuevo va a Eddyluz", () => {
  test("el perfil CL presenta a Eddyluz con sus datos reales", () => {
    assert.match(PERFIL, /nombre: "Eddyluz Mujica"/)
    assert.match(PERFIL, /email: "emujica@geovictoria\.com"/)
    assert.match(PERFIL, /telefono: "\+56 9 3932 1687"/)
    assert.doesNotMatch(PERFIL, /Anderson Díaz"/)
  })

  test("el fallback de cotización del callback asigna a Eddyluz", () => {
    assert.match(CALLBACK, /\|\| "emujica@geovictoria\.com"/)
    assert.doesNotMatch(CALLBACK, /adiazg@geovictoria\.com/)
  })

  test("el display de la tool de cotización nombra a Eddyluz", () => {
    assert.match(GENERAR, /const EJECUTIVO_DEFAULT = "Eddyluz Mujica"/)
  })

  test("el teléfono de Eddyluz queda como contacto interno del funnel", () => {
    assert.match(FUNNEL, /"56939321687"/)
    // El de Anderson NO se borra: sus deals viejos siguen vivos.
    assert.match(FUNNEL, /"56939372058"/)
  })
})

describe("lo ya asignado queda con Anderson: el traspaso resuelve al dueño real", () => {
  test("consulta el Owner de la cotización pagada en vez de asumir un nombre", () => {
    assert.match(TRASPASO, /await ownerDeCotizacion\(quoteId\)/)
  })

  test("conoce a los dos ejecutivos de la transición", () => {
    assert.match(TRASPASO, /"emujica@geovictoria\.com": \{ nombre: "Eddyluz Mujica"/)
    assert.match(TRASPASO, /"adiazg@geovictoria\.com": \{ nombre: "Anderson Díaz"/)
  })

  test("el default —Zoho caído o sin owner— es Eddyluz, la del presente", () => {
    assert.match(TRASPASO, /EJECUTIVOS_CL\["emujica@geovictoria\.com"\]/)
  })

  test("un dueño fuera del mapa igual se presenta, con su nombre de Zoho", () => {
    assert.match(TRASPASO, /duenoCL \? \{ nombre: duenoCL\.nombre, email: duenoCL\.email, telefono: "" \}/)
  })

  test("la premisa de coherencia post-pago sigue en pie (presenta al ejecutivo)", () => {
    assert.match(TRASPASO, /te acompaña \*\$\{ejecutivo\.nombre\}\*/)
  })
})

describe("los textos que hablaban de Anderson dejaron de prometerlo", () => {
  test("agent-loop no promete un nombre en la reunión post-cotización", () => {
    // Durante la transición, prometer a Anderson (o a Eddyluz) por nombre es
    // mentir en la mitad de los casos: el mensaje va sin nombre y el aviso
    // interno manda a mirar el Owner del deal.
    assert.match(LOOP, /al ejecutivo a cargo de tu cotización/)
    assert.doesNotMatch(LOOP, /Anderson Díaz/)
    assert.match(LOOP, /revisar Owner de la cotización en Zoho/)
  })
})
