/**
 * ZONA GENÉRICA EN EL CANAL EJECUTIVO (Eddyluz 12-ago): en el editor de
 * cotizaciones basta decir "RM" o "Región" — como la calculadora de Nacho.
 * El genérico "Región" cobra la tarifa de resto de regiones (la más alta) y
 * queda con advertencia para que el ejecutivo la afine si corresponde.
 *
 * De cara al CLIENTE (Vicky WhatsApp) NADA cambia: sin el flag, "Región" a
 * secas sigue siendo no_clasificable y Vicky repregunta la comuna (la tarifa
 * intermedia 3 UF vs resto 5 UF la necesita).
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { clasificarUbicacion } from "../lib/geografia.ts"

describe("clasificarUbicacion · zona genérica del canal ejecutivo", () => {
  test("sin flag (Vicky con clientes): 'Región' sigue exigiendo comuna", () => {
    for (const input of ["Región", "region", "regiones", "provincia"]) {
      const c = clasificarUbicacion(input)
      assert.equal(c.tipo, "no_clasificable", `'${input}' debía repreguntarse sin flag`)
    }
  })

  test("con flag (editor): 'Región' clasifica a regiones con tarifa resto", () => {
    for (const input of ["Región", "region", "regiones", "en regiones", "fuera de RM", "provincia"]) {
      const c = clasificarUbicacion(input, { zonaGenericaOk: true })
      assert.equal(c.tipo, "regiones", `'${input}' debía clasificar como regiones`)
      if (c.tipo === "regiones") {
        assert.equal(c.zonaInstalacion, "resto")
        assert.equal(c.reconocida, false, "genérico queda no-reconocido → la tool agrega advertencia")
      }
    }
  })

  test("con flag, 'RM' y las comunas reales siguen igual que siempre", () => {
    const rm = clasificarUbicacion("RM", { zonaGenericaOk: true })
    assert.equal(rm.tipo, "RM")
    const comuna = clasificarUbicacion("Valparaíso", { zonaGenericaOk: true })
    assert.equal(comuna.tipo, "regiones")
    if (comuna.tipo === "regiones") assert.equal(comuna.zonaInstalacion, "intermedia")
    const invento = clasificarUbicacion("Villa Inventada", { zonaGenericaOk: true })
    assert.equal(invento.tipo, "no_clasificable", "el flag no vuelve válido un nombre inexistente")
  })
})
