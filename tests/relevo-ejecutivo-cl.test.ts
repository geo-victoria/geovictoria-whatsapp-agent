/**
 * EJECUTIVO CL: del relevo fijo a la TÓMBOLA (auditoría 31-jul).
 *
 * Historia: el 27-jul "todo lo nuevo va a Eddyluz, lo asignado queda con
 * Anderson" (relevo). El 31-jul la tómbola de deals de Zoho pasó a decidir el
 * dueño de cada deal nuevo, y el relevo quedó solo como FALLBACK (Zoho caído
 * o deals anteriores). La consecuencia que estos tests fijan: "el ejecutivo
 * de Chile" NO es un nombre — es una función de CADA cotización/deal, y
 * cualquier código que presente un ejecutivo debe resolver el Owner real; los
 * nombres fijos solo pueden aparecer como fallback o como regla protectora.
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

describe("los caminos de asignación pasan por la tómbola, no por un nombre fijo", () => {
  test("el callback (ambos modos) sortea con la MISMA rotación del PTV", () => {
    assert.match(CALLBACK, /vendedoresDePais/)
    assert.match(CALLBACK, /ptv_rr_\$\{pais\}/)
    // El residuo del relevo murió: nada de Eddyluz por defecto.
    assert.doesNotMatch(CALLBACK, /emujica@geovictoria\.com/)
    assert.doesNotMatch(CALLBACK, /adiazg@geovictoria\.com/)
  })

  test("el fallback de cotización también entra a la tómbola (mismo owner sorteado)", () => {
    assert.match(CALLBACK, /const ownerEmail = await vendedorPorTombola\(pais\)/)
  })

  test("la tool de cotización muestra al dueño REAL que devolvió el cotizador", () => {
    assert.match(GENERAR, /data\.ejecutivo && data\.ejecutivo\.nombre/)
    // Eddyluz queda SOLO como último fallback (lectura de owner caída).
    assert.match(GENERAR, /const EJECUTIVO_DEFAULT = "Eddyluz Mujica"/)
  })

  test("el perfil CL conserva a Eddyluz como símil de fallback con datos reales", () => {
    assert.match(PERFIL, /nombre: "Eddyluz Mujica"/)
    assert.match(PERFIL, /email: "emujica@geovictoria\.com"/)
    assert.match(PERFIL, /telefono: "\+56 9 3932 1687"/)
    assert.doesNotMatch(PERFIL, /Anderson Díaz"/)
  })

  test("los teléfonos de Eddyluz y Anderson siguen como contactos internos del funnel", () => {
    assert.match(FUNNEL, /"56939321687"/)
    // El de Anderson NO se borra: sus deals viejos siguen vivos.
    assert.match(FUNNEL, /"56939372058"/)
  })
})

describe("el traspaso post-pago resuelve al dueño real", () => {
  test("consulta el Owner de la cotización pagada en vez de asumir un nombre", () => {
    assert.match(TRASPASO, /await ownerDeCotizacion\(quoteId\)/)
  })

  test("el directorio conoce a los ejecutivos de la transición Y a los de la tómbola", () => {
    assert.match(TRASPASO, /"emujica@geovictoria\.com": \{ nombre: "Eddyluz Mujica"/)
    assert.match(TRASPASO, /"adiazg@geovictoria\.com": \{ nombre: "Anderson Díaz"/)
    assert.match(TRASPASO, /"tmartinezq@geovictoria\.com": \{ nombre: "Tamara Martínez"/)
    assert.match(TRASPASO, /"alopez@geovictoria\.com": \{ nombre: "Ana Paula López"/)
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

describe("la comunicación al cliente no promete nombres fijos", () => {
  const PROMPT = leer("app/api/vic-sales-agent-v3/prompt.ts")
  const VOSEO = leer("lib/voseo-v3.ts")

  test("el prompt CL atribuye la asignación a la tómbola, no a Eddyluz", () => {
    assert.match(PROMPT, /el ejecutivo que sortee la tómbola de deals de Zoho/)
    assert.match(PROMPT, /el Lead entra a la tómbola de vendedores/)
    assert.doesNotMatch(PROMPT, /quedan SIEMPRE a nombre de Eddyluz/)
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

  test("el blindaje anti-fuga cubre los teléfonos de los CUATRO comerciales", () => {
    assert.match(VOSEO, /3937\[\\s\)\.\-\]\*2058/) // Anderson
    assert.match(VOSEO, /3932\[\\s\)\.\-\]\*1687/) // Eddyluz
    assert.match(VOSEO, /3452\[\\s\)\.\-\]\*9937/) // Tamara (tómbola 31-jul)
    assert.match(VOSEO, /6647\[\\s\)\.\-\]\*4270/) // Ana Paula (tómbola 31-jul)
    assert.match(VOSEO, /TELS_COMERCIALES_RE\.reduce/)
  })
})

describe("los textos que hablaban de un ejecutivo fijo dejaron de prometerlo", () => {
  test("agent-loop no promete un nombre en la reunión post-cotización", () => {
    assert.match(LOOP, /al ejecutivo a cargo de tu cotización/)
    assert.doesNotMatch(LOOP, /Anderson Díaz/)
    assert.match(LOOP, /revisar Owner de la cotización en Zoho/)
    assert.match(LOOP, /asignado por la tómbola de deals/)
  })
})
