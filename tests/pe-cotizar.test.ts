/**
 * Motor de cotización PERÚ — lista 17-sep (decisiones de Lalo): plan de
 * Mónica con piso de 10 (1-10 S/55 fijo · 11+ S/5,5 por persona), reloj en
 * USD (arriendo 24 · venta 90) convertido a soles con el dólar SUNAT, y
 * descuento = escalera chilena (10 → 20 % en el plan, 6 meses).
 *
 * Ancla: 15 personas + reloj arriendo Lima con TC 3,372 = S/82,5 + S/67 =
 * S/149,50 neto → S/176,41/mes con IGV (al cliente: "S/149.50 + IGV"); con el 20 % del plan S/133 + IGV.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { cotizarPE, precioPlanPE, formatearPEN, tarifasRelojPE } from "../lib/paises/pe/cotizar.ts"
import { parsearTxtSunat, usdASoles } from "../lib/paises/pe/tc-sunat.ts"

const TC = 3.372 // dólar venta SUNAT del 17-sep-2026
import { rucValido } from "../lib/rut.ts"
import { PERFIL_PE } from "../lib/paises/pe/index.ts"

test("ejemplo confirmado por Lalo: 15p + reloj arriendo Lima (instalación bonificada)", () => {
  const r = cotizarPE({
    userCount: 15,
    reloj: { modalidad: "arriendo", cantidad: 1 },
    // Arriendo en Lima: la visita técnica va INCLUIDA (regla chilena del arriendo en RM).
    puntos: [{ ubicacion: "Miraflores", zona: "lima", autoInstalada: false }],
    tipoCambio: TC,
  })
  assert.equal(r.mensualNeto, 149.5) // 15 × 5,5 = 82,5 + arriendo 67 (US$20 × 3,372)
  assert.equal(Math.round(r.mensualTotal * 100) / 100, 176.41) // +IGV 18% (para el cotizador)
  assert.ok(r.mensajeParaProspecto.includes("S/149.50 + IGV")) // al cliente: neto + IGV
  assert.ok(!r.mensajeParaProspecto.includes("IGV incluido"))
  assert.equal(r.avisoSsttPeru, true) // pidió la visita: sstt la coordina (ya cotizada, bonificada)
  assert.ok(r.mensajeParaProspecto.includes("La instalación por nuestro equipo técnico va incluida sin costo (arriendo en Lima Metropolitana)"))
  const inst = r.itemsCotizador.find((i) => i.id === "instalacion_reloj")
  assert.ok(inst && inst.descuentoPct === 100 && inst.subtotalPEN === 0 && inst.precioUnitarioPEN === 145) // US$43 × 3,372 = 145
  // Sin descuento, el pago inicial es el primer mes por adelantado (sin únicos).
  assert.equal(Math.round(r.pagoInicialTotal * 100) / 100, 176.41)
  assert.equal(r.tipoCambio, TC)
  // El plan viaja al cotizador a precio de LISTA (el % va aparte).
  const plan = r.itemsCotizador.find((i) => i.id === "plan_asistencia")
  assert.equal(plan?.subtotalPEN, 82.5)
  assert.equal(plan?.modalidad, "Por usuario")
})

test("reloj en soles = USD × dólar SUNAT, redondeado a soles enteros", () => {
  assert.deepEqual(tarifasRelojPE(TC), { relojArriendoMes: 67, relojVenta: 303, relojArriendoMesProvincia: 78, envioVentaProvincia: 101, instalacionLima: 145, instalacionProvincias: 722, tipoCambio: TC })
  assert.equal(usdASoles(24, 3.5), 84)
  // Sin tipo de cambio válido cae al fallback (nunca lanza).
  assert.ok(tarifasRelojPE(NaN).relojArriendoMes > 0)
  assert.deepEqual(parsearTxtSunat("17/09/2026|3.361|3.372|\n"), { fecha: "2026-09-17", compra: 3.361, venta: 3.372 })
  assert.equal(parsearTxtSunat("basura"), null)
})

test("instalación = Chile: arriendo Lima bonificada en cualquier distrito; venta Lima US$43 cobrada si la piden", () => {
  // Comas en arriendo: antes tarifario por distrito (US$50 aparte); ahora incluida.
  const r = cotizarPE({
    userCount: 10,
    reloj: { modalidad: "arriendo", cantidad: 1 },
    puntos: [{ ubicacion: "Comas", zona: "lima", autoInstalada: false }],
    tipoCambio: TC,
  })
  assert.equal(r.avisoSsttPeru, true)
  assert.ok(r.mensajeParaProspecto.includes("va incluida sin costo (arriendo en Lima Metropolitana)"))
  assert.ok(!r.mensajeParaProspecto.includes("factura aparte") && !r.mensajeParaProspecto.includes("US$"))
  assert.equal(r.pagoInicialNeto, 122) // plan 55 (piso) + arriendo 67: la bonificada no suma
  // Venta en Lima con visita pedida: S/145 como pago único (US$43 × 3,372).
  const v = cotizarPE({
    userCount: 10,
    reloj: { modalidad: "venta", cantidad: 1 },
    puntos: [{ ubicacion: "Breña", zona: "lima", autoInstalada: false }],
    tipoCambio: TC,
  })
  assert.ok(v.mensajeParaProspecto.includes("tiene un costo único de S/145 + IGV"))
  assert.equal(v.pagoInicialNeto, 303 + 145 + 55)
  const inst = v.itemsCotizador.find((i) => i.id === "instalacion_reloj")
  assert.ok(inst && inst.subtotalPEN === 145 && inst.descuentoPct === undefined)
  // Venta en Lima sin pedirla: autoinstalable + oferta con precio (frase chilena).
  const auto = cotizarPE({
    userCount: 10,
    reloj: { modalidad: "venta", cantidad: 1 },
    puntos: [{ ubicacion: "San Isidro", zona: "lima", autoInstalada: true }],
    tipoCambio: TC,
  })
  assert.equal(auto.avisoSsttPeru, false)
  assert.ok(auto.mensajeParaProspecto.includes("El reloj es autoinstalable. Si prefieres que nosotros lo instalemos, tiene un costo único adicional de S/145 + IGV."))
  assert.ok(!auto.itemsCotizador.some((i) => i.id === "instalacion_reloj"))
})

test("instalación en provincia: precio cerrado US$214 (5 UF chilenas), nunca 'se cotiza aparte'", () => {
  const r = cotizarPE({
    userCount: 10,
    reloj: { modalidad: "arriendo", cantidad: 1 },
    puntos: [{ ubicacion: "Cusco", zona: "provincias", autoInstalada: true }],
    tipoCambio: TC,
  })
  assert.ok(r.mensajeParaProspecto.includes("costo único adicional de S/722 + IGV")) // US$214 × 3,372 = 721,6 → 722
  assert.ok(!/cotiza aparte|confirmar[aá] si tiene costo/.test(r.mensajeParaProspecto))
  const p = cotizarPE({
    userCount: 10,
    reloj: { modalidad: "venta", cantidad: 1 },
    puntos: [{ ubicacion: "Cusco", zona: "provincias", autoInstalada: false }],
    tipoCambio: TC,
  })
  assert.equal(p.avisoSsttPeru, true)
  assert.equal(p.pagoInicialNeto, 303 + 101 + 722 + 55) // reloj + envío + instalación + primer mes
  assert.ok(p.mensajeParaProspecto.includes("Se suma un pago inicial único de S/1,126 + IGV.") || p.mensajeParaProspecto.includes("Se suma un pago inicial único de S/1126 + IGV."))
})

test("descuento = Chile: escalera 10 → 20 % SOLO sobre el plan, 6 meses", () => {
  const base = { userCount: 15, reloj: { modalidad: "arriendo" as const, cantidad: 1 }, tipoCambio: TC }
  const e2 = cotizarPE({ ...base, escalonDescuento: 2 })
  // Plan 82,5 × 0,8 = 66 + arriendo 67 (sin descuento) = 133 → ×1,18 = 156,94
  assert.equal(e2.descuentoPct, 0.2)
  assert.equal(Math.round(e2.mensualTotalConDescuento * 100) / 100, 156.94)
  // El primer mes del pago inicial YA va con el descuento (es parte de los 6).
  assert.equal(Math.round(e2.pagoInicialTotal * 100) / 100, 156.94) // (66 + 67) × 1,18
  assert.ok(e2.mensajeParaProspecto.includes("20% de descuento en el plan durante 6 meses"))
  assert.ok(e2.mensajeParaProspecto.includes("desde el mes 7"))
  // Escalón 1 = 10 %: 74,25 + 67 = 141,25 → 166,675 con IGV.
  const e1 = cotizarPE({ ...base, escalonDescuento: 1 })
  assert.equal(e1.descuentoPct, 0.1)
  assert.ok(Math.abs(e1.mensualTotalConDescuento - 166.675) < 0.001)
  // Sobre el tope se recorta al tope; 0 u omitido = sin descuento.
  assert.equal(cotizarPE({ ...base, escalonDescuento: 5 }).escalonDescuento, 2)
  assert.equal(cotizarPE(base).descuentoPct, 0)
  assert.equal(cotizarPE(base).mensualTotalConDescuento, 0)
})

test("lista de Mónica con piso de 10: 1-10 S/55 fijo · 11+ S/5,5 por persona", () => {
  assert.equal(precioPlanPE(1), 55) // piso: una persona paga lo mismo que 10
  assert.equal(precioPlanPE(5), 55)
  assert.equal(precioPlanPE(10), 55)
  assert.equal(precioPlanPE(11), 60.5) // 11 × 5,5: sube parejo, sin salto
  assert.equal(precioPlanPE(20), 110)
  assert.equal(precioPlanPE(50), 275)
  assert.throws(() => precioPlanPE(51)) // sobre 50 no cotiza Vicky
})

test("provincia en VENTA: envío US$30 e instalación US$214 como líneas únicas (Lalo 22-sep)", () => {
  const r = cotizarPE({
    userCount: 10,
    reloj: { modalidad: "venta", cantidad: 1 },
    puntos: [{ ubicacion: "Arequipa", zona: "provincias", autoInstalada: false }],
    tipoCambio: TC,
  })
  assert.equal(r.avisoSsttPeru, true)
  // Murió la nota "el envío corre por cuenta del cliente": ahora tiene precio.
  assert.ok(!r.mensajeParaProspecto.includes("corre por cuenta del cliente"))
  // Al cliente (doble valor) el envío va dentro del pago inicial; el desglose por línea vive en `lineas`.
  assert.ok(r.mensajeParaProspecto.includes("Se suma un pago inicial único de S/1,126 + IGV.") || r.mensajeParaProspecto.includes("Se suma un pago inicial único de S/1126 + IGV."))
  assert.ok(r.lineas.some((l) => /^Envío de reloj a Arequipa$/.test(l.concepto) && l.neto === 101)) // US$30 × 3,372 = 101,16 → 101
  // Pago único = reloj (US$90 × 3,372 = 303) + envío 101 + instalación pedida en provincia 722 + primer mes (55).
  assert.equal(r.pagoInicialNeto, 459 + 722)
  const envio = r.itemsCotizador.find((i) => i.id === "envio_reloj")
  assert.ok(envio && envio.tipo === "servicio" && envio.modalidad === "Cobro único" && envio.subtotalPEN === 101)
  const inst = r.itemsCotizador.find((i) => i.id === "instalacion_reloj")
  assert.ok(inst && inst.subtotalPEN === 722 && inst.modalidad === "Cobro único")
})

test("provincia en ARRIENDO: tarifa US$23/mes con despacho incluido, sin línea de envío", () => {
  const r = cotizarPE({
    userCount: 10,
    reloj: { modalidad: "arriendo", cantidad: 2 },
    puntos: [
      { ubicacion: "Miraflores", zona: "lima", autoInstalada: true },
      { ubicacion: "Piura", zona: "provincias", autoInstalada: true },
    ],
    tipoCambio: TC,
  })
  // 1 reloj Lima (US$20 → 67) + 1 reloj provincia (US$23 → 78) = 145; plan 55.
  assert.equal(r.mensualArriendoNeto, 145)
  assert.equal(r.mensualNeto, 200)
  assert.ok(r.mensajeParaProspecto.includes("El envío del reloj va incluido"))
  assert.ok(r.lineas.some((l) => l.concepto === "Arriendo de reloj de control" && /a provincia \(despacho incluido\)/.test(l.detalle)))
  assert.ok(!r.mensajeParaProspecto.includes("corre por cuenta del cliente"))
  assert.equal(r.avisoSsttPeru, false)
  assert.ok(!r.itemsCotizador.some((i) => i.id === "envio_reloj"))
  const arriendos = r.itemsCotizador.filter((i) => i.id === "reloj_pe")
  assert.equal(arriendos.length, 2)
  assert.deepEqual(arriendos.map((i) => i.precioUnitarioPEN), [67, 78])
})

test("RUC peruano: el de la entidad valida; basuras no", () => {
  assert.equal(rucValido("20605842055"), true) // GEOVICTORIA PERU S.A.C.
  assert.equal(rucValido("20605842056"), false) // dígito verificador malo
  assert.equal(rucValido("12345678901"), false) // prefijo inválido
  assert.equal(PERFIL_PE.validarTributario("20605842055").valido, true)
  assert.equal(PERFIL_PE.validarTributario("20605842055").etiqueta, "RUC")
})

test("formato PEN: 2 decimales solo con fracción", () => {
  assert.equal(formatearPEN(149.5), "S/149.50")
  assert.equal(formatearPEN(270), "S/270")
  assert.equal(formatearPEN(156.94), "S/156.94")
})
