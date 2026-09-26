/**
 * El motor único de cotización (lib/cotizacion/motor.ts): una sola lógica
 * para Perú, Colombia y México. Candados: los tres adaptadores lo usan, y las
 * reglas que se unificaron el 26-sep valen igual en los tres.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { unirPartes } from "../lib/cotizacion/motor.ts"
import { cotizarPE } from "../lib/paises/pe/cotizar.ts"
import { cotizarCO } from "../lib/paises/co/cotizar.ts"
import { cotizarMX } from "../lib/paises/mx/cotizar.ts"

test("los tres países cotizan con el motor único (sin lógica propia)", () => {
  for (const p of ["pe", "co", "mx"]) {
    const src = readFileSync(`lib/paises/${p}/cotizar.ts`, "utf8")
    assert.ok(src.includes("../../cotizacion/motor.ts"), `${p} no importa el motor único`)
    assert.ok(!/const grupos = new Map/.test(src), `${p} volvió a tener lógica propia`)
  }
})

test("pago inicial = pagos únicos + primer mes (plan con descuento + arriendo) en los tres países", () => {
  const pe = cotizarPE({ userCount: 15, reloj: { modalidad: "arriendo", cantidad: 1 }, puntos: [{ ubicacion: "Miraflores", zona: "lima", autoInstalada: true }], escalonDescuento: 1, tipoCambio: 3.372 })
  assert.ok(Math.abs(pe.pagoInicialNeto - (135 * 0.9 + 67)) < 0.01)
  const co = cotizarCO({ userCount: 15, reloj: { modalidad: "arriendo", cantidad: 1 }, puntos: [{ ubicacion: "Bogotá", zona: "capital", autoInstalada: true }] })
  assert.equal(co.pagoInicialNeto, 15 * 13700 + 86000)
  const mx = cotizarMX({ userCount: 10, reloj: { modalidad: "arriendo", cantidad: 1 }, puntos: [{ ubicacion: "Coyoacán", zona: "cdmx_metro", autoInstalada: true }] })
  assert.equal(mx.pagoInicialNeto, 1200 + 350)
})

test("el envío en venta se cobra por punto y el detalle del pago inicial nombra lo que incluye", () => {
  const co = cotizarCO({ userCount: 5, reloj: { modalidad: "venta", cantidad: 2 }, puntos: [{ ubicacion: "Medellín", zona: "resto", autoInstalada: true }, { ubicacion: "Cali", zona: "resto", autoInstalada: true }] })
  assert.equal(co.itemsCotizador.filter((i) => i.id === "envio_reloj").reduce((s, i) => s + i.subtotalCOP, 0), 2 * 69000)
  assert.ok(co.mensajeParaProspecto.includes("(equipo con IVA y envío)"))
  // Instalación cobrada con alquiler: el pago inicial no dice "equipo".
  const co2 = cotizarCO({ userCount: 5, reloj: { modalidad: "arriendo", cantidad: 1 }, puntos: [{ ubicacion: "Tunja", zona: "intermedia", autoInstalada: false }] })
  assert.ok(co2.mensajeParaProspecto.includes("Se suma un pago inicial único de $530.000 (instalación)."))
})

test("unirPartes: coma, 'y' y 'e' ante i", () => {
  assert.equal(unirPartes(["reloj"]), "reloj")
  assert.equal(unirPartes(["reloj", "envío"]), "reloj y envío")
  assert.equal(unirPartes(["reloj", "envío", "instalación"]), "reloj, envío e instalación")
})
