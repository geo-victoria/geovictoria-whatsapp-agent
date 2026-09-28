/**
 * MOTOR ÚNICO DE COTIZACIÓN (lib/cotizacion-unica): el código de Chile con
 * los datos de cada país.
 *
 *  - Chile: la tool cotizar_referencial antes del motor único, CONGELADA sobre
 *    un grid de configuraciones (tests/fixtures/cotizacion-cl-congelada.json:
 *    muestra del grid completo de 20.045 casos verificado a mano el 28-sep).
 *    Mensaje byte a byte, ítems y totales idénticos.
 *  - Perú, Colombia, México: el motor anterior congelado (números e ítems de
 *    la formal idénticos; el TEXTO sí cambió: ahora tiene la forma de Chile).
 *  - Candados: los adaptadores no tienen lógica propia.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { cotizarReferencialConReglas } from "../lib/cotizacion-unica/motor.ts"
import { REGLAS_CL, resultadoChile } from "../lib/cotizacion-unica/reglas-cl.ts"
import { cotizarPE } from "../lib/paises/pe/cotizar.ts"
import { cotizarCO } from "../lib/paises/co/cotizar.ts"
import { cotizarMX } from "../lib/paises/mx/cotizar.ts"

const clon = <T,>(x: T): T => JSON.parse(JSON.stringify(x))

test("Chile: el motor único reproduce la tool congelada (mensaje byte a byte, ítems y totales)", () => {
  const fx = JSON.parse(readFileSync("tests/fixtures/cotizacion-cl-congelada.json", "utf8"))
  assert.ok(fx.casos.length > 300)
  for (const { caso, r: esperado } of fx.casos) {
    const r = clon(resultadoChile(cotizarReferencialConReglas(REGLAS_CL, clon(caso), fx.ufActual), fx.ufActual)) as Record<string, unknown>
    delete r.resumenLegible
    assert.deepEqual(r, esperado, JSON.stringify(caso))
  }
})

test("Perú, Colombia y México: mismos números e ítems de la formal que el motor anterior", () => {
  const fx = JSON.parse(readFileSync("tests/fixtures/cotizacion-pais-congelada.json", "utf8"))
  const fns: Record<string, (i: never) => Record<string, unknown>> = { pe: cotizarPE as never, co: cotizarCO as never, mx: cotizarMX as never }
  for (const p of ["pe", "co", "mx"]) {
    assert.ok(fx[p].length > 50)
    for (const { caso, r: esperado } of fx[p]) {
      // Colombia: el motor anterior tenía la tabla 1-10 fijo; hoy esa es la
      // tabla LEGADO (28-sep), así que el congelado se compara contra ella.
      const entrada = p === "co" ? { ...clon(caso), tramoLegado: true } : clon(caso)
      const r = clon(fns[p](entrada as never))
      delete r.mensajeParaProspecto
      delete r.lineas
      assert.deepEqual(r, esperado, `${p} ${JSON.stringify(caso)}`)
    }
  }
})

test("los adaptadores de país no tienen lógica propia: declaran datos y llaman al motor único", () => {
  const tool = readFileSync("lib/tools/cotizar-referencial.ts", "utf8")
  assert.ok(tool.includes("cotizarReferencialConReglas(REGLAS_CL"), "la tool chilena usa el motor único")
  assert.ok(!/serviciosAplicables|clasificarUbicacion\(/.test(tool), "la tool chilena volvió a tener lógica propia")
  for (const p of ["pe", "co", "mx"]) {
    const src = readFileSync(`lib/paises/${p}/cotizar.ts`, "utf8")
    assert.ok(src.includes("../../cotizacion-unica/pais.ts"), `${p} no usa el motor único`)
    assert.ok(!/new Map|\.reduce\(|for \(const/.test(src), `${p} volvió a tener lógica propia`)
  }
})

test("mismo flujo en los cuatro: con equipo → doble valor de Chile y cierre 'Qué opción prefieres?'", () => {
  const cl = resultadoChile(
    cotizarReferencialConReglas(REGLAS_CL, { userCount: 12, modulos: ["asistencia"], hardware: [{ id: "senseface_2a" }], puntosInstalacion: [{ ubicacion: "Las Condes", autoInstalada: true }] }, 40000),
    40000,
  )
  assert.ok(cl.ok)
  const pe = cotizarPE({ userCount: 12, reloj: { modalidad: "arriendo", cantidad: 1 }, puntos: [{ ubicacion: "Miraflores", zona: "lima", autoInstalada: true }], tipoCambio: 3.372 })
  const co = cotizarCO({ userCount: 12, reloj: { modalidad: "arriendo", cantidad: 1 }, puntos: [{ ubicacion: "Bogotá", zona: "capital", autoInstalada: true }] })
  const mx = cotizarMX({ userCount: 12, reloj: { modalidad: "arriendo", cantidad: 1 }, puntos: [{ ubicacion: "Coyoacán", zona: "cdmx_metro", autoInstalada: true }] })
  for (const m of [cl.ok ? cl.mensajeParaProspecto : "", pe.mensajeParaProspecto, co.mensajeParaProspecto, mx.mensajeParaProspecto]) {
    assert.match(m, /^1 - Para 12 personas te recomiendo .+ \+ App:\n💰 /)
    assert.ok(m.includes("como les acomode."))
    assert.ok(m.includes("va incluida sin costo"))
    assert.ok(m.includes("2.- Una alternativa más económica sería si marcan solo mediante nuestra app:"))
    assert.ok(m.endsWith("Qué opción prefieres? Con la que elijas te genero la cotización formal de inmediato."))
  }
})

test("sin equipo: el resumen de Chile (línea del plan con cantidad × unitario)", () => {
  const cl = resultadoChile(cotizarReferencialConReglas(REGLAS_CL, { userCount: 12, modulos: ["asistencia"] }, 40000), 40000)
  assert.ok(cl.ok && cl.mensajeParaProspecto.startsWith("Resumen mensual recurrente:\n\n- Control de Asistencia: 12 × "))
  const pe = cotizarPE({ userCount: 12, tipoCambio: 3.372 })
  assert.ok(pe.mensajeParaProspecto.startsWith("Resumen mensual recurrente:\n\n- Control de Asistencia: 12 × S/"))
  const mx = cotizarMX({ userCount: 5 })
  assert.ok(mx.mensajeParaProspecto.includes("- Control de Asistencia: $1,200/mes"))
})

test("pago inicial = pagos únicos + primer mes (plan con descuento + arriendo) en los tres países", () => {
  const pe = cotizarPE({ userCount: 15, reloj: { modalidad: "arriendo", cantidad: 1 }, puntos: [{ ubicacion: "Miraflores", zona: "lima", autoInstalada: true }], escalonDescuento: 1, tipoCambio: 3.372 })
  assert.ok(Math.abs(pe.pagoInicialNeto - (135 * 0.9 + 67)) < 0.01)
  const co = cotizarCO({ userCount: 15, reloj: { modalidad: "arriendo", cantidad: 1 }, puntos: [{ ubicacion: "Bogotá", zona: "capital", autoInstalada: true }] })
  assert.equal(co.pagoInicialNeto, 315000 + 86000)
  const mx = cotizarMX({ userCount: 10, reloj: { modalidad: "arriendo", cantidad: 1 }, puntos: [{ ubicacion: "Coyoacán", zona: "cdmx_metro", autoInstalada: true }] })
  assert.equal(mx.pagoInicialNeto, 1200 + 350)
})

test("el envío en venta se cobra por punto", () => {
  const co = cotizarCO({ userCount: 5, reloj: { modalidad: "venta", cantidad: 2 }, puntos: [{ ubicacion: "Medellín", zona: "resto", autoInstalada: true }, { ubicacion: "Cali", zona: "resto", autoInstalada: true }] })
  assert.equal(co.itemsCotizador.filter((i) => i.id === "envio_reloj").reduce((s, i) => s + i.subtotalCOP, 0), 2 * 69000)
})
