import { test } from "node:test"
import assert from "node:assert/strict"
import { pareceComprobanteTransferencia, montoEnComprobante, directivaComprobante } from "../lib/comprobante-directiva.ts"

const BBVA = "Constancia de transferencia BBVA. Operación exitosa. Monto transferido: S/ 70.09. Cuenta de origen: 0011-0345-0100221177-90, PRUEBA VICKY PE SAC. Cuenta de destino: 0011-0123-0100091134-75, GEOVICTORIA PERU S.A.C. Número de operación: 00845217."
const SANTANDER = "Comprobante Santander. Transferencia a Victoria S.A cuenta 8001204108 Banco de Chile. Monto: $48.158. N° de operación 123456. Mensaje: pago cotizacion 266"

test("comprobante PE (BBVA, soles) y CL (Santander, pesos) se reconocen y el monto sale en la moneda del país", () => {
  assert.equal(pareceComprobanteTransferencia(BBVA), true)
  assert.equal(montoEnComprobante(BBVA), 70.09)
  assert.equal(pareceComprobanteTransferencia(SANTANDER), true)
  assert.equal(montoEnComprobante(SANTANDER), 48158)
  assert.match(directivaComprobante(BBVA), /registrar_comprobante_transferencia AHORA MISMO con montoDetectado=70\.09/)
})

test("una foto que no es comprobante no dispara la directiva", () => {
  for (const d of [
    "Foto de un reloj de control de asistencia montado en una pared blanca, con pantalla táctil.",
    "Planilla con columnas RUT, Correo, Nombres, Apellidos y 5 trabajadores.",
    "Captura de pantalla de una agenda de reunión para el martes a las 10:00.",
  ]) {
    assert.equal(pareceComprobanteTransferencia(d), false, d)
    assert.equal(directivaComprobante(d), "")
  }
})

test("comprobante ilegible en el monto: la directiva pide montoDetectado 0, nunca inventa", () => {
  const d = "Comprobante de transferencia BBVA a GEOVICTORIA PERU S.A.C. Operación exitosa. El monto aparece borroso."
  assert.equal(pareceComprobanteTransferencia(d), true)
  assert.match(directivaComprobante(d), /montoDetectado 0 si el monto no se lee/)
})
