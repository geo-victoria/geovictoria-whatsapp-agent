/**
 * Identificadores tributarios por país: RUT (CL), NIT (CO), RFC (MX).
 *
 * POR QUÉ ESTÁN ACÁ AHORA — son el campo `Identifier` de la empresa y el
 * `NationalIdentifier` del usuario admin en los endpoints de alta que está
 * armando desarrollo (Nicolás, 26-jul: "el National es el rut en este caso").
 * Lo que Vicky mande por ese campo tiene que salir normalizado y correcto: un
 * identificador mal formado no lo rebota una validación, lo descubre alguien
 * cuando la empresa quedó creada con el RUT equivocado.
 *
 * El criterio de los tres es DELIBERADAMENTE distinto y conviene no
 * "uniformarlo" sin leer: CL valida el DV estricto (módulo 11); CO y MX son
 * permisivos a propósito, porque rechazar un identificador real mata el flujo
 * de venta — lección del bug del NIT de 9 dígitos (jul-2026).
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { rutValido, normalizarRut, formatearRut } from "../lib/rut.ts"
import { nitValido, normalizarNit, digitoVerificacionNit } from "../lib/paises/co/nit.ts"
import { rfcValido, normalizarRfc } from "../lib/paises/mx/rfc.ts"

describe("RUT chileno (estricto, módulo 11)", () => {
  test("acepta el mismo RUT venga como venga", () => {
    for (const forma of ["77.861.333-6", "77861333-6", "778613336", "77.861.333-6 "]) {
      assert.ok(rutValido(forma), `rechazado: ${forma}`)
      assert.equal(formatearRut(forma), "77861333-6")
    }
  })

  test("acepta la K del DV en mayúscula y minúscula", () => {
    // Se busca un cuerpo cuyo DV sea K para no inventar un RUT que no cuadre.
    let conK = ""
    for (let n = 10000000; n < 10000200 && !conK; n++) {
      if (rutValido(`${n}K`)) conK = String(n)
    }
    assert.ok(conK, "no se encontró un cuerpo con DV=K en el rango de prueba")
    assert.ok(rutValido(`${conK}k`), "la k minúscula debería aceptarse")
    assert.equal(formatearRut(`${conK}k`), `${conK}-K`)
  })

  test("rechaza el DV incorrecto (un dígito tecleado al revés)", () => {
    assert.ok(rutValido("77861333-6"))
    assert.equal(rutValido("77861333-5"), false)
    assert.equal(rutValido("77861338-6"), false)
  })

  test("rechaza basura y números demasiado cortos", () => {
    for (const malo of ["", "  ", "12345", "abcdefgh", "1-9", "no tengo", "0"]) {
      assert.equal(rutValido(malo), false, `debió rechazar: ${JSON.stringify(malo)}`)
    }
  })

  test("formatearRut NO inventa formato si el RUT es inválido", () => {
    // Devuelve el original: la validación se reporta aparte, no se disfraza.
    assert.equal(formatearRut("12345"), "12345")
    assert.equal(formatearRut("no lo tengo a mano"), "no lo tengo a mano")
  })

  test("normalizarRut deja solo cuerpo+DV en mayúscula", () => {
    assert.equal(normalizarRut(" 12.345.678-k "), "12345678K")
  })
})

describe("NIT colombiano (permisivo, DV calculado por nosotros)", () => {
  test("el DV nunca es requisito — el cuerpo pelado basta", () => {
    // El bug de jul-2026: un NIT de 9 dígitos SIN DV se partía en cuerpo de 8 +
    // "DV" falso y se rechazaba, matando la cotización.
    assert.ok(nitValido("900123456"))
    assert.equal(normalizarNit("900123456"), `900123456-${digitoVerificacionNit("900123456")}`)
  })

  test("acepta todos los formatos que teclea un cliente", () => {
    const esperado = normalizarNit("900123456")
    for (const forma of ["900.123.456", "900123456", "900.123.456-7", "900123456-7"]) {
      assert.ok(nitValido(forma), `rechazado: ${forma}`)
      assert.equal(normalizarNit(forma), esperado, `normalización distinta: ${forma}`)
    }
  })

  test("el DV que traiga el cliente se ignora y se recalcula", () => {
    // Si el cliente se equivoca en el DV, mandamos el correcto igual.
    assert.equal(normalizarNit("900123456-9"), normalizarNit("900123456-7"))
  })

  test("el DV sigue el algoritmo DIAN", () => {
    // Propiedad: siempre 0-10, y estable para el mismo cuerpo.
    for (const cuerpo of ["900123456", "830045123", "12345678"]) {
      const dv = digitoVerificacionNit(cuerpo)
      assert.ok(dv >= 0 && dv <= 10, `DV fuera de rango para ${cuerpo}: ${dv}`)
      assert.equal(dv, digitoVerificacionNit(cuerpo))
    }
  })

  test("rechaza lo que no puede ser un NIT", () => {
    for (const malo of ["", "123", "1234567", "abcdefgh", "123456789012"]) {
      assert.equal(nitValido(malo), false, `debió rechazar: ${JSON.stringify(malo)}`)
    }
  })
})

describe("RFC mexicano (permisivo, sin verificar homoclave)", () => {
  test("acepta persona moral (12) y persona física (13)", () => {
    assert.ok(rfcValido("CEC200528XX4"), "persona moral")
    assert.ok(rfcValido("GOMA850101XY9"), "persona física")
  })

  test("acepta el RFC como lo teclee el cliente", () => {
    for (const forma of ["cec200528xx4", "CEC-200528-XX4", "CEC 200528 XX4", " CEC200528XX4 "]) {
      assert.ok(rfcValido(forma), `rechazado: ${forma}`)
      assert.equal(normalizarRfc(forma), "CEC200528XX4")
    }
  })

  test("acepta Ñ y & en la razón social", () => {
    assert.ok(rfcValido("ÑAM200528XX4"))
    assert.ok(rfcValido("A&M200528XX4"))
  })

  test("rechaza largo y fecha imposibles", () => {
    for (const malo of [
      "CEC200528XX", // 11
      "GOMA850101XY99", // 14
      "CEC201328XX4", // mes 13
      "CEC200500XX4", // día 00
      "",
      "no lo tengo",
    ]) {
      assert.equal(rfcValido(malo), false, `debió rechazar: ${JSON.stringify(malo)}`)
    }
  })

  test("una fecha de calendario fino SÍ pasa — es a propósito", () => {
    // 31 de febrero se acepta: preferible aceptar de más que rechazar un RFC
    // real y matar el flujo. Documentado en mx/rfc.ts.
    assert.ok(rfcValido("CEC200231XX4"))
  })
})

describe("los tres criterios no se cruzan", () => {
  test("cada validador rechaza los identificadores de los otros países", () => {
    assert.equal(rutValido("900123456"), false, "un NIT no es RUT")
    assert.equal(rfcValido("77861333-6"), false, "un RUT no es RFC")
    assert.equal(nitValido("CEC200528XX4"), false, "un RFC no es NIT")
  })
})
