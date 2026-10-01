/**
 * Motor de cotización MÉXICO — envío e instalación con la regla de Chile
 * (propuesta aprobada por Lalo 22-sep): tres zonas (CDMX-ZM / corona de
 * estados / resto), renta fuera de la base con envío incluido, instalación
 * bonificada en renta en la base.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { cotizarMX, TARIFAS_MX } from "../lib/paises/mx/cotizar.ts"
import { clasificarUbicacionMX } from "../lib/paises/mx/geografia.ts"

test("geografía MX: tres zonas; CDMX y conurbados = base; Toluca/Cuernavaca/Puebla = intermedia; Guadalajara = resto", () => {
  assert.equal(clasificarUbicacionMX("Ciudad de México").zona, "cdmx_metro")
  assert.equal(clasificarUbicacionMX("Ecatepec").zona, "cdmx_metro")
  assert.equal(clasificarUbicacionMX("Toluca").zona, "intermedia")
  assert.equal(clasificarUbicacionMX("Cuernavaca").zona, "intermedia")
  assert.equal(clasificarUbicacionMX("Puebla").zona, "intermedia")
  assert.equal(clasificarUbicacionMX("Querétaro").zona, "intermedia")
  assert.equal(clasificarUbicacionMX("Guadalajara").zona, "resto")
  assert.equal(clasificarUbicacionMX("Monterrey").reconocida, true)
  assert.equal(clasificarUbicacionMX("rancho x").reconocida, false)
})

test("renta en CDMX: $350 + instalación bonificada; renta en Guadalajara: $400 con envío y visita opcional a $4,000", () => {
  const base = cotizarMX({
    userCount: 15,
    reloj: { modalidad: "arriendo", cantidad: 1 },
    puntos: [{ ubicacion: "Coyoacán", zona: "cdmx_metro", autoInstalada: true }],
  })
  assert.equal(base.mensualArriendoNeto, 350)
  assert.ok(base.mensajeParaProspecto.includes("va incluida sin costo (renta en CDMX y Zona Metropolitana)"))
  const inst = base.itemsCotizador.find((i) => i.id === "instalacion_reloj")
  assert.ok(inst && inst.descuentoPct === 100 && inst.subtotalMXN === 0 && inst.precioUnitarioMXN === 800)
  const fuera = cotizarMX({
    userCount: 15,
    reloj: { modalidad: "arriendo", cantidad: 1 },
    puntos: [{ ubicacion: "Guadalajara", zona: "resto", autoInstalada: true }],
  })
  assert.equal(fuera.mensualArriendoNeto, TARIFAS_MX.relojArriendoMesFuera)
  assert.match(fuera.mensajeParaProspecto, /autoinstalables?\. Si prefieres que nosotros lo[s]? instalemos, tiene un costo único adicional de /) // alternativa con precio, fuera de los totales (= Chile, 28-sep)
  assert.ok(fuera.mensajeParaProspecto.includes("$4,000"))
  assert.ok(!/cotiza aparte/.test(fuera.mensajeParaProspecto))
  assert.ok(!fuera.itemsCotizador.some((i) => i.id === "envio_reloj" || i.id === "instalacion_reloj"))
})

test("venta en Toluca (intermedia) con visita pedida: envío $560 + instalación $2,400 + primer mes (24-sep)", () => {
  const r = cotizarMX({
    userCount: 10,
    reloj: { modalidad: "venta", cantidad: 1 },
    puntos: [{ ubicacion: "Toluca", zona: "intermedia", autoInstalada: false }],
  })
  const envio = r.itemsCotizador.find((i) => i.id === "envio_reloj")
  const inst = r.itemsCotizador.find((i) => i.id === "instalacion_reloj")
  assert.ok(envio && envio.subtotalMXN === 560)
  assert.ok(inst && inst.subtotalMXN === 2400 && inst.descuentoPct === undefined)
  // reloj 2,100 + envío 560 + instalación 2,400 (capacitación en 0) + primer
  // mes del plan ($499 fijo de 3 a 10) — patrón CL/PE/CO desde el 24-sep.
  assert.equal(r.pagoInicialNeto, 2100 + 560 + 2400 + 499)
  // Forma de Chile (28-sep): la visita pedida "va incluida en el pago inicial" y su monto va en el pago inicial.
  assert.ok(r.mensajeParaProspecto.includes("En este caso la instalación por nuestro equipo técnico va incluida en el pago inicial."))
  assert.ok(r.mensajeParaProspecto.includes("Se suma un pago inicial único de $5,060 + IVA."))
})

test("venta en CDMX sin visita: envío $400 y la visita se ofrece a $800", () => {
  const r = cotizarMX({
    userCount: 10,
    reloj: { modalidad: "venta", cantidad: 1 },
    puntos: [{ ubicacion: "Iztapalapa", zona: "cdmx_metro", autoInstalada: true }],
  })
  const envio = r.itemsCotizador.find((i) => i.id === "envio_reloj")
  assert.ok(envio && envio.subtotalMXN === 400)
  assert.match(r.mensajeParaProspecto, /autoinstalables?\. Si prefieres que nosotros lo[s]? instalemos, tiene un costo único adicional de /) // alternativa con precio, fuera de los totales (= Chile, 28-sep)
  assert.ok(r.mensajeParaProspecto.includes("$800"))
  assert.equal(r.pagoInicialNeto, 2500 + 499)
})

test("lista del 01-oct: 1-2 $229 fijo · 3-10 $499 fijo · 11-20 $49 por persona", () => {
  assert.equal(cotizarMX({ userCount: 1 }).mensualNetoPlan, 229)
  assert.equal(cotizarMX({ userCount: 2 }).mensualNetoPlan, 229)
  assert.equal(cotizarMX({ userCount: 3 }).mensualNetoPlan, 499)
  assert.equal(cotizarMX({ userCount: 10 }).mensualNetoPlan, 499)
  assert.equal(cotizarMX({ userCount: 11 }).mensualNetoPlan, 11 * 49) // $539: no baja al pasar de 10 a 11
  assert.equal(cotizarMX({ userCount: 20 }).mensualNetoPlan, 980)
  const item = cotizarMX({ userCount: 8 }).itemsCotizador.find((i) => i.id === "plan_asistencia")
  assert.ok(item && item.modalidad === "Fijo" && item.subtotalMXN === 499)
})

test("descuento = Chile: 10 % → 20 % solo en el plan, 6 meses; la formal va a lista", () => {
  const r = cotizarMX({
    userCount: 16,
    reloj: { modalidad: "arriendo", cantidad: 1 },
    puntos: [{ ubicacion: "CDMX", zona: "cdmx_metro", autoInstalada: true }],
    escalonDescuento: 1,
  })
  assert.equal(r.descuentoPct, 0.1)
  assert.equal(r.mensualNetoPlan, 705.6) // 16 × 49 = 784 × 0,9
  assert.equal(r.mensualArriendoNeto, 350) // la renta no baja
  assert.ok(r.mensajeParaProspecto.includes("$1,055.60 + IVA al mes"))
  assert.ok(r.mensajeParaProspecto.includes("2.- Una alternativa más económica"))
  const plan = r.itemsCotizador.find((i) => i.id === "plan_asistencia")
  assert.equal(plan?.subtotalMXN, 16 * 49)
  assert.equal(cotizarMX({ userCount: 5, escalonDescuento: 2 }).mensualNetoPlan, 399.2) // 499 × 0,8
  assert.equal(cotizarMX({ userCount: 5, escalonDescuento: 9 }).descuentoPct, 0.2)
})

test("solo software: sin pagos únicos no se habla de pago inicial y el primer pago es la mensualidad", () => {
  const r = cotizarMX({ userCount: 8 })
  assert.ok(!/pago inicial/i.test(r.mensajeParaProspecto))
  assert.equal(r.pagoInicialNeto, 499)
  assert.ok(!/= \$/.test(r.mensajeParaProspecto)) // sin aritmética del IVA
})
