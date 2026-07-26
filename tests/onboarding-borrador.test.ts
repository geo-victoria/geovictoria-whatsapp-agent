/**
 * Borrador de onboarding: lo que Vicky junta por chat antes de crear la cuenta.
 *
 * Lo que se protege acá es el paso irreversible. Un alta no se deshace sola: si
 * la razón social o el identificador salen mal, la empresa queda creada mal en
 * la plataforma del cliente y lo arregla alguien a mano. Todo lo que sigue
 * existe para que eso no pase por un dato a medio validar.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import {
  borradorVacio,
  borradorCompleto,
  camposPendientes,
  problemas,
  resumenParaConfirmar,
  emailValido,
  identificadorValido,
  normalizarIdentificador,
  NOMBRE_IDENTIFICADOR,
  type Borrador,
  type PaisOnboarding,
} from "../lib/onboarding/borrador.ts"

const completo = (pais: PaisOnboarding, id: string, idAdmin: string): Borrador => ({
  pais,
  empresa: { nombre: "Transportes Viig SpA", identificador: id },
  admin: {
    nombre: "Pablo",
    apellido: "Soto Vera",
    identificador: idAdmin,
    email: "pablo@viig.cl",
  },
})

const CL = () => completo("cl", "77.861.333-6", "12.345.678-5")

describe("qué falta todavía", () => {
  test("un borrador vacío pide los seis campos, en orden de conversación", () => {
    assert.deepEqual(camposPendientes(borradorVacio("cl")), [
      "empresa.nombre",
      "empresa.identificador",
      "admin.nombre",
      "admin.apellido",
      "admin.identificador",
      "admin.email",
    ])
  })

  test("los problemas se devuelven JUNTOS, no de a uno", () => {
    // Vicky tiene que poder pedir todo lo que falta en un mensaje. Si esto
    // devolviera solo el primero, el cliente recibiría seis preguntas seguidas.
    const b = borradorVacio("cl")
    b.empresa.nombre = "Viig SpA"
    assert.equal(problemas(b).length, 5)
  })

  test("un borrador completo no tiene pendientes", () => {
    assert.deepEqual(camposPendientes(CL()), [])
    assert.ok(borradorCompleto(CL()))
  })

  test("espacios en blanco no cuentan como dato", () => {
    const b = CL()
    b.empresa.nombre = "   "
    assert.deepEqual(camposPendientes(b), ["empresa.nombre"])
  })
})

describe("identificador por país", () => {
  test("cada país valida el suyo y rechaza el de los otros", () => {
    const casos: [PaisOnboarding, string, string][] = [
      ["cl", "77.861.333-6", "77861333-6"],
      ["co", "900.123.456", "900123456-8"],
      ["mx", "cec200528xx4", "CEC200528XX4"],
    ]
    for (const [pais, entrada, canonico] of casos) {
      assert.ok(identificadorValido(entrada, pais), `${pais} rechazó ${entrada}`)
      assert.equal(normalizarIdentificador(entrada, pais), canonico)
    }
    assert.equal(identificadorValido("900123456", "cl"), false)
    assert.equal(identificadorValido("77861333-6", "mx"), false)
  })

  test("un identificador inválido se reporta como inválido, no como faltante", () => {
    // La diferencia importa: a un campo vacío se le pregunta, a uno malo se le
    // dice que está malo. Si se confunden, Vicky repregunta como si el cliente
    // no hubiera contestado.
    const b = CL()
    b.empresa.identificador = "77861333-5" // DV cambiado
    const p = problemas(b)
    assert.equal(p.length, 1)
    assert.equal(p[0].campo, "empresa.identificador")
    assert.match(p[0].detalle, /inválido/)
  })

  test("el nombre del identificador cambia por país", () => {
    assert.equal(NOMBRE_IDENTIFICADOR.cl, "RUT")
    assert.equal(NOMBRE_IDENTIFICADOR.co, "NIT")
    assert.equal(NOMBRE_IDENTIFICADOR.mx, "RFC")
    // Y aparece en el detalle, para que Vicky le hable en su idioma al cliente.
    const b = borradorVacio("co")
    const p = problemas(b).find((x) => x.campo === "empresa.identificador")
    assert.match(p!.detalle, /NIT/)
  })

  test("el onboarding funciona en los tres países", () => {
    assert.ok(borradorCompleto(completo("cl", "77861333-6", "12345678-5")))
    assert.ok(borradorCompleto(completo("co", "900123456", "830045123")))
    assert.ok(borradorCompleto(completo("mx", "CEC200528XX4", "GOMA850101XY9")))
  })
})

describe("correo del administrador", () => {
  test("acepta direcciones reales que un regex estricto rompería", () => {
    for (const e of [
      "pablo@viig.cl",
      "maria.jose@grupo-andes.com.co",
      "j.perez+geo@sub.dominio.empresa.mx",
      "RRHH@Empresa.COM",
    ]) {
      assert.ok(emailValido(e), `rechazado: ${e}`)
    }
  })

  test("rechaza lo que no es un correo", () => {
    for (const e of ["", "  ", "pablo", "pablo@", "@viig.cl", "pablo viig.cl", "pablo@viig"]) {
      assert.equal(emailValido(e), false, `debió rechazar: ${JSON.stringify(e)}`)
    }
  })
})

describe("nombre y apellido separados desde el origen", () => {
  test("un apellido faltante bloquea el alta", () => {
    // La API pide FirstName y LastName aparte. Partir un nombre compuesto por
    // espacios es adivinar, y ese nombre es el que le queda al cliente en su
    // plataforma. Mejor preguntarlo que inventarlo.
    const b = CL()
    b.admin.apellido = ""
    assert.equal(borradorCompleto(b), false)
    assert.deepEqual(camposPendientes(b), ["admin.apellido"])
  })

  test("un apellido compuesto se conserva entero", () => {
    const b = CL()
    b.admin.apellido = "Soto Vera"
    assert.match(resumenParaConfirmar(b), /Pablo Soto Vera/)
  })
})

describe("el código interno es opcional de verdad", () => {
  test("sin código interno el borrador está completo", () => {
    // Desarrollo lo describió como "a veces tienen SAP o algo". No puede
    // bloquear un alta.
    const b = CL()
    assert.equal(b.admin.idInterno, undefined)
    assert.ok(borradorCompleto(b))
  })

  test("si el cliente lo da, aparece en la confirmación", () => {
    const b = CL()
    b.admin.idInterno = "EMP-0042"
    assert.match(resumenParaConfirmar(b), /EMP-0042/)
  })
})

describe("confirmación antes del paso irreversible", () => {
  test("no hay resumen si el borrador está incompleto", () => {
    // Nunca se le pide confirmar algo a medio llenar.
    assert.equal(resumenParaConfirmar(borradorVacio("cl")), "")
  })

  test("el resumen muestra los datos YA NORMALIZADOS, no como los tecleó", () => {
    // El cliente confirma exactamente lo que se va a enviar. Si en pantalla ve
    // "77.861.333-6" y se manda "77861333-6", no confirmó lo que se mandó.
    const r = resumenParaConfirmar(CL())
    assert.match(r, /RUT: 77861333-6/)
    assert.ok(!r.includes("77.861.333-6"), "el resumen no debe mostrar el formato con puntos")
  })

  test("el resumen trae los seis datos y pide confirmación explícita", () => {
    const r = resumenParaConfirmar(CL())
    for (const dato of ["Transportes Viig SpA", "77861333-6", "Pablo Soto Vera", "pablo@viig.cl"]) {
      assert.ok(r.includes(dato), `falta en el resumen: ${dato}`)
    }
    assert.match(r, /confirmas/i)
  })

  test("el resumen respeta el estilo de Vicky", () => {
    const r = resumenParaConfirmar(CL())
    assert.ok(!/\*/.test(r), "sin negritas")
    assert.ok(!/[¿¡]/.test(r), "sin signos de apertura")
    assert.ok(!/\bOye\b/.test(r), "jamás 'Oye'")
  })

  test("usa el nombre del identificador del país en el resumen", () => {
    const r = resumenParaConfirmar(completo("co", "900123456", "830045123"))
    assert.match(r, /NIT: 900123456-8/)
    assert.ok(!r.includes("RUT"))
  })
})
