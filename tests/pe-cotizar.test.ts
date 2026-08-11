/**
 * Motor de cotización PERÚ (Fase 1, excel Tropicalizacion_Vicky_2 04-ago).
 *
 * Ancla el ejemplo CONFIRMADO por Lalo (15 personas + reloj arriendo Lima =
 * S/270 neto → S/318.60/mes con IGV; con el 20% de cierre S/254.88 las
 * primeras 4 facturas), la anomalía aprobada del tramo 21+ y el RUC.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { cotizarPE, precioPlanPE, formatearPEN } from "../lib/paises/pe/cotizar.ts"
import { rucValido } from "../lib/rut.ts"
import { PERFIL_PE } from "../lib/paises/pe/index.ts"

test("ejemplo confirmado por Lalo: 15p + reloj arriendo Lima (zona azul)", () => {
  const r = cotizarPE({
    userCount: 15,
    reloj: { modalidad: "arriendo", cantidad: 1 },
    // Miraflores = zona azul del tarifario 11-ago: instalación sin costo.
    puntos: [{ ubicacion: "Miraflores", zona: "lima", autoInstalada: false }],
  })
  assert.equal(r.mensualNeto, 270) // 200 fijo (11-20) + 70 arriendo
  assert.equal(Math.round(r.mensualTotal * 100) / 100, 318.6) // +IGV 18%
  assert.ok(r.mensajeParaProspecto.includes("S/318.60"))
  assert.equal(r.avisoSsttPeru, false) // zona azul: instalación incluida, sin aviso
  // Sin descuento, el pago inicial es el primer mes por adelantado (sin únicos).
  assert.equal(Math.round(r.pagoInicialTotal * 100) / 100, 318.6)
})

test("tarifario Lima 11-ago: distrito tarifado → nota US$ + IGV y aviso a sstt, sin línea de cobro", () => {
  const r = cotizarPE({
    userCount: 10,
    reloj: { modalidad: "arriendo", cantidad: 1 },
    puntos: [{ ubicacion: "Comas", zona: "lima", autoInstalada: false }],
  })
  assert.equal(r.avisoSsttPeru, true)
  assert.ok(r.mensajeParaProspecto.includes("US$50 + IGV"))
  assert.ok(r.mensajeParaProspecto.includes("factura aparte"))
  // La tarifa de la visita JAMÁS entra al checkout: pago inicial = primer mes.
  assert.equal(r.pagoInicialNeto, 170) // plan 100 + arriendo 70
  assert.ok(!r.itemsCotizador.some((i) => /instalacion|visita/i.test(i.id)))

  // Breña (con ñ, zona aguamarina): la normalización NFD debe calzar.
  const b = cotizarPE({
    userCount: 10,
    reloj: { modalidad: "arriendo", cantidad: 1 },
    puntos: [{ ubicacion: "Breña", zona: "lima", autoInstalada: false }],
  })
  assert.ok(b.mensajeParaProspecto.includes("US$30 + IGV"))
})

test("tarifario Lima: distrito no reconocido → sstt confirma (sin prometer gratis); autoinstalación sin nota", () => {
  const generico = cotizarPE({
    userCount: 10,
    reloj: { modalidad: "arriendo", cantidad: 1 },
    puntos: [{ ubicacion: "Lima", zona: "lima", autoInstalada: false }],
  })
  assert.equal(generico.avisoSsttPeru, true)
  assert.ok(generico.mensajeParaProspecto.includes("te confirmará si tiene costo"))

  const auto = cotizarPE({
    userCount: 10,
    reloj: { modalidad: "arriendo", cantidad: 1 },
    puntos: [{ ubicacion: "Comas", zona: "lima", autoInstalada: true }],
  })
  assert.equal(auto.avisoSsttPeru, false)
  assert.ok(!auto.mensajeParaProspecto.includes("US$"))
})

test("descuento de cierre: 20% en las 4 primeras facturas (S/254.88)", () => {
  const r = cotizarPE({
    userCount: 15,
    reloj: { modalidad: "arriendo", cantidad: 1 },
    conDescuentoCierre: true,
  })
  assert.equal(Math.round(r.mensualTotalConDescuento * 100) / 100, 254.88)
  // El primer mes del pago inicial YA va con el 20% (es la primera factura).
  assert.equal(Math.round(r.pagoInicialTotal * 100) / 100, 254.88)
  assert.ok(r.mensajeParaProspecto.includes("4 primeras facturas"))
})

test("anomalía del excel aprobada: 21 usuarios pagan MENOS que 20", () => {
  assert.equal(precioPlanPE(20), 200) // tramo 11-20 fijo
  assert.equal(precioPlanPE(21), 105) // 21 × S/5 — literal del excel
  assert.equal(precioPlanPE(50), 250)
  assert.equal(precioPlanPE(5), 100) // tramo 1-10 fijo
})

test("provincia: envío por cuenta del cliente + instalación aparte, sin líneas de cobro", () => {
  const r = cotizarPE({
    userCount: 10,
    reloj: { modalidad: "venta", cantidad: 1 },
    puntos: [{ ubicacion: "Arequipa", zona: "provincias", autoInstalada: false }],
  })
  assert.equal(r.avisoSsttPeru, true)
  // VB Diego 05-ago: el envío a provincia lo asume el CLIENTE — se informa.
  assert.ok(r.mensajeParaProspecto.includes("corre por cuenta del cliente"))
  assert.ok(r.mensajeParaProspecto.includes("servicio técnico"))
  // Pago único = solo el reloj (525) + primer mes (100): sin envío ni instalación.
  assert.equal(r.pagoInicialNeto, 625)
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
  assert.equal(formatearPEN(318.6), "S/318.60")
  assert.equal(formatearPEN(270), "S/270")
  assert.equal(formatearPEN(254.88), "S/254.88")
})
