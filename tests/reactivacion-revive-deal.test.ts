/**
 * CAMPAÑA DE REACTIVACIÓN (decisión de Lalo, 03-sep): un deal en Cierre
 * Perdido SÍ vuelve al pipeline — pero SOLO para los contactos marcados de la
 * campaña (vic_kv `reactivar_deal_<fono>`). Para todos los demás sigue
 * mandando la regla de siempre: perdido es terminal y el re-contacto renace
 * como lead nuevo.
 *
 * El dueño no se toca: revivir es del deal, no de su propiedad.
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { etapaObjetivo } from "../lib/crm-hitos.ts"

describe("revivir un deal perdido, solo en campaña", () => {
  test("SIN marca de campaña, Cierre Perdido sigue siendo terminal", () => {
    assert.equal(etapaObjetivo("Cierre Perdido", "4. Propuesta Enviada / En Negociación"), null)
  })

  test("CON marca, sube al piso del hito", () => {
    assert.equal(
      etapaObjetivo("Cierre Perdido", "4. Propuesta Enviada / En Negociación", true),
      "4. Propuesta Enviada / En Negociación",
    )
  })

  test("la regla 'nunca retrocede' sigue intacta con la marca puesta", () => {
    // Un deal ya en 6 no baja a 4 por revivir.
    assert.equal(etapaObjetivo("6. Listo para Cierre", "4. Propuesta Enviada / En Negociación", true), null)
    // Y sí sube cuando el hito pide más.
    assert.equal(etapaObjetivo("1. Trato Creado", "4. Propuesta Enviada / En Negociación", true), "4. Propuesta Enviada / En Negociación")
  })

  test("un cliente facturando NO se revive ni con la marca", () => {
    // 8. Facturando está en la escalera y es mayor que cualquier piso de venta.
    assert.equal(etapaObjetivo("8. Facturando", "4. Propuesta Enviada / En Negociación", true), null)
  })

  test("un piso desconocido nunca mueve nada", () => {
    assert.equal(etapaObjetivo("Cierre Perdido", "etapa inventada", true), null)
  })
})
