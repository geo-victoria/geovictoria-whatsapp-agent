/**
 * La sincronización CRM por hitos respeta el diccionario acordado con
 * marketing (Lalo 30-jul) y sus dos reglas duras:
 *
 *   1. El deal SIEMPRE nace de un lead convertido (nunca deal directo).
 *   2. El stage NUNCA retrocede: cada hito es un PISO — max(actual, piso).
 *
 * Y el origen doble del dato: si el lead ya existe en el CRM (conversación
 * SALIENTE por asignación), se reutiliza y se respeta a su dueño; solo si no
 * existe nada (ENTRANTE) se crea.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { PISO_POR_HITO, HITO_POR_TOOL, etapaObjetivo } from "../lib/crm-hitos.ts"

const RAIZ = new URL("..", import.meta.url).pathname
const LOOP = readFileSync(join(RAIZ, "lib/agent-loop.ts"), "utf8")
const HITOS = readFileSync(join(RAIZ, "lib/crm-hitos.ts"), "utf8")

describe("diccionario de hitos → etapa piso", () => {
  test("los pisos son exactamente los acordados con marketing", () => {
    assert.equal(PISO_POR_HITO.intencion, "1. Trato Creado")
    assert.equal(PISO_POR_HITO.reunion_realizada, "2. Primera Reunion Realizada")
    assert.equal(PISO_POR_HITO.discovery, "3. En Levantamiento")
    assert.equal(PISO_POR_HITO.preform, "4. Propuesta Enviada / En Negociación")
    assert.equal(PISO_POR_HITO.aceptada, "6. Listo para Cierre")
    assert.equal(PISO_POR_HITO.onboarding_listo, "7. Implementando")
  })

  test("preform visto EN ADELANTE es Propuesta Enviada (cotizar_referencial incluido)", () => {
    assert.equal(HITO_POR_TOOL.cotizar_referencial, "preform")
    assert.equal(HITO_POR_TOOL.actualizar_cotizacion, "preform")
  })

  test("el comprobante de transferencia es aceptación", () => {
    assert.equal(HITO_POR_TOOL.registrar_comprobante_transferencia, "aceptada")
  })

  test("las tools de soporte NO están en el diccionario", () => {
    assert.equal(HITO_POR_TOOL.derivar_a_soporte, undefined)
    assert.equal(HITO_POR_TOOL.consultar_agente_soporte, undefined)
  })
})

describe("el stage nunca retrocede (cada hito es un piso)", () => {
  test("sube cuando el piso es mayor", () => {
    assert.equal(
      etapaObjetivo("1. Trato Creado", "4. Propuesta Enviada / En Negociación"),
      "4. Propuesta Enviada / En Negociación",
    )
  })

  test("la reunión NO baja un deal que ya vio preform", () => {
    assert.equal(
      etapaObjetivo("4. Propuesta Enviada / En Negociación", "2. Primera Reunion Realizada"),
      null,
    )
  })

  test("misma etapa → no tocar", () => {
    assert.equal(etapaObjetivo("3. En Levantamiento", "3. En Levantamiento"), null)
  })

  test("Cierre Perdido es terminal: ningún hito lo resucita", () => {
    assert.equal(etapaObjetivo("Cierre Perdido", "6. Listo para Cierre"), null)
  })
})

describe("reglas duras del módulo", () => {
  test("está detrás de flag, apagado por defecto", () => {
    assert.match(HITOS, /VICKY_CRM_HITOS_ENABLED/)
  })

  test("el deal nace SOLO por conversión de lead (nunca POST directo a Deals)", () => {
    assert.match(HITOS, /actions\/convert/)
    assert.ok(!/fetch\([^)]*\/crm\/v\d\/Deals`,\s*\{\s*method:\s*"POST"/.test(HITOS))
  })

  test("lead de dueño humano no se convierte sin autorización explícita", () => {
    assert.match(HITOS, /VICKY_CRM_HITOS_CONVERTIR_AJENOS/)
    assert.match(HITOS, /dueño humano/)
  })

  test("teléfonos de prueba jamás crean registros", () => {
    assert.match(HITOS, /VICKY_TELEFONOS_PRUEBA/)
  })

  test("mandatorios de la transición van DENTRO del data (lección del backfill)", () => {
    assert.match(HITOS, /blueprint:\s*\[\{\s*transition_id:\s*trans\.id,\s*data\s*\}\]/)
  })
})

describe("cableado en el agent-loop", () => {
  test("el hook corre tras el éxito de la tool, best-effort", () => {
    assert.match(LOOP, /HITO_POR_TOOL\[toolName\]/)
    assert.match(LOOP, /void sincronizarHitoCrm\(contact, HITO_POR_TOOL\[toolName\]\)\.catch/)
  })
})
