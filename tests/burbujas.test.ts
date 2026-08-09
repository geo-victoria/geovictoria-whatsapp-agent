/**
 * Partición del reply en burbujas (Rodrigo 09-ago): cada punto aparte es un
 * mensaje aparte, EXCEPTO los bloques estructurados (resumen de precios), que
 * se leen como tabla y no se fragmentan.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { partirEnBurbujas } from "../lib/burbujas.ts"

describe("cada punto aparte es un mensaje aparte", () => {
  test("caso real 'con 19 personas' → 2 burbujas", () => {
    const b = partirEnBurbujas(
      "Perfecto, Rodrigo! Con 19 personas puedo cotizarte de inmediato 😊\n\nY cómo prefieren marcar asistencia: con la app del celular (gratis, con biometría facial y GPS) o con un reloj control físico en algún punto?",
    )
    assert.equal(b.length, 2)
    assert.ok(b[0].startsWith("Perfecto, Rodrigo!"))
    assert.ok(b[1].startsWith("Y cómo prefieren marcar"))
  })

  test("caso real entrega de la formal → 3 burbujas + el corte duro", () => {
    const b = partirEnBurbujas(
      "Listo! 🎉\nAquí revisas, aceptas y pagas tu cotización: https://botm.cc/l/x\n\nEn esa misma página eliges el medio de pago: tarjeta vía Mercado Pago (se confirma al instante) o transferencia bancaria.\n\nTambién te mandé el PDF de respaldo a tu correo.\n[---]\nCualquier duda, ajuste o el comprobante si pagas por transferencia, me escribes por aquí mismo y lo veo yo 😊",
    )
    assert.equal(b.length, 4)
    assert.ok(b[0].includes("botm.cc"))
    assert.ok(b[1].startsWith("En esa misma página"))
    assert.ok(b[2].startsWith("También te mandé"))
    assert.ok(b[3].startsWith("Cualquier duda"))
  })

  test("una sola oración queda como una burbuja", () => {
    assert.deepEqual(partirEnBurbujas("Hola! Soy Vicky de GeoVictoria."), [
      "Hola! Soy Vicky de GeoVictoria.",
    ])
  })

  test("el marcador [---] sigue cortando aunque no haya párrafos", () => {
    const b = partirEnBurbujas("Precio: $10.000\n[---]\nMe das tu RUT y email?")
    assert.equal(b.length, 2)
  })
})

describe("los bloques estructurados no se fragmentan", () => {
  const RESUMEN =
    "Resumen mensual recurrente:\n\n- Control de Asistencia: 15 × 0,07 UF = 1,05 UF/mes\n- Reloj control físico: 1 unidad × 0,35 UF = 0,35 UF/mes\n\nSubtotal mensual: 1,4 UF\nIVA (19%): 0,27 UF\nTotal mensual con IVA: 1,67 UF\nEquivalente: $68.047 CLP/mes\n\nPago único:\n\n- Envío de reloj (Valparaíso): 0,5 UF\n- Instalación de reloj (Valparaíso): 3 UF\n\nSubtotal único: 3,5 UF\nIVA (19%): 0,67 UF\nTotal único con IVA: 4,17 UF\n\nAl aceptar pagas el pago inicial de $238.166 CLP: incluye el pago único (equipos e instalación) + el primer mes del plan por adelantado."

  test("el resumen de precios completo queda en pocas burbujas coherentes", () => {
    const b = partirEnBurbujas(RESUMEN)
    // Encabezado+items+totales del recurrente en una; Pago único+items+totales
    // +pago inicial en otra: 2 burbujas, jamás una por párrafo (serían 7).
    assert.equal(b.length, 2)
    assert.ok(b[0].startsWith("Resumen mensual recurrente:"))
    assert.ok(b[0].includes("Equivalente"))
    assert.ok(b[1].startsWith("Pago único:"))
    assert.ok(b[1].includes("Al aceptar pagas"))
  })

  test("resumen + [---] + 💡 alternativas = bloque aparte intacto", () => {
    const b = partirEnBurbujas(
      RESUMEN +
        "\n\n[---]\n\n💡 Para partir más liviano tienes dos alternativas:\n\n- Auto-instalación: ustedes montan los relojes y el pago inicial baja a $92.350 CLP.\n- Marcaje sin reloj: con la app incluida en el plan. Pídeme esa opción y te la muestro.",
    )
    assert.equal(b.length, 3)
    assert.ok(b[2].startsWith("💡"))
    assert.ok(b[2].includes("Marcaje sin reloj"))
  })

  test("el recap con guiones no se separa de su encabezado", () => {
    const b = partirEnBurbujas(
      "Perfecto! Entonces tenemos:\n\n- 12 personas\n- Prueba Spa\n\nY en cuántos puntos están distribuidos?",
    )
    assert.equal(b.length, 2)
    assert.ok(b[0].includes("- Prueba Spa"))
    assert.ok(b[1].startsWith("Y en cuántos puntos"))
  })
})
