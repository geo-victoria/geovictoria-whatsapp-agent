/**
 * Umbral de venta autónoma (Lalo 08-ago): inbound 20 / outbound 10.
 *
 * Estas reglas son de proceso comercial, no cosméticas: si alguien cambia un
 * default o rompe el rollback clásico sin darse cuenta, Vicky vuelve a vender
 * sola hasta 50 (o deja de vender del todo). Un test se acuerda.
 */

import { test, describe, beforeEach } from "node:test"
import assert from "node:assert/strict"

import {
  SCOPE_MAX_SISTEMA,
  umbralInbound,
  umbralOutbound,
  formatUmbralParaPrompt,
} from "../lib/umbral-autonomia.ts"

beforeEach(() => {
  delete process.env.VICKY_UMBRAL_CLASICO
  delete process.env.VICKY_UMBRAL_INBOUND
  delete process.env.VICKY_UMBRAL_OUTBOUND
})

describe("umbrales por defecto (doc 08-ago)", () => {
  test("inbound 20 / outbound 10, dentro del tope del sistema (50)", () => {
    assert.equal(umbralInbound(), 20)
    assert.equal(umbralOutbound(), 10)
    assert.equal(SCOPE_MAX_SISTEMA, 50)
  })

  test("overrides por env, con bounds sanos (1..50)", () => {
    process.env.VICKY_UMBRAL_INBOUND = "30"
    process.env.VICKY_UMBRAL_OUTBOUND = "15"
    assert.equal(umbralInbound(), 30)
    assert.equal(umbralOutbound(), 15)
    // Valores fuera de rango o basura NO se aceptan: vuelven al default.
    process.env.VICKY_UMBRAL_INBOUND = "0"
    process.env.VICKY_UMBRAL_OUTBOUND = "99"
    assert.equal(umbralInbound(), 20)
    assert.equal(umbralOutbound(), 10)
  })

  test("rollback clásico: VICKY_UMBRAL_CLASICO=1 vuelve al 50/50", () => {
    process.env.VICKY_UMBRAL_CLASICO = "1"
    assert.equal(umbralInbound(), 50)
    assert.equal(umbralOutbound(), 50)
  })
})

describe("bloque de prompt", () => {
  test("con umbral 50 (clásico) el bloque es vacío — nada cambia", () => {
    assert.equal(formatUmbralParaPrompt(50, "inbound"), "")
  })

  test("bajo 50 declara umbral, derivación y acompañamiento", () => {
    const bloque = formatUmbralParaPrompt(20, "inbound")
    assert.match(bloque, /SOLO hasta 20 trabajadores/)
    assert.match(bloque, /INBOUND/)
    // La derivación nombra la tool y el motivo EXACTOS del toolset CL.
    assert.match(bloque, /derivar_a_soporte/)
    assert.match(bloque, /fuera_de_rango_trabajadores/)
    // Lo aprendido (Lalo 08-ago): Vicky acompaña, no abandona.
    assert.match(bloque, /ACOMPAÑA/)
    assert.match(bloque, /agendar_reunion/)
    // El >50 conserva su flujo enterprise.
    assert.match(bloque, /MÁS de 50 trabajadores no cambia/)
  })

  test("outbound usa su propio umbral en el texto", () => {
    const bloque = formatUmbralParaPrompt(10, "outbound")
    assert.match(bloque, /SOLO hasta 10 trabajadores/)
    assert.match(bloque, /OUTBOUND/)
  })
})
