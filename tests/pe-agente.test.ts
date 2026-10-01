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
 *   - Fase 2 (11-ago): generar_link_cotizadora expuesta — se validan RUC,
 *     correo y puntos ANTES de tocar la red (errores accionables al modelo).
 *   - El webhook se despliega OSCURO: gate VICKY_PE_ENABLED / vic_kv, y con
 *     el gate apagado sobrevive la contención del 04-ago.
 */

// Dólar SUNAT fijo para los tests: sin red ni caché.
process.env.VICKY_PE_TC_USD = "3.372"
process.env.VICKY_PE_TC_USD_FORZAR = "1"

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
// Perú es el núcleo armado con su ficha desde el 26-sep (el prompt propio se
// retiró): las reglas se verifican sobre lo que ve el cliente.
import { getSystemPromptPENucleo } from "../lib/paises/pe/prompt-nucleo.ts"
import { FICHA_PE } from "../lib/paises/pe/ficha.ts"
const SYSTEM_PROMPT_PE = getSystemPromptPENucleo("51999999999")
const getSystemPromptPE = (c: string) => getSystemPromptPENucleo(c)
import { TOOL_SCHEMAS_PE, buildDispatchPE } from "../lib/paises/pe/tools.ts"

const RAIZ = new URL("..", import.meta.url).pathname
const ROUTE_PE = readFileSync(join(RAIZ, "app/api/vic-botmaker-pe/route.ts"), "utf8")

describe("prompt PE — legal peruano", () => {
  test("SUNAFIL es el ente fiscalizador y está en el prompt", () => {
    assert.match(SYSTEM_PROMPT_PE, /SUNAFIL/)
  })

  test("no cita normas chilenas y prohíbe prometer certificación", () => {
    // Ninguna línea puede citar la Resolución 38 ni la DT chilena salvo para prohibirlas.
    for (const l of SYSTEM_PROMPT_PE.split("\n").filter((x) => /Resoluci[oó]n 38|Direcci[oó]n del Trabajo/.test(x))) {
      assert.match(l, /NUNCA|PROHIBIDO|jam[aá]s/i, l.slice(0, 120))
    }
    assert.match(SYSTEM_PROMPT_PE, /SUNAFIL no certifica ni aprueba sistemas/)
    assert.match(SYSTEM_PROMPT_PE, /jam[aá]s cites normas extranjeras/i)
  })

  test("protección de datos: Ley 29733, sin asesoría legal", () => {
    assert.match(SYSTEM_PROMPT_PE, /29733/)
  })
})

describe("prompt PE — descuento 20% SOLO como cierre", () => {
  test("la regla existe: escalera 10 → 20 % en el plan, 6 meses, solo ante objeción (= Chile)", () => {
    assert.match(SYSTEM_PROMPT_PE, /10%/)
    assert.match(SYSTEM_PROMPT_PE, /20%/)
    assert.match(SYSTEM_PROMPT_PE, /6 meses/)
    assert.match(SYSTEM_PROMPT_PE, /objeci[oó]n de PRECIO/i)
    // Muere el "20 % en las 4 primeras facturas" del 04-ago.
    assert.doesNotMatch(SYSTEM_PROMPT_PE, /4 primeras facturas/i)
  })

  // "Jamás de entrada" y "el monto lo entrega la tool" son reglas GLOBALES del
  // núcleo (descuento_solo_por_objecion en lib/paridad-prompt): las mide
  // tests/paridad-prompt para los cuatro países.
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
    // Excepción: los ejemplos de la ficha (FICHA_PE.ejemploMonto*), texto
    // ilustrativo con el precio vigente del tramo 1-10, no una tarifa.
    let resto = SYSTEM_PROMPT_PE
    for (const ej of [FICHA_PE.ejemploMonto, FICHA_PE.ejemploMontoApp, FICHA_PE.ejemploPresupuesto]) resto = resto.split(ej).join("")
    assert.doesNotMatch(resto, /S\/\s?\d/)
  })

  // Desde el 21-sep Perú SÍ capacita (alta por chat con los relatores de
  // Chile): el test "sin capacitación como oferta" se retiró el 26-sep.
})

describe("tools PE — superficie Fase 1b", () => {
  const nombres = TOOL_SCHEMAS_PE.map((s) => (s as { name: string }).name)

  test("expone cotizar_referencial y derivar_a_ejecutivo", () => {
    assert.ok(nombres.includes("cotizar_referencial"))
    assert.ok(nombres.includes("derivar_a_ejecutivo"))
  })

  test("Fase 2: expone generar_link_cotizadora (formal PE); agenda sigue fuera", () => {
    assert.ok(nombres.includes("generar_link_cotizadora"))
    assert.ok(!nombres.includes("agendar_reunion"))
    assert.ok(!nombres.includes("consultar_disponibilidad_horario"))
  })

  test("generar_link_cotizadora: RUC inválido → error accionable ANTES de la red", async () => {
    const dispatch = buildDispatchPE("51999999999")
    const r = (await dispatch("generar_link_cotizadora", {
      empresa: "Prueba SAC",
      contacto: "Juan Pérez",
      email: "juan@prueba.pe",
      ruc: "12345678901", // prefijo 12 no existe en SUNAT
      userCount: 10,
    })) as { ok: boolean; error?: string }
    assert.equal(r.ok, false)
    assert.match(r.error || "", /RUC/)
  })

  test("generar_link_cotizadora: correo inválido → error accionable", async () => {
    const dispatch = buildDispatchPE("51999999999")
    const r = (await dispatch("generar_link_cotizadora", {
      empresa: "Prueba SAC",
      contacto: "Juan Pérez",
      email: "no-es-correo",
      ruc: "20605842055", // RUC real de la entidad (checksum válido)
      userCount: 10,
    })) as { ok: boolean; error?: string }
    assert.equal(r.ok, false)
    assert.match(r.error || "", /correo/i)
  })

  test("generar_link_cotizadora: reloj en VENTA sin puntos → error accionable", async () => {
    const dispatch = buildDispatchPE("51999999999")
    const r = (await dispatch("generar_link_cotizadora", {
      empresa: "Prueba SAC",
      contacto: "Juan Pérez",
      email: "juan@prueba.pe",
      ruc: "20605842055",
      userCount: 10,
      reloj: { modalidad: "venta", cantidad: 1 },
    })) as { ok: boolean; error?: string }
    assert.equal(r.ok, false)
    assert.match(r.error || "", /puntosInstalacion|secreto/i)
  })

  test("cotizar_referencial: ejemplo confirmado (15p + reloj arriendo) vía dispatch", async () => {
    const dispatch = buildDispatchPE("51999999999")
    const r = (await dispatch("cotizar_referencial", {
      userCount: 15,
      reloj: { modalidad: "arriendo", cantidad: 1 },
      puntosInstalacion: [{ ubicacion: "Lima", zona: "lima", autoInstalada: false }],
    })) as { ok: boolean; mensajeParaProspecto?: string }
    assert.equal(r.ok, true)
    assert.ok(r.mensajeParaProspecto?.includes("S/157 + IGV")) // neto + IGV (TC fijo 3,372, arriendo US$20; plan 15 × S/6)
  })

  test("cotizar_referencial con escalonDescuento=2 entrega el monto con el 20 % del plan", async () => {
    const dispatch = buildDispatchPE("51999999999")
    const r = (await dispatch("cotizar_referencial", {
      userCount: 15,
      reloj: { modalidad: "arriendo", cantidad: 1 },
      escalonDescuento: 2,
    })) as { ok: boolean; escalonDescuento?: number; mensajeParaProspecto?: string }
    assert.equal(r.ok, true)
    assert.equal(r.escalonDescuento, 2)
    assert.ok(r.mensajeParaProspecto?.includes("S/139 + IGV")) // plan 90 × 0,8 = 72 + arriendo 67
    assert.ok(r.mensajeParaProspecto?.includes("6 meses"))
    // Compatibilidad: el flag viejo equivale al primer escalón (10 %).
    const viejo = (await dispatch("cotizar_referencial", {
      userCount: 15,
      conDescuentoCierre: true,
    })) as { ok: boolean; escalonDescuento?: number }
    assert.equal(viejo.escalonDescuento, 1)
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

  test("el agente real corre por el orquestador con el perfil PE, country 'pe'", () => {
    // El turno corre por el orquestador único con el perfil PE (26-sep).
    assert.match(ROUTE_PE, /procesarTurno\(contact, combinado, apiKey, PERFIL_TURNO_PE\)/)
    assert.match(ROUTE_PE, /appendTurnV3\([^)]*"pe"\)/)
  })
})
