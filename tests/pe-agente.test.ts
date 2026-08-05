/**
 * Vicky PERÚ Fase 1b — anclas del prompt, las tools y el gate del webhook.
 *
 * Cada ancla protege una regla de negocio del excel de tropicalización (VB
 * Diego 05-ago) que ya se rompió al menos una vez en otros países cuando se
 * editó un prompt sin acordarse de la regla:
 *   - SUNAFIL sin claims de certificación, y JAMÁS la normativa chilena
 *     (Res. 38 / Dirección del Trabajo) en boca de Vicky PE.
 *   - El 20% x 4 primeras facturas existe SOLO como cierre.
 *   - Sin "Oye" como vocativo (orden de Eduardo, 23-jul).
 *   - Sin cotización formal en Fase 1b: buildDispatchPE NO expone
 *     generar_link_cotizadora (llega en Fase 2).
 *   - El webhook se despliega OSCURO: gate VICKY_PE_ENABLED / vic_kv, y con
 *     el gate apagado sobrevive la contención del 04-ago.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { SYSTEM_PROMPT_PE, getSystemPromptPE } from "../lib/paises/pe/prompt.ts"
import { TOOL_SCHEMAS_PE, buildDispatchPE } from "../lib/paises/pe/tools.ts"

const RAIZ = new URL("..", import.meta.url).pathname
const ROUTE_PE = readFileSync(join(RAIZ, "app/api/vic-botmaker-pe/route.ts"), "utf8")

describe("prompt PE — legal peruano", () => {
  test("SUNAFIL es el ente fiscalizador y está en el prompt", () => {
    assert.match(SYSTEM_PROMPT_PE, /SUNAFIL/)
  })

  test("prohíbe la Resolución 38 y la DT chilena (no basta con omitirlas)", () => {
    // La línea que las menciona debe ser una PROHIBICIÓN explícita.
    const linea = SYSTEM_PROMPT_PE.split("\n").find((l) => /Resoluci[oó]n 38/.test(l)) || ""
    assert.ok(linea, "el prompt debe prohibir explícitamente la Resolución 38")
    assert.match(linea, /NUNCA|PROHIBIDO|jam[aá]s/i)
    const lineaDT = SYSTEM_PROMPT_PE.split("\n").find((l) => /Direcci[oó]n del Trabajo/.test(l)) || ""
    assert.ok(lineaDT, "el prompt debe prohibir explícitamente la DT chilena")
    assert.match(lineaDT, /NUNCA|PROHIBIDO|jam[aá]s/i)
    // Y nada de prometer certificaciones (no existen en Perú).
    assert.match(SYSTEM_PROMPT_PE, /PROHIBIDO prometer o insinuar/i)
  })

  test("protección de datos: Ley 29733, sin asesoría legal", () => {
    assert.match(SYSTEM_PROMPT_PE, /29733/)
  })
})

describe("prompt PE — descuento 20% SOLO como cierre", () => {
  test("la regla existe: 20%, 4 primeras facturas, como CIERRE", () => {
    assert.match(SYSTEM_PROMPT_PE, /20%/)
    assert.match(SYSTEM_PROMPT_PE, /4 (PRIMERAS FACTURAS|primeras facturas)/i)
    assert.match(SYSTEM_PROMPT_PE, /herramienta de CIERRE|como cierre/i)
  })

  test("y jamás proactivo ni de entrada", () => {
    assert.match(SYSTEM_PROMPT_PE, /JAM[ÁA]S lo ofrezcas de entrada/i)
  })

  test("el monto rebajado lo entrega la tool (nunca el modelo)", () => {
    assert.match(SYSTEM_PROMPT_PE, /conDescuentoCierre/)
    assert.match(SYSTEM_PROMPT_PE, /NUNCA calcules t[uú] el 20%/i)
  })
})

describe("prompt PE — estilo", () => {
  test("'Oye' aparece SOLO en la línea que lo prohíbe (nunca como saludo)", () => {
    const lineasConOye = getSystemPromptPE("51999999999")
      .split("\n")
      .filter((l) => /\bOye\b/.test(l))
    assert.ok(lineasConOye.length >= 1, "la prohibición de 'Oye' debe estar escrita")
    for (const l of lineasConOye) {
      assert.match(l, /PROHIBIDO|NUNCA|jam[aá]s/i, `"Oye" fuera de una prohibición: ${l.slice(0, 100)}`)
    }
  })

  test("sin precios hardcodeados en el prompt (los montos viven en las tools)", () => {
    // Ningún monto en soles escrito a mano: ni S/70, ni S/525, ni S/100.
    assert.doesNotMatch(SYSTEM_PROMPT_PE, /S\/\s?\d/)
  })

  test("sin capacitación como oferta (en Perú no existe)", () => {
    // La única mención permitida es la regla que ordena NO mencionarla.
    const lineas = SYSTEM_PROMPT_PE.split("\n").filter((l) => /capacitaci[oó]n/i.test(l))
    for (const l of lineas) {
      assert.match(
        l,
        /NO existe|no la menciones|Sin capacitaci[oó]n/i,
        `capacitación ofrecida en: ${l.slice(0, 120)}`,
      )
    }
  })
})

describe("tools PE — superficie Fase 1b", () => {
  const nombres = TOOL_SCHEMAS_PE.map((s) => (s as { name: string }).name)

  test("expone cotizar_referencial y derivar_a_ejecutivo", () => {
    assert.ok(nombres.includes("cotizar_referencial"))
    assert.ok(nombres.includes("derivar_a_ejecutivo"))
  })

  test("NO expone generar_link_cotizadora (formal = Fase 2) ni agenda", () => {
    assert.ok(!nombres.includes("generar_link_cotizadora"))
    assert.ok(!nombres.includes("agendar_reunion"))
    assert.ok(!nombres.includes("consultar_disponibilidad_horario"))
  })

  test("el dispatch tampoco la atiende por la puerta de atrás", async () => {
    const dispatch = buildDispatchPE("51999999999")
    const r = (await dispatch("generar_link_cotizadora", {})) as { ok: boolean; error?: string }
    assert.equal(r.ok, false)
    assert.match(r.error || "", /desconocida/i)
  })

  test("cotizar_referencial: ejemplo confirmado (15p + reloj arriendo) vía dispatch", async () => {
    const dispatch = buildDispatchPE("51999999999")
    const r = (await dispatch("cotizar_referencial", {
      userCount: 15,
      reloj: { modalidad: "arriendo", cantidad: 1 },
      puntosInstalacion: [{ ubicacion: "Lima", zona: "lima", autoInstalada: false }],
    })) as { ok: boolean; mensajeParaProspecto?: string }
    assert.equal(r.ok, true)
    assert.ok(r.mensajeParaProspecto?.includes("S/318.60")) // IGV 18% incluido
  })

  test("cotizar_referencial con conDescuentoCierre entrega el monto del 20%", async () => {
    const dispatch = buildDispatchPE("51999999999")
    const r = (await dispatch("cotizar_referencial", {
      userCount: 15,
      reloj: { modalidad: "arriendo", cantidad: 1 },
      conDescuentoCierre: true,
    })) as { ok: boolean; mensajeParaProspecto?: string }
    assert.equal(r.ok, true)
    assert.ok(r.mensajeParaProspecto?.includes("S/254.88"))
    assert.ok(r.mensajeParaProspecto?.includes("4 primeras facturas"))
  })

  test("reloj en VENTA sin puntos → error accionable (no cotiza a ciegas)", async () => {
    const dispatch = buildDispatchPE("51999999999")
    const r = (await dispatch("cotizar_referencial", {
      userCount: 10,
      reloj: { modalidad: "venta", cantidad: 1 },
    })) as { ok: boolean; error?: string }
    assert.equal(r.ok, false)
    assert.match(r.error || "", /puntosInstalacion/)
  })
})

describe("webhook PE — gate de encendido y contención", () => {
  test("el gate existe: env VICKY_PE_ENABLED + vic_kv vicky_pe_enabled", () => {
    assert.match(ROUTE_PE, /VICKY_PE_ENABLED/)
    assert.match(ROUTE_PE, /vicky_pe_enabled/)
  })

  test("con el gate apagado sobrevive la contención del 04-ago", () => {
    // Las tres piezas de la contención original: saludo 1x/24h (pe_hold),
    // persistencia country "pe" y aviso interno.
    assert.match(ROUTE_PE, /pe_hold_/)
    assert.match(ROUTE_PE, /Gracias por escribir a GeoVictoria Per[uú]/)
    assert.match(ROUTE_PE, /responderContencion/)
  })

  test("misma validación de secret que la contención (env o vic_kv)", () => {
    assert.match(ROUTE_PE, /BOTMAKER_SECRET_PE/)
    assert.match(ROUTE_PE, /botmaker_secret_pe/)
  })

  test("el agente real corre con prompt y tools PE, country 'pe'", () => {
    assert.match(ROUTE_PE, /getSystemPromptPE/)
    assert.match(ROUTE_PE, /buildDispatchPE/)
    assert.match(ROUTE_PE, /appendTurnV3\(contact, message, reply, "pe"\)/)
  })
})
