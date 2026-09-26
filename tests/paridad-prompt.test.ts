import { test } from "node:test"
import assert from "node:assert/strict"
import { REGLAS_UNIVERSALES, PAISES_PROMPT, brechasDe, reglasExigidas, type PaisPrompt } from "../lib/paridad-prompt.ts"

// Los CUATRO países son el núcleo (lib/prompt-nucleo/texto.ts) armado con su
// ficha: los prompts propios de PE/CO/MX se retiraron el 26-sep. Se arma con
// catálogo vacío (las reglas son texto; el catálogo no aporta anclas).
import { textoNucleo } from "../lib/prompt-nucleo/texto.ts"
import { FICHA_CL } from "../lib/prompt-nucleo/ficha.ts"
import { FICHA_PE } from "../lib/paises/pe/ficha.ts"
import { FICHA_CO } from "../lib/paises/co/ficha.ts"
import { FICHA_MX } from "../lib/paises/mx/ficha.ts"
const FICHAS = { cl: FICHA_CL, pe: FICHA_PE, co: FICHA_CO, mx: FICHA_MX } as const
const texto = (p: PaisPrompt) => textoNucleo(FICHAS[p], "")

test("el catálogo de reglas está sano (ids únicos, ancla y motivo)", () => {
  const ids = new Set<string>()
  for (const r of REGLAS_UNIVERSALES) {
    assert.ok(r.id && !ids.has(r.id), `id duplicado o vacío: ${r.id}`)
    ids.add(r.id)
    assert.ok(r.ancla instanceof RegExp, `${r.id}: falta el ancla`)
    assert.ok(r.motivo.length > 10, `${r.id}: el motivo explica por qué existe la regla`)
  }
})

test("CHILE cumple todas las reglas universales (es la referencia: si falla, el ancla está mal escrita)", () => {
  const faltan = brechasDe("cl", texto("cl"))
  assert.deepEqual(
    faltan.map((b) => b.id),
    [],
    `El ancla de estas reglas no encuentra su texto en el prompt chileno — corrige el ancla, no el prompt:\n${faltan
      .map((b) => `  · ${b.id}: ${b.regla}`)
      .join("\n")}`,
  )
})

// El candado: una regla nueva en Chile no puede quedar sin decisión para el
// resto de los países. La deuda vieja va declarada en DEUDA_DECLARADA con
// fecha; solo una brecha NUEVA rompe el test.
for (const pais of PAISES_PROMPT.filter((p) => p !== "cl")) {
  test(`${pais.toUpperCase()}: sin brechas nuevas contra Chile`, () => {
    const nuevas = brechasDe(pais, texto(pais)).filter((b) => !b.declarada)
    assert.deepEqual(
      nuevas.map((b) => b.id),
      [],
      `Brechas NO declaradas en ${pais.toUpperCase()} (agrégalas al prompt, o decláralas en DEUDA_DECLARADA con su motivo):\n${nuevas
        .map((b) => `  · ${b.id}: ${b.regla}\n      (${b.motivo})`)
        .join("\n")}`,
    )
  })
}

test("la paridad se mide y se reporta", () => {
  for (const p of PAISES_PROMPT) {
    const total = reglasExigidas(p).length
    const faltan = brechasDe(p, texto(p))
    console.log(`  ${p.toUpperCase()}: ${total - faltan.length}/${total} reglas · faltan: ${faltan.map((b) => b.id).join(", ") || "ninguna"}`)
  }
  assert.ok(REGLAS_UNIVERSALES.length > 0)
})
