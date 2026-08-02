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
import { promptOnboardingCL, acuseComprobanteCL } from "../lib/onboarding/prompt.ts"
import {
  TOOL_GUARDAR_DATOS_ONBOARDING,
  TOOL_CONFIRMAR_ALTA_EMPRESA,
} from "../lib/onboarding/tools.ts"
import {
  PLANTILLA_ONBOARDING_CL,
  paramsPlantillaOnboarding,
  renderPlantillaOnboarding,
} from "../lib/onboarding/plantilla.ts"
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

  test("el arranque CONFIRMA los datos de la venta en vez de pedirlos", () => {
    const k = renderPlantillaOnboarding(paramsPlantillaOnboarding("Transportes Viig SpA", "77861333-6"))
    assert.match(k, /Transportes Viig SpA/)
    assert.match(k, /77861333-6/)
    assert.match(k, /Los usamos tal cual\?/)
    assert.ok(!/me das la razón social/.test(k), "no puede pedir lo que ya tiene")
    assert.match(k, /quién va a administrar/, "pasa directo a lo que SÍ falta")
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

describe("EL mensaje de arranque: uno solo para todos los casos", () => {
  // Decisión Eduardo 26-jul: la misma plantilla para las dos vías de pago y
  // para dentro y fuera de la ventana de 24 h. Fuera de ventana el texto libre
  // muere en silencio — el que acaba de pagar no recibe nada.
  const RENDER = renderPlantillaOnboarding(
    paramsPlantillaOnboarding("BluePay Chile SPA", "78387633-7"),
  )

  test("una sola fuente de verdad: el texto libre SE RENDERIZA del body", () => {
    // Si alguien edita una de las dos redacciones, esto falla. No pueden
    // separarse con el tiempo porque no hay dos redacciones.
    const esperado = PLANTILLA_ONBOARDING_CL.body
      .replace("${empresa}", "BluePay Chile SPA")
      .replace("${rut_empresa}", "78387633-7")
    assert.equal(RENDER, esperado)
    assert.ok(!/\$\{/.test(RENDER), `quedó una variable sin resolver: ${RENDER}`)
  })

  test("no afirma el pago: sirve para las DOS vías", () => {
    // Con comprobante está PROHIBIDO decir que el pago quedó confirmado.
    const b = PLANTILLA_ONBOARDING_CL.body
    assert.ok(!/pago|comprobante|transferencia|abonad|acreditad/i.test(b), `menciona el pago: ${b}`)
  })

  test("confirma empresa y RUT tabulados, y pide solo lo que falta", () => {
    assert.match(RENDER, /Empresa: BluePay Chile SPA/)
    assert.match(RENDER, /RUT: 78387633-7/)
    assert.match(RENDER, /Los usamos tal cual\?/)
    assert.match(RENDER, /Si hay que cambiar algo, me dices/, "permiso explícito de corregir")
    assert.match(RENDER, /quién va a administrar/)
    assert.ok(!/https?:\/\//.test(RENDER), "sin links: el alta no va al wizard")
  })

  test("da la bienvenida SIN afirmar que el pago quedó registrado", () => {
    // El texto elegido traía "Tu pago quedó registrado": cierto con tarjeta,
    // FALSO con transferencia (ahí solo se recibió el comprobante; el abono lo
    // verifica finanzas). Como el mensaje es uno solo para las dos vías, la
    // afirmación sale y la bienvenida carga el sentido.
    assert.match(RENDER, /ya eres parte de GeoVictoria/)
    assert.ok(
      !/pago quedó (registrado|confirmado)|recibimos tu pago/i.test(RENDER),
      `afirma algo sobre el pago: ${RENDER}`,
    )
  })

  test("usa la sintaxis de Botmaker, NO la de Meta", () => {
    // Botmaker usa ${variable} con nombre; los {{1}} posicionales de Meta NO
    // se resuelven — saldrían literales al cliente. Verificado contra las 28
    // plantillas vicky_* aprobadas en la cuenta.
    const b = PLANTILLA_ONBOARDING_CL.body
    assert.ok(!/\{\{\d+\}\}/.test(b), `usa la sintaxis de Meta: ${b}`)
    assert.match(b, /\$\{empresa\}/)
    assert.match(b, /\$\{rut_empresa\}/)
  })

  test("los params calzan EXACTO con las variables del body", () => {
    const vars = [...PLANTILLA_ONBOARDING_CL.body.matchAll(/\$\{(\w+)\}/g)].map((m) => m[1])
    assert.deepEqual(vars.sort(), ["empresa", "rut_empresa"])
    assert.deepEqual(Object.keys(paramsPlantillaOnboarding("X", "Y")).sort(), vars.sort())
  })

  test("sin datos no quedan huecos raros en el texto", () => {
    const vacio = renderPlantillaOnboarding(paramsPlantillaOnboarding("", ""))
    assert.ok(!/\$\{/.test(vacio))
    assert.match(vacio, /tu empresa/)
    assert.match(vacio, /el de tu cotización/)
  })

  test("categoría UTILITY, no MARKETING", () => {
    // Post-transacción sobre una cuenta recién contratada. MARKETING tendría
    // peor aprobación y quedaría sujeta a los límites promocionales.
    assert.equal(PLANTILLA_ONBOARDING_CL.category, "UTILITY")
  })

  test("respeta el estilo de Vicky y cabe en el límite de WhatsApp", () => {
    for (const t of [PLANTILLA_ONBOARDING_CL.body, RENDER]) {
      assert.ok(!/\bOye\b/.test(t))
      assert.ok(!/[¿¡*]/.test(t), "sin signos de apertura ni negritas")
      assert.ok(!FUGA_EJECUTIVO.test(t))
      assert.ok(t.length <= 1024, `body de ${t.length} chars, el máximo es 1024`)
    }
  })
})

describe("acuse del comprobante (va aparte del arranque)", () => {
  test("confirma la RECEPCIÓN, nunca el pago", () => {
    const a = acuseComprobanteCL("$890.000")
    assert.match(a, /Recibí tu comprobante por \$890\.000/)
    assert.ok(
      !/pago (fue )?(confirmad|verificad|acreditad|procesad)|pago quedó registrado/i.test(a),
      `afirma el pago: ${a}`,
    )
  })

  test("NO anuncia un mensaje futuro: el cliente no espera nada", () => {
    // Decisión Eduardo 26-jul: la lectura del comprobante con IA es la única
    // medida; el cliente no espera. El acuse va pegado al arranque en UN solo
    // mensaje, así que prometer "te escribo en seguida" sería hacerlo esperar
    // por algo que ya está en la misma pantalla.
    const a = acuseComprobanteCL("$1.000")
    assert.ok(!/en seguida|enseguida|te escribo|más tarde|en unos minutos/i.test(a), a)
  })

  test("respeta el estilo de Vicky", () => {
    const a = acuseComprobanteCL("$890.000")
    assert.ok(!/\bOye\b/.test(a))
    assert.ok(!/[¿¡*]/.test(a))
    assert.ok(!/https?:\/\//.test(a), "sin links")
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

  test("alta ya procesada: prohíbe re-pedir datos y re-confirmar", () => {
    const p = promptOnboardingCL(COMPLETO, { altaSolicitada: true })
    assert.match(p, /YA FUE PROCESADA/)
    assert.match(p, /NO vuelvas a pedir datos/)
    // Con el alta por API la cuenta puede quedar creada AL INSTANTE: el prompt
    // ya no promete "24 horas hábiles" — remite a lo que se le informó.
    assert.match(p, /recuérdale lo que ya se le informó/)
    assert.ok(!p.includes("Datos pendientes"), "no puede volver a listar pendientes")
  })

  test("la pedida de datos explica el ROL del admin y que puede ser otra persona", () => {
    const p = promptOnboardingCL(borradorVacio("cl"), { altaSolicitada: false })
    assert.match(p, /quien compra no siempre administra/)
    assert.match(p, /acceso total/)
    assert.match(p, /el administrador serás tú, u otra persona/)
    assert.match(p, /a ESE correo llegará el acceso/)
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
