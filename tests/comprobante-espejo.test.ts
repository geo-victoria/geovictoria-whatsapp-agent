import { test } from "node:test"
import assert from "node:assert/strict"
import { motivoDescarteComprobanteEspejo } from "../lib/comprobante-espejo.ts"

const INT = new Set(["56978385048"])

test("captura de nuestra notificación PAGADA no es comprobante (caso Rodrigo 24-sep)", () => {
  const t = "Es una captura de pantalla de WhatsApp mostrando una notificación de cotización pagada de GeoVictoria. Monto $26.824, transferencia recibida."
  assert.equal(motivoDescarteComprobanteEspejo(t, "56911112222", INT), "notificacion_propia")
})

test("contacto interno nunca", () => {
  const t = "Comprobante de transferencia a Victoria S.A cuenta 8001204108 monto $26.824"
  assert.equal(motivoDescarteComprobanteEspejo(t, "56978385048", INT), "contacto_interno")
})

test("transferencia a un tercero no cuenta", () => {
  const t = "Comprobante de transferencia. Destinatario: Proveedor Logístico Ltda, cuenta 1234567890. Monto $50.000"
  assert.equal(motivoDescarteComprobanteEspejo(t, "56911112222", INT), "destino_no_nuestro")
})

test("comprobante real a nuestra cuenta pasa (completa o enmascarada)", () => {
  assert.equal(motivoDescarteComprobanteEspejo("Transferencia exitosa a VICTORIA S.A. Cuenta 8001204108 Monto $65.238", "56911112222", INT), null)
  assert.equal(motivoDescarteComprobanteEspejo("Transferencia realizada. Destino ****4108 Banco de Chile. Monto $65.238", "56911112222", INT), null)
})
