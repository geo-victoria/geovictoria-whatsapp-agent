/**
 * Motor de cotización PERÚ — lista 17-sep (decisiones de Lalo): plan de
 * Mónica con piso de 10 (1-10 S/55 fijo · 11+ S/5,5 por persona), reloj en
 * USD (arriendo 24 · venta 90) convertido a soles con el dólar SUNAT, y
 * descuento = escalera chilena (10 → 20 % en el plan, 6 meses).
 *
 * Ancla: 15 personas + reloj arriendo Lima con TC 3,372 = S/82,5 + S/81 =
 * S/163,50 neto → S/192,93/mes con IGV; con el 20 % del plan S/173,46.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { cotizarPE, precioPlanPE, formatearPEN, tarifasRelojPE } from "../lib/paises/pe/cotizar.ts"
import { parsearTxtSunat, usdASoles } from "../lib/paises/pe/tc-sunat.ts"

const TC = 3.372 // dólar venta SUNAT del 17-sep-2026
import { rucValido } from "../lib/rut.ts"
import { PERFIL_PE } from "../lib/paises/pe/index.ts"

test("ejemplo confirmado por Lalo: 15p + reloj arriendo Lima (zona azul)", () => {
  const r = cotizarPE({
    userCount: 15,
    reloj: { modalidad: "arriendo", cantidad: 1 },
    // Miraflores = zona azul del tarifario 11-ago: instalación sin costo.
    puntos: [{ ubicacion: "Miraflores", zona: "lima", autoInstalada: false }],
    tipoCambio: TC,
  })
  assert.equal(r.mensualNeto, 163.5) // 15 × 5,5 = 82,5 + arriendo 81 (US$24 × 3,372)
  assert.equal(Math.round(r.mensualTotal * 100) / 100, 192.93) // +IGV 18%
  assert.ok(r.mensajeParaProspecto.includes("S/192.93"))
  assert.equal(r.avisoSsttPeru, false) // zona azul: instalación incluida, sin aviso
  // Sin descuento, el pago inicial es el primer mes por adelantado (sin únicos).
  assert.equal(Math.round(r.pagoInicialTotal * 100) / 100, 192.93)
  assert.equal(r.tipoCambio, TC)
  // El plan viaja al cotizador a precio de LISTA (el % va aparte).
  const plan = r.itemsCotizador.find((i) => i.id === "plan_asistencia")
  assert.equal(plan?.subtotalPEN, 82.5)
  assert.equal(plan?.modalidad, "Por usuario")
})

test("reloj en soles = USD × dólar SUNAT, redondeado a soles enteros", () => {
  assert.deepEqual(tarifasRelojPE(TC), { relojArriendoMes: 81, relojVenta: 303, tipoCambio: TC })
  assert.equal(usdASoles(24, 3.5), 84)
  // Sin tipo de cambio válido cae al fallback (nunca lanza).
  assert.ok(tarifasRelojPE(NaN).relojArriendoMes > 0)
  assert.deepEqual(parsearTxtSunat("17/09/2026|3.361|3.372|\n"), { fecha: "2026-09-17", compra: 3.361, venta: 3.372 })
  assert.equal(parsearTxtSunat("basura"), null)
})

test("tarifario Lima 11-ago: distrito tarifado → nota US$ + IGV y aviso a sstt, sin línea de cobro", () => {
  const r = cotizarPE({
    userCount: 10,
    reloj: { modalidad: "arriendo", cantidad: 1 },
    puntos: [{ ubicacion: "Comas", zona: "lima", autoInstalada: false }],
    tipoCambio: TC,
  })
  assert.equal(r.avisoSsttPeru, true)
  assert.ok(r.mensajeParaProspecto.includes("US$50 + IGV"))
  assert.ok(r.mensajeParaProspecto.includes("factura aparte"))
  // La tarifa de la visita JAMÁS entra al checkout: pago inicial = primer mes.
  assert.equal(r.pagoInicialNeto, 136) // plan 55 (piso) + arriendo 81
  assert.ok(!r.itemsCotizador.some((i) => /instalacion|visita/i.test(i.id)))

  // Breña (con ñ, zona aguamarina): la normalización NFD debe calzar.
  const b = cotizarPE({
    userCount: 10,
    reloj: { modalidad: "arriendo", cantidad: 1 },
    puntos: [{ ubicacion: "Breña", zona: "lima", autoInstalada: false }],
    tipoCambio: TC,
  })
  assert.ok(b.mensajeParaProspecto.includes("US$30 + IGV"))
})

test("tarifario Lima: distrito no reconocido → sstt confirma (sin prometer gratis); autoinstalación sin nota", () => {
  const generico = cotizarPE({
    userCount: 10,
    reloj: { modalidad: "arriendo", cantidad: 1 },
    puntos: [{ ubicacion: "Lima", zona: "lima", autoInstalada: false }],
    tipoCambio: TC,
  })
  assert.equal(generico.avisoSsttPeru, true)
  assert.ok(generico.mensajeParaProspecto.includes("te confirmará si tiene costo"))

  const auto = cotizarPE({
    userCount: 10,
    reloj: { modalidad: "arriendo", cantidad: 1 },
    puntos: [{ ubicacion: "Comas", zona: "lima", autoInstalada: true }],
    tipoCambio: TC,
  })
  assert.equal(auto.avisoSsttPeru, false)
  assert.ok(!auto.mensajeParaProspecto.includes("US$"))
})

test("descuento = Chile: escalera 10 → 20 % SOLO sobre el plan, 6 meses", () => {
  const base = { userCount: 15, reloj: { modalidad: "arriendo" as const, cantidad: 1 }, tipoCambio: TC }
  const e2 = cotizarPE({ ...base, escalonDescuento: 2 })
  // Plan 82,5 × 0,8 = 66 + arriendo 81 (sin descuento) = 147 → ×1,18 = 173,46
  assert.equal(e2.descuentoPct, 0.2)
  assert.equal(Math.round(e2.mensualTotalConDescuento * 100) / 100, 173.46)
  // El primer mes del pago inicial YA va con el descuento (es parte de los 6).
  assert.equal(Math.round(e2.pagoInicialTotal * 100) / 100, 173.46)
  assert.ok(e2.mensajeParaProspecto.includes("20% de descuento en el plan durante 6 meses"))
  assert.ok(e2.mensajeParaProspecto.includes("desde el mes 7"))
  // Escalón 1 = 10 %: 74,25 + 81 = 155,25 → 183,195 con IGV.
  const e1 = cotizarPE({ ...base, escalonDescuento: 1 })
  assert.equal(e1.descuentoPct, 0.1)
  assert.ok(Math.abs(e1.mensualTotalConDescuento - 183.195) < 0.001)
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

test("provincia: envío por cuenta del cliente + instalación aparte, sin líneas de cobro", () => {
  const r = cotizarPE({
    userCount: 10,
    reloj: { modalidad: "venta", cantidad: 1 },
    puntos: [{ ubicacion: "Arequipa", zona: "provincias", autoInstalada: false }],
    tipoCambio: TC,
  })
  assert.equal(r.avisoSsttPeru, true)
  // VB Diego 05-ago: el envío a provincia lo asume el CLIENTE — se informa.
  assert.ok(r.mensajeParaProspecto.includes("corre por cuenta del cliente"))
  assert.ok(r.mensajeParaProspecto.includes("servicio técnico"))
  // Pago único = solo el reloj (US$90 × 3,372 = 303) + primer mes (55): sin envío ni instalación.
  assert.equal(r.pagoInicialNeto, 358)
  // Ningún ítem de envío ni instalación viaja al cotizador.
  assert.ok(!r.itemsCotizador.some((i) => i.id === "envio_reloj" || i.id === "instalacion_reloj"))
})

test("RUC peruano: el de la entidad valida; basuras no", () => {
  assert.equal(rucValido("20605842055"), true) // GEOVICTORIA PERU S.A.C.
  assert.equal(rucValido("20605842056"), false) // dígito verificador malo
  assert.equal(rucValido("12345678901"), false) // prefijo inválido
  assert.equal(PERFIL_PE.validarTributario("20605842055").valido, true)
  assert.equal(PERFIL_PE.validarTributario("20605842055").etiqueta, "RUC")
})

test("formato PEN: 2 decimales solo con fracción", () => {
  assert.equal(formatearPEN(192.93), "S/192.93")
  assert.equal(formatearPEN(270), "S/270")
  assert.equal(formatearPEN(173.46), "S/173.46")
})
