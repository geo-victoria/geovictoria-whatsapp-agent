/**
 * DESCUENTO FLEXIBLE PARA EL EJECUTIVO (Lalo 10-ago).
 *
 * Caso real: Cigpa Ingeniería (cotización 3525045000646859011, dueño Anderson
 * Díaz). El ejecutivo pidió 10% desde el panel interno y el sistema le comiteó
 * 20%, porque el editor usaba la ESCALERA de cara al cliente —que solo avanza
 * al escalón siguiente desde lo ya comiteado y nunca baja—. Y no pudo tocar la
 * vigencia: los 6 meses eran una constante del repo (MESES_DESCUENTO_PLAN),
 * sin campo ni parámetro por cotización.
 *
 * Regla nueva: en el canal INTERNO manda el vendedor. Porcentaje exacto (puede
 * bajar, puede quedar en 0) y vigencia en meses (1..N, o 0 = indefinido). La
 * escalera queda SOLO para Vicky con clientes.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const RAIZ = new URL("..", import.meta.url).pathname
const leer = (p: string) => readFileSync(join(RAIZ, p), "utf8")
const EDITOR = leer("lib/cotizaciones-editor.ts")
const TOOL = leer("lib/tools/definir-descuento-ejecutivo.ts")
const PUENTE = leer("app/api/vic-admin-pdf-sync/route.ts")

describe("el editor interno fija el descuento EXACTO que pide el vendedor", () => {
  test("la tool recibe pct y meses, no un objetivo de escalera", () => {
    assert.match(EDITOR, /name: "aplicar_descuento"/)
    assert.match(EDITOR, /pct: \{\s*\n\s*type: "number" as const/)
    assert.match(EDITOR, /meses: \{\s*\n\s*type: "number" as const/)
    // El parámetro viejo (pct_objetivo, "el servidor decide el escalón") murió.
    assert.doesNotMatch(EDITOR, /pct_objetivo/)
  })

  test("el handler llama al canal ejecutivo, NO a la escalera", () => {
    assert.match(EDITOR, /definirDescuentoEjecutivo\(\{/)
    assert.doesNotMatch(EDITOR, /aplicarSiguienteDescuento\(/)
  })

  test("meses viaja solo si el vendedor lo mencionó (omitirlo conserva la vigencia)", () => {
    assert.match(EDITOR, /\.\.\.\(typeof input\?\.meses === "number" \? \{ meses: input\.meses \} : \{\}\)/)
  })

  test("el prompt dice explícitamente que 10 es 10 y que 0 meses es indefinido", () => {
    assert.match(EDITOR, /ACÁ MANDA EL VENDEDOR, NO LA ESCALERA/)
    assert.match(EDITOR, /10 es 10, no 20/)
    assert.match(EDITOR, /0 significa INDEFINIDO/)
    // Y el límite declarado ya no es el tope 20 de la escalera.
    assert.match(EDITOR, /cualquier % entre 0 y 40 y cualquier vigencia/)
  })
})

describe("el cliente de la tool respeta la diferencia entre 'no tocar' y 'volver al default'", () => {
  test("meses ausente NO viaja; meses null SÍ viaja (vuelve a la política por defecto)", () => {
    assert.match(TOOL, /hasOwnProperty\.call\(args, "meses"\)/)
    assert.match(TOOL, /body\.meses = args\.meses \?\? null/)
  })

  test("sin pct ni meses no se llama a la cotizadora", () => {
    assert.match(TOOL, /Nada que cambiar: indica el % o la vigencia/)
  })

  test("apunta al endpoint nuevo del cotizador con el secreto compartido", () => {
    assert.match(TOOL, /\/api\/quote-acceptance\/descuento-ejecutivo/)
    assert.match(TOOL, /"x-vicky-secret": VICKY_COTIZADORA_SECRET/)
  })
})

describe("el puente guarda la vigencia por cotización", () => {
  test("acepta meses_get y meses_set", () => {
    assert.match(PUENTE, /"meses_get", "meses_set"/)
    assert.match(PUENTE, /descuento_meses_\$\{quoteId\}/)
  })

  test("meses null borra la marca (vuelve a la política por defecto)", () => {
    assert.match(PUENTE, /if \(body\.meses === null \|\| body\.meses === undefined\) \{[\s\S]{0,200}method: "DELETE"/)
  })

  test("acota el valor: nunca negativo, nunca absurdo", () => {
    assert.match(PUENTE, /Math\.min\(120, Math\.max\(0, Math\.trunc\(Number\(body\.meses\) \|\| 0\)\)\)/)
  })
})
