/**
 * El agente de onboarding: prompt, kickoff y schemas de tools.
 *
 * DECISIÓN QUE ORIGINA ESTE ARCHIVO (Eduardo, 26-jul): en Chile Vicky es
 * AUTÓNOMA después del pago — no presenta ejecutivos, no deriva a nadie,
 * conduce el alta completa ella misma. Estos casos hacen esa regla mecánica:
 * si alguien re-agrega la presentación del ejecutivo al prompt o al kickoff,
 * esto falla antes de llegar a un cliente.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { promptOnboardingCL, mensajeKickoffCL } from "../lib/onboarding/prompt.ts"
import {
  TOOL_GUARDAR_DATOS_ONBOARDING,
  TOOL_CONFIRMAR_ALTA_EMPRESA,
} from "../lib/onboarding/tools.ts"
import { borradorVacio, aplicarDatos, type Borrador } from "../lib/onboarding/borrador.ts"

const COMPLETO: Borrador = aplicarDatos(borradorVacio("cl"), {
  empresa: { nombre: "Transportes Viig SpA", identificador: "77.861.333-6" },
  admin: {
    nombre: "Pablo",
    apellido: "Soto Vera",
    identificador: "12.345.678-5",
    email: "pablo@viig.cl",
  },
})

// La autonomía, en regex: nada de personas del equipo ni sus datos de contacto.
const FUGA_EJECUTIVO =
  /anderson|yahel|adiazg|ysegura|ejecutivo te|tu ejecutivo|te contactará|te llamará|\+56 9 ?39|\+52 55/i

describe("kickoff post-pago (reemplaza la presentación del ejecutivo)", () => {
  test("abre el alta por chat, sin presentar a nadie", () => {
    const k = mensajeKickoffCL()
    assert.ok(!FUGA_EJECUTIVO.test(k), "el kickoff no puede presentar ejecutivos")
    assert.match(k, /razón social/i)
    assert.match(k, /RUT/)
    assert.ok(!/https?:\/\//.test(k), "sin links: el alta parte en el chat, no en un wizard")
  })

  test("respeta el estilo de Vicky", () => {
    const k = mensajeKickoffCL()
    assert.ok(!/\bOye\b/.test(k))
    assert.ok(!/[¿¡]/.test(k), "sin signos de apertura")
    assert.ok(!/\*/.test(k), "sin negritas")
  })
})

describe("prompt de la fase: autonomía", () => {
  test("en ningún estado el prompt filtra ejecutivos ni teléfonos de personas", () => {
    for (const [nombre, prompt] of [
      ["vacío", promptOnboardingCL(borradorVacio("cl"), { altaSolicitada: false })],
      ["completo", promptOnboardingCL(COMPLETO, { altaSolicitada: false })],
      ["solicitado", promptOnboardingCL(COMPLETO, { altaSolicitada: true })],
    ] as const) {
      assert.ok(!FUGA_EJECUTIVO.test(prompt), `fuga de ejecutivo en estado ${nombre}`)
      assert.match(prompt, /NO presentas, derivas ni prometes/, `sin regla de autonomía en ${nombre}`)
    }
  })

  test("prohíbe la conversación comercial: la venta ya cerró", () => {
    const p = promptOnboardingCL(borradorVacio("cl"), { altaSolicitada: false })
    assert.match(p, /Nada de precios, descuentos/)
  })
})

describe("prompt de la fase: el estado inyectado manda", () => {
  test("borrador vacío: los 6 datos aparecen como pendientes", () => {
    const p = promptOnboardingCL(borradorVacio("cl"), { altaSolicitada: false })
    assert.match(p, /Aún no hay datos guardados/)
    for (const etiqueta of [
      "razón social de la empresa",
      "RUT de la empresa",
      "nombre del administrador",
      "apellido del administrador",
      "RUT del administrador",
      "correo del administrador",
    ]) {
      assert.ok(p.includes(etiqueta), `falta la etiqueta pendiente: ${etiqueta}`)
    }
  })

  test("avance parcial: lo guardado se muestra y NO se re-pide", () => {
    const b = aplicarDatos(borradorVacio("cl"), {
      empresa: { nombre: "Transportes Viig SpA", identificador: "77.861.333-6" },
    })
    const p = promptOnboardingCL(b, { altaSolicitada: false })
    assert.match(p, /Datos ya guardados:/)
    assert.match(p, /Transportes Viig SpA/)
    const pendientes = p.slice(p.indexOf("Datos pendientes:"))
    assert.ok(!pendientes.includes("razón social"), "la razón social ya no puede estar pendiente")
    assert.ok(pendientes.includes("correo del administrador"))
  })

  test("un dato inválido se marca para re-pedir, distinto de faltante", () => {
    const b = aplicarDatos(borradorVacio("cl"), {
      empresa: { identificador: "77861333-5" }, // DV malo
    })
    const p = promptOnboardingCL(b, { altaSolicitada: false })
    assert.match(p, /inválido/)
    assert.match(p, /RUT de la empresa: RUT inválido/)
  })

  test("borrador completo: trae el resumen y frena la confirmación prematura", () => {
    const p = promptOnboardingCL(COMPLETO, { altaSolicitada: false })
    assert.match(p, /TODOS los datos están completos/)
    assert.match(p, /RUT: 77861333-6/, "el resumen va con datos normalizados")
    assert.match(p, /NO llames confirmar_alta_empresa/)
  })

  test("alta ya solicitada: prohíbe re-pedir datos y re-confirmar", () => {
    const p = promptOnboardingCL(COMPLETO, { altaSolicitada: true })
    assert.match(p, /YA FUE SOLICITADA/)
    assert.match(p, /NO vuelvas a pedir datos/)
    assert.match(p, /24 horas\s+hábiles/)
    assert.ok(!p.includes("Datos pendientes"), "no puede volver a listar pendientes")
  })
})

describe("schemas de las tools", () => {
  test("guardar_datos cubre exactamente los campos del borrador", () => {
    const props = TOOL_GUARDAR_DATOS_ONBOARDING.input_schema.properties
    assert.deepEqual(Object.keys(props.empresa.properties), ["nombre", "identificador"])
    assert.deepEqual(Object.keys(props.admin.properties), [
      "nombre",
      "apellido",
      "identificador",
      "email",
      "idInterno",
    ])
    // Nada es required: la tool acepta el avance de a un dato.
    assert.ok(!("required" in TOOL_GUARDAR_DATOS_ONBOARDING.input_schema))
  })

  test("confirmar_alta exige la confirmación explícita como required", () => {
    assert.deepEqual(TOOL_CONFIRMAR_ALTA_EMPRESA.input_schema.required, [
      "confirmacion_explicita",
    ])
    assert.match(TOOL_CONFIRMAR_ALTA_EMPRESA.description, /irreversible/i)
  })

  test("las descripciones exigen el dato TAL CUAL y prohíben adivinar el apellido", () => {
    assert.match(TOOL_GUARDAR_DATOS_ONBOARDING.description, /TAL CUAL/)
    assert.match(
      TOOL_GUARDAR_DATOS_ONBOARDING.input_schema.properties.admin.properties.apellido.description,
      /pregunta en vez de adivinar/,
    )
  })
})
