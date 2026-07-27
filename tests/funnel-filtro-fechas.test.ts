/**
 * Filtro Desde–Hasta del dash del embudo (pedido Lalo 27-jul).
 *
 * Reglas que estos tests fijan:
 *   - El rango se interpreta en hora de CHILE (UTC-4), inclusivo en ambos
 *     extremos: desde las 00:00 del "desde" hasta las 23:59:59.999 del
 *     "hasta". Un evento de las 20:00 hora Chile del día "hasta" (que en UTC
 *     ya es el día siguiente) DEBE caer dentro.
 *   - Aplica a conversaciones (por inicio) y a cotizaciones (por emisión).
 *     El "Funnel por origen" queda fuera a propósito y la UI lo dice.
 *   - Con el filtro activo, una conversación sin fecha conocida se excluye.
 *   - Entradas malformadas o rango invertido → sin filtro, nunca un error.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const RAIZ = new URL("..", import.meta.url).pathname
const SRC = readFileSync(join(RAIZ, "app/api/vic-funnel/route.ts"), "utf8")

describe("parseRango (reglas extraídas del archivo)", () => {
  test("el rango es hora de Chile, inclusivo en ambos extremos", () => {
    assert.match(SRC, /T00:00:00-04:00/)
    assert.match(SRC, /T23:59:59\.999-04:00/)
  })

  test("un rango invertido o malformado se descarta, no revienta", () => {
    assert.match(SRC, /desdeMs > hastaMs\) return null/)
    assert.match(SRC, /\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$/)
  })

  test("el value de los inputs usa el string original, no una conversión UTC", () => {
    // new Date(hastaMs).toISOString().slice(0,10) devolvería el día SIGUIENTE
    // (23:59 de Chile es madrugada UTC): el input mostraría una fecha corrida.
    assert.match(SRC, /value="\$\{rango \? rango\.desdeStr : ""\}"/)
    assert.match(SRC, /value="\$\{rango \? rango\.hastaStr : ""\}"/)
    assert.doesNotMatch(SRC, /toISOString\(\)\.slice\(0, 10\)/)
  })
})

describe("el filtro llega a las tres capas", () => {
  test("conversaciones: por fecha de inicio, excluyendo las de fecha desconocida", () => {
    assert.match(SRC, /return !rango \|\| enRango\(fechasConv\.get\(r\.conversation_id\), rango\)/)
  })

  test("cotizaciones de Zoho: por fecha de creación", () => {
    assert.match(SRC, /return !rango \|\| enRango\(q\.Created_Time, rango\)/)
  })

  test("las ventas cerradas heredan el filtro (nacen de aceptadasList ya filtrada)", () => {
    assert.match(SRC, /construirVentasCerradas\(cierre\.aceptadasList\)/)
  })

  test("las fechas de conversación solo se consultan con el filtro activo", () => {
    assert.match(SRC, /rango \? fetchFechasConversaciones\(\) : Promise\.resolve/)
  })
})

describe("la UI declara lo que el filtro cubre y lo que no", () => {
  test("hay formulario con desde/hasta que conserva key y país", () => {
    assert.match(SRC, /name="desde"/)
    assert.match(SRC, /name="hasta"/)
    assert.match(SRC, /input type="hidden" name="key"/)
    assert.match(SRC, /input type="hidden" name="pais"/)
  })

  test("con filtro activo se muestra la etiqueta del rango y el quitar", () => {
    assert.match(SRC, /Quitar filtro/)
    assert.match(SRC, /rango\.etiqueta/)
  })

  test("advierte que el funnel por origen no se filtra", () => {
    // Sin esta advertencia, el lector cruza cifras filtradas con cifras del
    // programa completo y saca conclusiones equivocadas.
    assert.match(SRC, /"Funnel por origen" muestra el programa completo/)
  })
})
