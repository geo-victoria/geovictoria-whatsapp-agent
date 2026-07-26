/**
 * Fase del contacto y estado del borrador entre mensajes.
 *
 * Lo que se protege: el contacto que PAGÓ no puede quedar atrapado en un
 * estado raro. La fase decide qué agente lo atiende, y el borrador es lo que
 * Vicky ya le preguntó — perderlo es hacerle repetir sus datos a un cliente
 * que acaba de pagar; corromperlo es crear una empresa con basura.
 */

import { test, describe, afterEach } from "node:test"
import assert from "node:assert/strict"
import {
  transicionValida,
  esFase,
  faseEfectiva,
  onboardingEnabled,
  claveFase,
  claveBorrador,
} from "../lib/onboarding/fase.ts"
import {
  borradorVacio,
  aplicarDatos,
  parsearBorrador,
  borradorCompleto,
  type Borrador,
} from "../lib/onboarding/borrador.ts"

afterEach(() => {
  delete process.env.VICKY_ONBOARDING_ENABLED
})

describe("transiciones de fase", () => {
  test("solo existen dos puertas: pago y empresa creada", () => {
    assert.ok(transicionValida("venta", "onboarding"), "el pago abre onboarding")
    assert.ok(transicionValida("onboarding", "completado"), "la empresa creada cierra")
  })

  test("no hay atajos ni vueltas atrás", () => {
    // venta→completado saltaría el alta; completado→onboarding sería un
    // segundo onboarding (eso es soporte); onboarding→venta re-vendería a un
    // cliente que ya pagó.
    for (const [desde, hacia] of [
      ["venta", "completado"],
      ["completado", "onboarding"],
      ["completado", "venta"],
      ["onboarding", "venta"],
    ] as const) {
      assert.equal(transicionValida(desde, hacia), false, `${desde}→${hacia} no debe existir`)
    }
  })
})

describe("fase efectiva desde vic_kv", () => {
  test("con el flag apagado TODO es venta, diga lo que diga el kv", () => {
    // La garantía de no-regresión: mientras VICKY_ONBOARDING_ENABLED no esté
    // en "on", el camino de venta se comporta exactamente como hoy.
    assert.equal(onboardingEnabled(), false)
    assert.equal(faseEfectiva("onboarding"), "venta")
    assert.equal(faseEfectiva("completado"), "venta")
  })

  test("con el flag prendido la fase del kv manda", () => {
    process.env.VICKY_ONBOARDING_ENABLED = "on"
    assert.equal(faseEfectiva("onboarding"), "onboarding")
    assert.equal(faseEfectiva("completado"), "completado")
  })

  test("kv vacío o corrupto degrada a venta, nunca revienta", () => {
    process.env.VICKY_ONBOARDING_ENABLED = "on"
    for (const crudo of [null, undefined, "", "cualquier_cosa", "ONBOARDING", "{}"]) {
      assert.equal(faseEfectiva(crudo as string | null), "venta", `crudo=${JSON.stringify(crudo)}`)
    }
    assert.equal(esFase("onboarding"), true)
    assert.equal(esFase("Onboarding"), false)
  })

  test("las llaves kv son por contacto y no colisionan entre sí", () => {
    assert.notEqual(claveFase("56966432322"), claveFase("56911112222"))
    assert.notEqual(claveFase("56966432322"), claveBorrador("56966432322"))
  })
})

describe("aplicarDatos: lo que la tool extrajo del mensaje", () => {
  test("un dato nuevo pisa al anterior — el cliente corrige", () => {
    let b = borradorVacio("cl")
    b = aplicarDatos(b, { empresa: { identificador: "77861333-5" } }) // DV malo
    b = aplicarDatos(b, { empresa: { identificador: "77861333-6" } }) // "perdón, era -6"
    assert.equal(b.empresa.identificador, "77861333-6")
  })

  test("vacío o no-string NO borra un dato ya juntado", () => {
    let b = aplicarDatos(borradorVacio("cl"), { admin: { nombre: "Pablo" } })
    b = aplicarDatos(b, { admin: { nombre: "" } })
    b = aplicarDatos(b, { admin: { nombre: "   " } })
    b = aplicarDatos(b, { admin: { nombre: 42 as unknown as string } })
    assert.equal(b.admin.nombre, "Pablo")
  })

  test("es inmutable: el borrador original no se toca", () => {
    const original = borradorVacio("cl")
    aplicarDatos(original, { empresa: { nombre: "Viig SpA" } })
    assert.equal(original.empresa.nombre, undefined)
  })

  test("recorta espacios al guardar", () => {
    const b = aplicarDatos(borradorVacio("cl"), { admin: { email: "  pablo@viig.cl  " } })
    assert.equal(b.admin.email, "pablo@viig.cl")
  })
})

describe("parsearBorrador: rehidratar desde vic_kv", () => {
  const completo = (): Borrador =>
    aplicarDatos(borradorVacio("cl"), {
      empresa: { nombre: "Transportes Viig SpA", identificador: "77.861.333-6" },
      admin: {
        nombre: "Pablo",
        apellido: "Soto Vera",
        identificador: "12.345.678-5",
        email: "pablo@viig.cl",
        idInterno: "EMP-0042",
      },
    })

  test("round-trip completo: guardar y rehidratar no pierde nada", () => {
    const b = completo()
    assert.deepEqual(parsearBorrador(JSON.stringify(b)), b)
    assert.ok(borradorCompleto(parsearBorrador(JSON.stringify(b))!))
  })

  test("round-trip a medio llenar: el avance parcial sobrevive", () => {
    // El caso real: el cliente da la mitad hoy y contesta mañana.
    const b = aplicarDatos(borradorVacio("co"), { empresa: { nombre: "Grupo Andes SAS" } })
    const de = parsearBorrador(JSON.stringify(b))
    assert.deepEqual(de, b)
    assert.equal(de!.pais, "co")
  })

  test("basura devuelve null, nunca lanza", () => {
    for (const malo of [null, undefined, "", "no es json", "{]", "42", '"texto"', "[]", "{}"]) {
      assert.equal(parsearBorrador(malo as string), null, `debió ser null: ${JSON.stringify(malo)}`)
    }
  })

  test("un país desconocido invalida el borrador entero", () => {
    assert.equal(parsearBorrador('{"pais":"ar","empresa":{},"admin":{}}'), null)
  })

  test("campos con tipos raros se descartan sin contaminar el resto", () => {
    // Si alguien (o un bug) escribió basura en el kv, no puede llegar al alta.
    const sucio = JSON.stringify({
      pais: "cl",
      empresa: { nombre: "Viig SpA", identificador: { hack: true } },
      admin: { nombre: ["Pablo"], email: "pablo@viig.cl", loQueSea: "x" },
    })
    const b = parsearBorrador(sucio)!
    assert.equal(b.empresa.nombre, "Viig SpA")
    assert.equal(b.empresa.identificador, undefined, "el objeto no debe volverse string")
    assert.equal(b.admin.nombre, undefined, "el array no debe volverse string")
    assert.equal(b.admin.email, "pablo@viig.cl")
    assert.ok(!("loQueSea" in b.admin), "campos desconocidos no sobreviven")
  })
})
