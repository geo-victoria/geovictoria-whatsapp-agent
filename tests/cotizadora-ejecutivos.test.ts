/**
 * PARIDAD CON LA CALCULADORA DE NACHO — casos calculados a mano desde los
 * valores tabla de gv-cotizador (transcritos 10-ago). Si un test de acá
 * falla, o se rompió el motor o alguien tocó el catálogo sin actualizar la
 * fuente: ambas cosas son incidente de precios.
 *
 * También vigila la FRONTERA (patrón onboarding): el motor es puro — sin
 * red, sin Supabase, sin imports fuera de su carpeta.
 */
import { test, describe } from "node:test"
import assert from "node:assert"
import { readFileSync } from "node:fs"
import { cotizarPropuesta, validarPropuesta, topePromoSf2a } from "../lib/cotizadora-ejecutivos/motor.ts"

describe("cotizadora-ejecutivos · paridad con la calculadora de Nacho", () => {
  test("caso Anderson: 80 usuarios + 5 SF2A arriendo + envío", () => {
    const r = cotizarPropuesta({
      usuarios: 80,
      equipos: [{ id: "senseface_2a", modalidad: "arriendo", cantidad: 5 }],
      serviciosAsociados: [{ id: "envio", zona: "rm", modalidad: "arriendo" }],
      instalacionPorCliente: true,
      firmante: "Anderson Diaz",
    })
    // Asistencia 51-100: 80 × 0,065 = 5,2 · SF2A: 5 × 0,35 = 1,75 → mensual 6,95
    assert.strictEqual(r.totalMensualUF, 6.95)
    // Envío arriendo RM = 0,5 pago único
    assert.strictEqual(r.totalPagoUnicoUF, 0.5)
    assert.strictEqual(validarPropuesta({
      usuarios: 80,
      equipos: [{ id: "senseface_2a", modalidad: "arriendo", cantidad: 5 }],
      serviciosAsociados: [{ id: "envio", zona: "rm", modalidad: "arriendo" }],
      instalacionPorCliente: true,
      firmante: "Anderson Diaz",
    }).length, 0)
  })

  test("tramo 1-10 es plan fijo 0,75 (lista de Nacho, NO la de Vicky)", () => {
    const r = cotizarPropuesta({ usuarios: 8, firmante: "x" })
    assert.strictEqual(r.totalMensualUF, 0.75)
  })

  test("15 usuarios: 15 × 0,09 = 1,35 (Nacho) — no los 0,07 de Vicky", () => {
    const r = cotizarPropuesta({ usuarios: 15, firmante: "x" })
    assert.strictEqual(r.totalMensualUF, 1.35)
  })

  test("descuento 30% se clampea a 25% con advertencia", () => {
    const r = cotizarPropuesta({ usuarios: 100, descuentoAsistenciaPct: 30, firmante: "x" })
    // 100 × 0,065 = 6,5 × 0,75 = 4,875
    assert.strictEqual(r.totalMensualUF, 4.875)
    assert.ok(r.advertencias.some((a) => a.includes("tope 25%")))
  })

  test("promo Asistencia+Addon = 1 UF (y Banco de Horas es inelegible)", () => {
    const conPromo = cotizarPropuesta({ usuarios: 8, promoAsistenciaAddon: "vacaciones", firmante: "x" })
    assert.strictEqual(conPromo.totalMensualUF, 1.0)
    assert.strictEqual(conPromo.lineas.length, 1)

    const banco = cotizarPropuesta({ usuarios: 8, promoAsistenciaAddon: "banco", addons: [{ id: "banco" }], firmante: "x" })
    // Promo rechazada: asistencia 0,75 + banco 8 × 0,05 = 0,4 → 1,15
    assert.strictEqual(banco.totalMensualUF, 1.15)
    assert.ok(banco.advertencias.some((a) => a.includes("Banco de Horas")))
  })

  test("promo SF2A capada por tramo (80 usuarios → 3 unidades a 0,30)", () => {
    assert.strictEqual(topePromoSf2a(80), 3)
    const r = cotizarPropuesta({
      usuarios: 80,
      equipos: [{ id: "senseface_2a", modalidad: "arriendo", cantidad: 5 }],
      promoSf2aUnidades: 5,
      envioExcluido: true,
      instalacionPorCliente: true,
      firmante: "x",
    })
    // Asistencia 5,2 + promo 3 × 0,30 = 0,9 + resto 2 × 0,35 = 0,7 → 6,8
    assert.strictEqual(r.totalMensualUF, 6.8)
    assert.ok(r.advertencias.some((a) => a.includes("tope 3")))
  })

  test("otros servicios: casino fijo por tramo y reporte con mínimo 5", () => {
    const r = cotizarPropuesta({
      usuarios: 80,
      otrosServicios: [{ id: "casino" }, { id: "reporte" }],
      firmante: "x",
    })
    // Asistencia 5,2 + casino 51-100 fijo 2,941 + reporte 80 × 0,01 = 0,8 → 8,941
    assert.strictEqual(r.totalMensualUF, 8.941)

    const chico = cotizarPropuesta({ usuarios: 3, otrosServicios: [{ id: "reporte" }], firmante: "x" })
    assert.ok(chico.advertencias.some((a) => a.includes("mínimo 5")))
  })

  test("override de servicio asociado respeta el mínimo de tabla", () => {
    const r = cotizarPropuesta({
      usuarios: 10,
      equipos: [{ id: "mb10vl", modalidad: "venta", cantidad: 1 }],
      serviciosAsociados: [
        { id: "envio", zona: "rm", modalidad: "arriendo", precioUF: 0.15 }, // mínimo arriendo = 0 → válido
        { id: "instalacion", zona: "region", modalidad: "venta", precioUF: 1 }, // mínimo 5 → sube al mínimo
      ],
      firmante: "x",
    })
    const envio = r.lineas.find((l) => l.id === "envio")
    const inst = r.lineas.find((l) => l.id === "instalacion")
    assert.strictEqual(envio?.subtotalUF, 0.15)
    assert.strictEqual(inst?.subtotalUF, 5)
    assert.ok(r.advertencias.some((a) => a.includes("bajo el mínimo")))
  })

  test("cabos sueltos: hardware sin envío/instalación bloquea; declaraciones explícitas liberan", () => {
    const base = { usuarios: 20, equipos: [{ id: "ct58", modalidad: "arriendo" as const, cantidad: 1 }], firmante: "x" }
    const pendientes = validarPropuesta(base)
    assert.ok(pendientes.some((p) => p.includes("ENVÍO")))
    assert.ok(pendientes.some((p) => p.includes("INSTALACIÓN")))
    assert.strictEqual(validarPropuesta({ ...base, envioExcluido: true, instalacionPorCliente: true }).length, 0)
  })

  test("SF2A en venta es imposible (solo arriendo)", () => {
    const pendientes = validarPropuesta({
      usuarios: 10,
      equipos: [{ id: "senseface_2a", modalidad: "venta", cantidad: 1 }],
      envioExcluido: true,
      instalacionPorCliente: true,
      firmante: "x",
    })
    assert.ok(pendientes.some((p) => p.includes("solo existe en arriendo")))
  })

  test("bundle IN01 y kit QR con precio propio", () => {
    const r = cotizarPropuesta({
      usuarios: 10,
      bundleIn01: { modalidad: "venta", cantidad: 1 },
      kitQrCantidad: 2,
      envioExcluido: true,
      instalacionPorCliente: true,
      firmante: "x",
    })
    // Mensual: asistencia 0,75 + kit QR 2 × 1,8 = 3,6 → 4,35 · Pago único: bundle 27
    assert.strictEqual(r.totalMensualUF, 4.35)
    assert.strictEqual(r.totalPagoUnicoUF, 27)
  })

  test("override de equipo es LIBRE (UI literal) y avisa bajo el 75% de lista", () => {
    const r = cotizarPropuesta({
      usuarios: 80,
      equipos: [{ id: "senseface_2a", modalidad: "arriendo", cantidad: 5, precioUF: 0.3 }],
      envioExcluido: true,
      instalacionPorCliente: true,
      firmante: "Anderson Diaz",
    })
    // Anderson: 5 × 0,3 = 1,5 (permitido; 0,3 > 0,2625 → sin advertencia) + asistencia 5,2 = 6,7
    assert.strictEqual(r.totalMensualUF, 6.7)
    assert.strictEqual(r.advertencias.length, 0)

    const regalado = cotizarPropuesta({
      usuarios: 80,
      equipos: [{ id: "s922", modalidad: "venta", cantidad: 1, precioUF: 5 }], // lista 20, 75% = 15
      envioExcluido: true,
      instalacionPorCliente: true,
      firmante: "x",
    })
    assert.strictEqual(regalado.totalPagoUnicoUF, 5) // se acepta (UI literal)
    assert.ok(regalado.advertencias.some((a) => a.includes("permitido, pero revísalo")))
  })

  test("frontera: el motor es PURO (sin red, sin Supabase, sin imports externos)", () => {
    for (const f of ["lib/cotizadora-ejecutivos/motor.ts", "lib/cotizadora-ejecutivos/catalogo.ts"]) {
      const src = readFileSync(f, "utf-8")
      assert.doesNotMatch(src, /fetch\(/, `${f} no debe hacer red`)
      assert.doesNotMatch(src, /SUPABASE|process\.env/, `${f} no debe leer env ni Supabase`)
      assert.doesNotMatch(src, /from "\.\.\//, `${f} no debe importar fuera de su carpeta`)
    }
  })
})
