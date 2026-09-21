import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { textoNucleo } from "../lib/prompt-nucleo/texto.ts"
import { armarPromptBase } from "../lib/prompt-nucleo/armar.ts"
import { FICHA_CL } from "../lib/prompt-nucleo/ficha.ts"

// LA PRUEBA DE CHILE (Lalo 21-sep, "avísame cuando pase la prueba chile"):
// el núcleo armado con la ficha de Chile tiene que ser IDÉNTICO al prompt
// real de producción, carácter por carácter. El fixture es el render de
// producción congelado (vic-paridad-prompts?texto=1) ANTES de tocar nada.
// Mientras esta prueba no pase, Chile no consume el núcleo.
const FX = new URL("./fixtures/prompt-cl.json", import.meta.url)

test("Chile: el núcleo con su ficha es idéntico al prompt de producción", { skip: !existsSync(FX) && "sin fixture" }, () => {
  const fx = JSON.parse(readFileSync(FX, "utf-8")) as { base: string; catalogo: string; base20: string }
  const armado = textoNucleo(FICHA_CL, fx.catalogo)
  if (armado !== fx.base) {
    // Localizar la PRIMERA diferencia para que el fallo sea accionable.
    let i = 0
    while (i < armado.length && i < fx.base.length && armado[i] === fx.base[i]) i++
    assert.fail(`difiere en el carácter ${i}: núcleo=${JSON.stringify(armado.slice(i, i + 120))} · producción=${JSON.stringify(fx.base.slice(i, i + 120))}`)
  }
})

test("Chile: el ajuste de umbral 20 también es idéntico", { skip: !existsSync(FX) && "sin fixture" }, () => {
  const fx = JSON.parse(readFileSync(FX, "utf-8")) as { base: string; catalogo: string; base20: string }
  // base20 viene con la fecha y el teléfono del canal por delante: se compara
  // desde donde empieza el cuerpo ("Eres Vicky").
  const cuerpo20 = fx.base20.slice(fx.base20.indexOf("Eres Vicky"))
  const armado20 = armarPromptBase(FICHA_CL, fx.catalogo, 20)
  assert.equal(armado20, cuerpo20)
})
