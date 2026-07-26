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
import {
  promptOnboardingCL,
  mensajeKickoffCL,
  mensajeKickoffComprobanteCL,
} from "../lib/onboarding/prompt.ts"
import {
  TOOL_GUARDAR_DATOS_ONBOARDING,
  TOOL_CONFIRMAR_ALTA_EMPRESA,
} from "../lib/onboarding/tools.ts"
import {
  borradorVacio,
  aplicarDatos,
  sembrarBorrador,
  camposPendientes,
  type Borrador,
} from "../lib/onboarding/borrador.ts"

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

describe("no re-preguntar lo que el cliente ya dio (regla Eduardo, 26-jul)", () => {
  const SEMILLA_VENTA = {
    empresa: { nombre: "Transportes Viig SpA", identificador: "77.861.333-6" },
  }

  test("la cotización pagada siembra el borrador: empresa deja de estar pendiente", () => {
    const b = sembrarBorrador(null, SEMILLA_VENTA, "cl")
    const pendientes = camposPendientes(b)
    assert.ok(!pendientes.includes("empresa.nombre"))
    assert.ok(!pendientes.includes("empresa.identificador"))
    assert.ok(pendientes.includes("admin.email"), "lo del admin sí sigue pendiente")
  })

  test("lo que el cliente dijo EN LA FASE le gana a la semilla de la venta", () => {
    // El cliente pudo haber corregido la razón social antes de que llegara el
    // pago (webhook y cron corren en paralelo): su versión no se pisa.
    const previo = aplicarDatos(borradorVacio("cl"), {
      empresa: { nombre: "Viig Logística SpA" },
      admin: { nombre: "Pablo" },
    })
    const b = sembrarBorrador(previo, SEMILLA_VENTA, "cl")
    assert.equal(b.empresa.nombre, "Viig Logística SpA")
    assert.equal(b.empresa.identificador, "77.861.333-6", "lo no dicho sí se siembra")
    assert.equal(b.admin.nombre, "Pablo")
  })

  test("kickoff sembrado: CONFIRMA los datos de la venta en vez de pedirlos", () => {
    const k = mensajeKickoffCL(sembrarBorrador(null, SEMILLA_VENTA, "cl"))
    assert.match(k, /De tu cotización ya tengo/)
    assert.match(k, /Transportes Viig SpA/)
    assert.match(k, /77861333-6/, "el RUT se muestra normalizado")
    assert.match(k, /Los usamos tal cual\?/)
    assert.ok(!/me das la razón social/.test(k), "no puede pedir lo que ya tiene")
    assert.match(k, /quién va a administrar/, "pasa directo a lo que SÍ falta")
  })

  test("kickoff sembrado respeta estilo y autonomía igual que el vacío", () => {
    const k = mensajeKickoffCL(sembrarBorrador(null, SEMILLA_VENTA, "cl"))
    assert.ok(!FUGA_EJECUTIVO.test(k))
    assert.ok(!/\bOye\b/.test(k))
    assert.ok(!/[¿¡*]/.test(k))
    assert.ok(!/https?:\/\//.test(k))
  })

  test("una semilla con RUT raro no revienta el kickoff (se muestra crudo)", () => {
    const k = mensajeKickoffCL(
      sembrarBorrador(null, { empresa: { nombre: "Viig SpA", identificador: "77-B" } }, "cl"),
    )
    assert.match(k, /77-B/)
  })

  test("el prompt lleva la regla de no re-preguntar", () => {
    const p = promptOnboardingCL(borradorVacio("cl"), { altaSolicitada: false })
    assert.match(p, /NUNCA vuelvas a preguntar un dato que ya figure como guardado/)
    const conDatos = promptOnboardingCL(sembrarBorrador(null, SEMILLA_VENTA, "cl"), {
      altaSolicitada: false,
    })
    assert.match(conDatos, /NO se vuelven a preguntar; solo confirmar o actualizar/)
  })
})

describe("las DOS puertas al post-pago llegan al mismo lugar", () => {
  // Decisión 26-jul: el alta ya no se deriva al wizard web por ninguna vía.
  // Pago online → cerrarYTraspasarPostPago → mensajeKickoffCL
  // Comprobante  → registrarComprobante      → mensajeKickoffComprobanteCL
  const SEMILLA = { empresa: { nombre: "Transportes Viig SpA", identificador: "77.861.333-6" } }
  const b = sembrarBorrador(null, SEMILLA, "cl")

  test("NINGUNA de las dos manda link del wizard", () => {
    for (const [via, msg] of [
      ["pago online", mensajeKickoffCL(b)],
      ["comprobante", mensajeKickoffComprobanteCL("$890.000", b)],
    ] as const) {
      assert.ok(!/https?:\/\//.test(msg), `${via} sigue mandando un link`)
      assert.ok(!/onboarding-geovictoria|auto-onboarding/i.test(msg), `${via} menciona el wizard`)
    }
  })

  test("las dos abren el alta por chat con los datos ya sembrados", () => {
    for (const [via, msg] of [
      ["pago online", mensajeKickoffCL(b)],
      ["comprobante", mensajeKickoffComprobanteCL("$890.000", b)],
    ] as const) {
      assert.match(msg, /por este mismo chat/, `${via} no abre el alta en el chat`)
      assert.match(msg, /Transportes Viig SpA/, `${via} no confirma la empresa`)
      assert.match(msg, /77861333-6/, `${via} no confirma el RUT normalizado`)
      assert.match(msg, /quién va a administrar/, `${via} no pide el administrador`)
      assert.ok(!FUGA_EJECUTIVO.test(msg), `${via} filtra un ejecutivo`)
    }
  })

  test("el comprobante NUNCA afirma que el pago quedó confirmado", () => {
    // Regla dura: se confirma la RECEPCIÓN, no el dinero. La verificación del
    // abono corre en paralelo (validación blanda).
    const msg = mensajeKickoffComprobanteCL("$890.000", b)
    assert.match(msg, /Recibí tu comprobante por \$890\.000/)
    assert.ok(
      !/pago (fue )?(confirmad|verificad|acreditad|procesad)/i.test(msg),
      `afirma confirmación del pago: ${msg}`,
    )
    assert.ok(!/\bpago quedó registrado\b/.test(msg), "esa frase es de la vía del pago online")
  })

  test("la vía del pago online sí puede afirmar el pago", () => {
    // Ahí el cobro es firme, así que la afirmación es cierta.
    assert.match(mensajeKickoffCL(b), /pago quedó registrado/)
  })

  test("ambas respetan el estilo de Vicky", () => {
    for (const msg of [mensajeKickoffCL(b), mensajeKickoffComprobanteCL("$890.000", b)]) {
      assert.ok(!/\bOye\b/.test(msg))
      assert.ok(!/[¿¡]/.test(msg), "sin signos de apertura")
      assert.ok(!/\*/.test(msg), "sin negritas")
    }
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
    assert.match(p, /Datos ya guardados \(NO se vuelven a preguntar/)
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
