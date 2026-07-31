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
    // Desde el 31-jul (tómbola): nombre real de Zoho siempre, y el teléfono
    // sale del directorio cuando lo conocemos ("" si no).
    assert.match(TRASPASO, /nombre: duenoCL\.nombre \|\| EJECUTIVOS_CL\[duenoCL\.email\]\?\.nombre \|\| ""/)
    assert.match(TRASPASO, /telefono: EJECUTIVOS_CL\[duenoCL\.email\.toLowerCase\(\)\]\?\.telefono \|\| ""/)
  })

  test("la premisa de coherencia post-pago sigue en pie (presenta al ejecutivo)", () => {
    assert.match(TRASPASO, /te acompaña \*\$\{ejecutivo\.nombre\}\*/)
  })
})

describe("la comunicación al cliente nombra a Eddyluz", () => {
  const PROMPT = leer("app/api/vic-sales-agent-v3/prompt.ts")
  const VOSEO = leer("lib/voseo-v3.ts")

  test("el prompt CL atribuye lo nuevo a Eddyluz", () => {
    assert.match(PROMPT, /a nombre de Eddyluz Mujica, la ejecutiva que da seguimiento/)
    assert.match(PROMPT, /el Lead queda a nombre de Eddyluz para que ella lo retome/)
    assert.doesNotMatch(PROMPT, /a nombre de Anderson/)
  })

  test("las únicas menciones a Anderson que quedan son protectoras", () => {
    // Regla anti-fuga (no mencionarlo pre-pago / no dar su número como
    // soporte): esas DEBEN conservarlo — su número sigue vivo en historiales.
    const menciones = [...PROMPT.matchAll(/Anderson/g)]
    assert.equal(menciones.length, 2, `hay ${menciones.length} menciones; deben ser solo las 2 protectoras`)
    assert.match(PROMPT, /NUNCA menciones a Eddyluz Mujica, a Anderson Díaz ni a ningún ejecutivo/)
    assert.match(PROMPT, /JAMÁS entregues el número o correo de Eddyluz Mujica/)
  })

  test("el blindaje anti-fuga cubre los teléfonos de los DOS ejecutivos", () => {
    assert.match(VOSEO, /3937\[\\s\)\.\-\]\*2058/)
    assert.match(VOSEO, /3932\[\\s\)\.\-\]\*1687/)
    assert.match(VOSEO, /replace\(ANDERSON_TEL_RE, SOPORTE_WHATSAPP\)\.replace\(EDDYLUZ_TEL_RE, SOPORTE_WHATSAPP\)/)
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
