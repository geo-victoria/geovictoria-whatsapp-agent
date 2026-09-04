/**
 * EL TOQUE HABLA DEL CLIENTE, NO DEL PAGO (Lalo 04-sep).
 *
 * "Los toques son muy malos en contenido, son apelando al pago, y deberían
 * apelar a cómo resolvemos los dolores que levantó durante la conversación."
 *
 * En etapa `formal` los cuatro textos decían lo mismo: acepta y paga. Ana
 * Delgado contó que estaba comparando con la competencia y once minutos
 * después recibió "Tu cotización quedó lista y la puedes aceptar y pagar en
 * línea". El pago solo es el paso siguiente cuando el cliente YA aceptó.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const CRON = readFileSync("app/api/vic-loop-cron/route.ts", "utf8")
const GEN = readFileSync("lib/toque-contexto.ts", "utf8")

/** Textos de una etapa, en todos los bloques de toques del cron. */
function textosDeEtapa(etapa: string): string[] {
  const out: string[] = []
  for (const bloque of ["const TEXTOS: ", "const TEXTOS_T2:", "const TEXTOS_T3:", "const TEXTOS_T4PLUS:"]) {
    const i = CRON.indexOf(bloque)
    if (i < 0) continue
    const j = CRON.indexOf("\n}", i)
    const cuerpo = CRON.slice(i, j)
    const k = cuerpo.indexOf(`${etapa}: {`)
    if (k < 0) continue
    out.push(cuerpo.slice(k, cuerpo.indexOf("\n  },", k)))
  }
  return out
}

test("en etapa formal ningún toque pide el pago", () => {
  const textos = textosDeEtapa("formal")
  assert.ok(textos.length >= 4, "deben existir los cuatro bloques de toques")
  for (const t of textos) {
    assert.ok(
      !/aceptas y pagas|completar el pago|aceptar y pagar|pagar en línea/i.test(t),
      `un toque de etapa formal sigue pidiendo el pago:\n${t.slice(0, 160)}`,
    )
  }
})

test("en etapa aceptada SÍ se pide el pago: ahí es el paso siguiente", () => {
  const textos = textosDeEtapa("aceptada")
  assert.ok(
    textos.some((t) => /pago|LINK_PAGO/i.test(t)),
    "quien ya aceptó solo tiene que pagar — ese toque no debe perder su propósito",
  )
})

test("la generación por contexto cubre los toques 1 al 5", () => {
  assert.ok(
    /const generable = touch >= 1 && touch <= 5 && \(touch === 5 \|\| ventanaAbierta\)/.test(CRON),
    "1-4 solo dentro de ventana (ahí el texto libre es legal); el 5 conserva su plantilla",
  )
})

test("el generador tiene prohibido pedir el pago y debe retomar la duda", () => {
  assert.ok(/NO pidas el pago/.test(GEN), "regla explícita en el prompt del generador")
  assert.ok(/objeción o una comparación con otro proveedor/.test(GEN), "ese es el tema del mensaje")
})

test("un toque generado con un precio inventado se descarta", () => {
  assert.ok(GEN.includes("chequearPreciosDelReply"), "el guardrail de precios también cubre el cron")
  assert.ok(
    /return null/.test(GEN.slice(GEN.indexOf("PRECIO SIN RESPALDO"))),
    "ante un precio sin respaldo cae al texto fijo — el toque nunca se pierde",
  )
})
