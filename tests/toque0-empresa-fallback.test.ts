/**
 * El fallback "tu empresa" del toque 0 es para la PLANTILLA, no para los datos.
 *
 * CADENA REAL (21–24 jul): el formulario web llegó sin razón social, el toque 0
 * rellenó `empresa = "tu empresa"` y lo escribió en el bloque de contexto
 * `[Datos del formulario web: ... empresa tu empresa ...]`. Vicky leyó ese
 * bloque como si fuera el nombre de la empresa y emitió TRES cotizaciones
 * formales en Zoho a nombre literal de "tu empresa" — una de $334.188 (Notaría
 * Almendras). El 27-jul hubo que crear una plantilla de disculpa
 * (vicky_correccion_razon_social_cl) para recuperarlas.
 *
 * La regla que queda: el fallback puede seguir alimentando la plantilla de
 * apertura (ahí lee natural y en T0 no pisa variables previas, porque no
 * existen), pero el bloque de contexto tiene que declarar el dato como
 * FALTANTE, para que Vicky lo pregunte en vez de usarlo.
 *
 * Importa doble desde el 27-jul: se abre el botón de WhatsApp del sitio y la
 * asignación de leads — este archivo ES la puerta de entrada de esos leads.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const RAIZ = new URL("..", import.meta.url).pathname
const SRC = readFileSync(join(RAIZ, "app/api/vic-outbound-lead/route.ts"), "utf8")

describe("el contexto del toque 0 no disfraza el fallback de dato", () => {
  test("el bloque de contexto declara la empresa como no indicada", () => {
    assert.match(SRC, /empresa === "tu empresa" \? "NO INDICADA/)
    assert.match(SRC, /pregúntala antes de la cotización formal/)
  })

  test("el literal nunca viaja directo al bloque de contexto", () => {
    // La forma vieja era `· empresa ${empresa}` sin condición. Si reaparece,
    // vuelve la cadena de las cotizaciones a nombre de "tu empresa".
    assert.doesNotMatch(
      SRC,
      /· empresa \$\{empresa\}`/,
      "el contexto volvió a interpolar la empresa sin filtrar el fallback",
    )
  })

  test("el fallback de la plantilla sigue existiendo (la apertura debe leer natural)", () => {
    // Quitar el fallback rompería el T0 de todo formulario sin Company: la
    // plantilla mostraría un hueco. Ese uso es legítimo — el problema era solo
    // el contexto.
    assert.match(SRC, /\? "tu empresa" : empresaRaw/)
  })
})
