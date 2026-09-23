/**
 * Motor de cotización COLOMBIA — envío e instalación con la regla de Chile
 * (propuesta aprobada por Lalo 22-sep): tres zonas (Bogotá y alrededores /
 * Cundinamarca-Boyacá-Tolima-Meta / resto), alquiler fuera de la base con
 * despacho incluido, instalación bonificada en alquiler en la base.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { cotizarCO, TARIFAS_CO, precioPlanCO } from "../lib/paises/co/cotizar.ts"
import { clasificarUbicacionCO } from "../lib/paises/co/geografia.ts"

test("geografía CO: tres zonas; Bogotá y conurbados = base; Medellín/Cali = resto", () => {
  assert.equal(clasificarUbicacionCO("Bogotá").zona, "capital")
  assert.equal(clasificarUbicacionCO("Soacha").zona, "capital")
  assert.equal(clasificarUbicacionCO("Chía, Cundinamarca").zona, "capital") // la base gana sobre el departamento
  assert.equal(clasificarUbicacionCO("Ibagué").zona, "intermedia")
  assert.equal(clasificarUbicacionCO("Villavicencio").zona, "intermedia")
  assert.equal(clasificarUbicacionCO("Tunja").zona, "intermedia")
  assert.equal(clasificarUbicacionCO("Medellín").zona, "resto")
  assert.equal(clasificarUbicacionCO("Cali").zona, "resto")
  assert.equal(clasificarUbicacionCO("Barranquilla").reconocida, true)
  assert.deepEqual(clasificarUbicacionCO("pueblito x"), { zona: "resto", reconocida: false, canonico: "pueblito x" })
})

test("alquiler en Bogotá: 86.000 + instalación técnica bonificada (línea a lista con descuentoPct 100)", () => {
  const r = cotizarCO({
    userCount: 15,
    reloj: { modalidad: "arriendo", cantidad: 1 },
    puntos: [{ ubicacion: "Bogotá", zona: "capital", autoInstalada: true }],
  })
  assert.equal(r.mensualArriendoNeto, 86000)
  assert.ok(r.mensajeParaProspecto.includes("va incluida sin costo (alquiler en Bogotá y alrededores); si prefieres, el equipo también es autoinstalable"))
  const inst = r.itemsCotizador.find((i) => i.id === "instalacion_reloj")
  assert.ok(inst && inst.descuentoPct === 100 && inst.subtotalCOP === 0 && inst.precioUnitarioCOP === TARIFAS_CO.instalacion.capital)
  // La bonificada no suma al pago inicial: solo la activación (un mes del plan).
  assert.equal(r.pagoInicialNeto, 15 * 13700)
  assert.ok(!r.itemsCotizador.some((i) => i.id === "envio_reloj"))
})

test("alquiler en Medellín (resto): 98.000 con despacho, sin línea de envío, visita técnica opcional a 875.000", () => {
  const r = cotizarCO({
    userCount: 15,
    reloj: { modalidad: "arriendo", cantidad: 1 },
    puntos: [{ ubicacion: "Medellín", zona: "resto", autoInstalada: true }],
  })
  assert.equal(r.mensualArriendoNeto, TARIFAS_CO.relojArriendoMesFuera)
  assert.ok(r.mensajeParaProspecto.includes("El equipo es autoinstalable. Si prefieres que nosotros lo instalemos, tiene un costo único adicional de $875.000."))
  assert.ok(!r.itemsCotizador.some((i) => i.id === "envio_reloj" || i.id === "instalacion_reloj"))
  assert.ok(!/cotiza aparte/.test(r.mensajeParaProspecto))
})

test("venta en Ibagué (intermedia) con visita pedida: envío 69.000 + instalación 530.000 como pagos únicos", () => {
  const r = cotizarCO({
    userCount: 10,
    reloj: { modalidad: "venta", cantidad: 1 },
    puntos: [{ ubicacion: "Ibagué", zona: "intermedia", autoInstalada: false }],
  })
  const envio = r.itemsCotizador.find((i) => i.id === "envio_reloj")
  const inst = r.itemsCotizador.find((i) => i.id === "instalacion_reloj")
  assert.ok(envio && envio.subtotalCOP === TARIFAS_CO.envioVenta.fuera)
  assert.ok(inst && inst.subtotalCOP === TARIFAS_CO.instalacion.intermedia && inst.descuentoPct === undefined)
  // Pago inicial = activación (315.000) + equipo 620.000 (+IVA aparte) + envío 69.000 + instalación 530.000.
  assert.equal(r.pagoInicialNeto, 315000 + 620000 + 69000 + 530000)
  assert.ok(r.mensajeParaProspecto.includes("tiene un costo único de $530.000 (va en el pago inicial)"))
})

test("venta en Bogotá sin visita: envío 42.000 y la visita se ofrece a 175.000", () => {
  const r = cotizarCO({
    userCount: 10,
    reloj: { modalidad: "venta", cantidad: 2 },
    puntos: [
      { ubicacion: "Bogotá", zona: "capital", autoInstalada: true },
      { ubicacion: "Bogotá", zona: "capital", autoInstalada: true },
    ],
  })
  const envio = r.itemsCotizador.find((i) => i.id === "envio_reloj")
  assert.ok(envio && envio.cantidad === 2 && envio.subtotalCOP === 2 * TARIFAS_CO.envioVenta.capital)
  assert.ok(r.mensajeParaProspecto.includes("costo único adicional de $175.000"))
  assert.ok(!r.itemsCotizador.some((i) => i.id === "instalacion_reloj"))
})

// ── FORMA DE PRECIO DE CHILE + DOBLE VALOR (Lalo 23-sep, "cerremos Colombia") ──
test("solo app: sin 'pago inicial' (la Activación es el primer mes), sin aritmética de IVA", () => {
  const r = cotizarCO({ userCount: 15 })
  assert.ok(r.mensajeParaProspecto.includes("Resumen mensual recurrente:"))
  assert.ok(r.mensajeParaProspecto.includes("Total mensual: $205.500"))
  assert.ok(!/pago inicial/i.test(r.mensajeParaProspecto))
  assert.ok(!/\+ IVA =/.test(r.mensajeParaProspecto))
  assert.ok(!/Qué opción prefieres/.test(r.mensajeParaProspecto))
})

test("con equipo en alquiler: doble valor (equipo + app vs solo app) y cierre presuntivo", () => {
  const r = cotizarCO({
    userCount: 15,
    reloj: { modalidad: "arriendo", cantidad: 1 },
    puntos: [{ ubicacion: "Bogotá", zona: "capital", autoInstalada: true }],
    escalonDescuento: 1,
  })
  const m = r.mensajeParaProspecto
  assert.ok(m.includes("1 - Para 15 personas te recomiendo Equipo biométrico en alquiler + App:"))
  assert.ok(m.includes("💰 $287.290 al mes (incluye el IVA del equipo)."))
  assert.ok(m.includes("2.- Una alternativa más económica sería si marcan solo mediante nuestra app:"))
  assert.ok(m.includes("💰 $184.950 al mes."))
  assert.ok(m.includes("Incluye el 10% de descuento en el plan durante 6 meses (desde el mes 7, $307.840 al mes)."))
  assert.ok(m.trim().endsWith("Qué opción prefieres? Con la que elijas te genero la cotización formal de inmediato."))
  assert.ok(!/pago inicial/i.test(m))
  assert.ok(!/\+ IVA =/.test(m) && !/Pago inicial \(una sola vez\)/.test(m))
})

test("con equipo en compra: misma mensualidad en las dos opciones → encabezado 'sin desembolso inicial' y pago único aparte", () => {
  const r = cotizarCO({
    userCount: 10,
    reloj: { modalidad: "venta", cantidad: 1 },
    puntos: [{ ubicacion: "Ibagué", zona: "intermedia", autoInstalada: false }],
  })
  const m = r.mensajeParaProspecto
  assert.ok(m.includes("Equipo biométrico en compra + App"))
  // 620.000 × 1,19 + 69.000 + 530.000 = 1.336.800 (sin la Activación, que es el primer mes)
  assert.ok(m.includes("Se suma un pago inicial único de $1.336.800 (equipo con IVA, envío e instalación)."))
  assert.ok(m.includes("2.- Si prefieres partir sin desembolso inicial, marcando solo con nuestra app (misma mensualidad, sin el pago único):"))
  assert.ok(!/más económica/.test(m))
  // El retorno para el cotizador sigue trayendo la Activación dentro del pago inicial.
  assert.equal(r.pagoInicialNeto, 315000 + 620000 + 69000 + 530000)
})

// ── PRECIOS CO desde el catálogo (23-sep: la rebaja a la mitad se revirtió; el precio vive solo en el catálogo) ──
test("precios CO: 1-10 $315.000 fijo · 11-20 $13.700/persona; el motor no lleva literales", () => {
  assert.equal(precioPlanCO(1), 315000)
  assert.equal(precioPlanCO(10), 315000)
  assert.equal(precioPlanCO(11), 11 * 13700)
  assert.equal(precioPlanCO(20), 20 * 13700)
  assert.equal(precioPlanCO(21), 21 * 13700)
  const r = cotizarCO({ userCount: 12 })
  const plan = r.itemsCotizador.find((i) => i.id === "plan_asistencia")
  assert.ok(plan && plan.precioUnitarioCOP === 13700 && plan.subtotalCOP === 12 * 13700)
  assert.ok(r.mensajeParaProspecto.includes("Control de Asistencia (12 usuarios): $164.400/mes"))
  assert.equal(r.mensualTotal, 12 * 13700)
})
