import { test } from "node:test"
import assert from "node:assert/strict"
import { pideComprobanteOPago, directivaPagoCerrado } from "../lib/pago-cerrado.ts"

test("detecta pedir comprobante o pago (caso NelNav 26-sep)", () => {
  assert.equal(
    pideComprobanteOPago(
      "Me podrías mandar el comprobante de transferencia por aquí? (una foto o captura). Con eso te dejo la cuenta lista de inmediato",
    ),
    true,
  )
  assert.equal(pideComprobanteOPago("Solo falta el pago para activar tu cuenta"), true)
  assert.equal(pideComprobanteOPago("Cuando realices el pago te mando el formulario"), true)
})

test("no confunde mensajes de post-venta", () => {
  assert.equal(pideComprobanteOPago("Perfecto, recibido! 🎉 Ya veo tu pago aprobado por $26.835."), false)
  assert.equal(pideComprobanteOPago("¡Confirmado, tu pago ya quedó registrado! 🎉"), false)
  assert.equal(pideComprobanteOPago("La cuenta la vas a administrar tú?"), false)
})

test("la directiva prohíbe pedir comprobante", () => {
  const d = directivaPagoCerrado({ fuente: "mercado_pago", at: "2026-09-26T17:27:41Z" })
  assert.match(d, /JAMÁS le pidas comprobante/)
})
