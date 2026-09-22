/**
 * La guarda anti-repetición NO puede congelar la cadencia (04-sep).
 *
 * El 03-sep se agregó `textoYaEnviado` para que Vicky no mandara dos veces el
 * mismo texto al mismo contacto. La guarda cortaba con `continue`… y en este
 * bucle el `continue` salta TAMBIÉN el avance del ciclo que vive al final de
 * la iteración: el contacto quedaba clavado en el mismo toque, re-evaluado
 * cada 2 minutos para siempre (15 loops congelados en 6 horas).
 *
 * El test es de INSPECCIÓN porque el cron no es importable (arrastra Supabase,
 * Botmaker y Zoho). Vigila la forma: guarda por bandera, jamás por salto.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const FUENTE = readFileSync("app/api/vic-loop-cron/route.ts", "utf8")

test("la guarda anti-repetición usa bandera, no `continue`", () => {
  const i = FUENTE.indexOf("const omitidoPorRepetido = await textoYaEnviado(")
  assert.ok(i > 0, "la guarda debe evaluarse en una bandera `omitidoPorRepetido`")
  // Entre la guarda y el primer envío no puede haber un `continue`: ese salto
  // es exactamente el que se comía el avance del ciclo.
  const j = FUENTE.indexOf("} else if (ventanaAbierta) {", i)
  assert.ok(j > i, "tras la guarda, el envío debe colgar de `else if (ventanaAbierta)`")
  assert.ok(
    !FUENTE.slice(i, j).includes("continue"),
    "la guarda anti-repetición no puede cortar la iteración: congela la cadencia",
  )
})

test("el toque omitido por repetido sigue contando como ejecutado", () => {
  const i = FUENTE.indexOf("const omitidoPorRepetido = await textoYaEnviado(")
  const bloque = FUENTE.slice(i, i + 600)
  assert.ok(bloque.includes("ejecutado = true"), "sin esto el avance del final no corre")
  assert.ok(bloque.includes('skip: "repetido"'), "el detalle debe declarar por qué se omitió")
})

test("el avance del ciclo sigue estando después del envío", () => {
  const guarda = FUENTE.indexOf("const omitidoPorRepetido = await textoYaEnviado(")
  const avance = FUENTE.indexOf("if (!ejecutado) continue", guarda)
  assert.ok(avance > guarda, "el avance del ciclo debe ser alcanzable desde la guarda")
})
