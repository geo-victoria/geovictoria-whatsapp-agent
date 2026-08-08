/**
 * Umbral de venta autónoma (Lalo 08-ago): inbound 20 / outbound 10.
 *
 * Estas reglas son de proceso comercial, no cosméticas: si alguien cambia un
 * default o rompe el rollback clásico sin darse cuenta, Vicky vuelve a vender
 * sola hasta 50 (o deja de vender del todo). Un test se acuerda.
 */

import { test, describe, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import {
  SCOPE_MAX_SISTEMA,
  umbralInbound,
  umbralOutbound,
  formatUmbralParaPrompt,
} from "../lib/umbral-autonomia.ts"

beforeEach(() => {
  delete process.env.VICKY_UMBRAL_CLASICO
  delete process.env.VICKY_UMBRAL_INBOUND
  delete process.env.VICKY_UMBRAL_OUTBOUND
})

describe("umbrales por defecto (doc 08-ago)", () => {
  test("inbound 20 / outbound 10, dentro del tope del sistema (50)", () => {
    assert.equal(umbralInbound(), 20)
    assert.equal(umbralOutbound(), 10)
    assert.equal(SCOPE_MAX_SISTEMA, 50)
  })

  test("overrides por env, con bounds sanos (1..50)", () => {
    process.env.VICKY_UMBRAL_INBOUND = "30"
    process.env.VICKY_UMBRAL_OUTBOUND = "15"
    assert.equal(umbralInbound(), 30)
    assert.equal(umbralOutbound(), 15)
    // Valores fuera de rango o basura NO se aceptan: vuelven al default.
    process.env.VICKY_UMBRAL_INBOUND = "0"
    process.env.VICKY_UMBRAL_OUTBOUND = "99"
    assert.equal(umbralInbound(), 20)
    assert.equal(umbralOutbound(), 10)
  })

  test("rollback clásico: VICKY_UMBRAL_CLASICO=1 vuelve al 50/50", () => {
    process.env.VICKY_UMBRAL_CLASICO = "1"
    assert.equal(umbralInbound(), 50)
    assert.equal(umbralOutbound(), 50)
  })
})

describe("bloque de prompt", () => {
  test("con umbral 50 (clásico) el bloque es vacío — nada cambia", () => {
    assert.equal(formatUmbralParaPrompt(50, "inbound"), "")
  })

  test("bajo 50 declara umbral, derivación y acompañamiento", () => {
    const bloque = formatUmbralParaPrompt(20, "inbound")
    assert.match(bloque, /SOLO hasta 20 trabajadores/)
    assert.match(bloque, /INBOUND/)
    // La derivación nombra la tool y el motivo EXACTOS del toolset CL.
    assert.match(bloque, /derivar_a_soporte/)
    assert.match(bloque, /fuera_de_rango_trabajadores/)
    // Lo aprendido (Lalo 08-ago): Vicky acompaña, no abandona.
    assert.match(bloque, /ACOMPAÑA/)
    assert.match(bloque, /agendar_reunion/)
    // El >50 conserva su flujo enterprise.
    assert.match(bloque, /MÁS de 50 trabajadores no cambia/)
  })

  test("outbound usa su propio umbral en el texto", () => {
    const bloque = formatUmbralParaPrompt(10, "outbound")
    assert.match(bloque, /SOLO hasta 10 trabajadores/)
    assert.match(bloque, /OUTBOUND/)
  })
})

describe("puntos de decisión del prompt CL reescritos con el umbral", () => {
  // getSystemPromptV3(contact, umbral) reescribe las líneas del FLUJO por
  // .replace() de cadenas EXACTAS (la E2E del 08-ago mostró que el modelo
  // obedece el flujo por sobre el preámbulo). El prompt usa el alias "@/lib"
  // (no importable desde el runner de node), así que se ancla por CONTENIDO:
  // si alguien edita esas líneas del prompt sin actualizar los replace, el
  // replace deja de matchear en silencio — este test lo hace reventar.
  const fuente = readFileSync(
    new URL("../app/api/vic-sales-agent-v3/prompt.ts", import.meta.url),
    "utf8",
  )

  test("las cuatro cadenas objetivo del replace siguen en el prompt", () => {
    for (const objetivo of [
      "- Si tiene 1-50 → puede cotizar (Modo Cotización).",
      '- Si tiene 50+ → no cotiza, pregunta "Prefieres reunión o callback?".',
      "Aplica cuando: el usuario pidió cotizar Y tiene entre 1 y 50 trabajadores.",
      "Cuando el camino es cotizar (1-50 trabajadores), sigue este orden:",
      "2. Cotizar — generar una cotización formal con PDF. Solo para empresas de 1 a 50 trabajadores.",
      "El ÚNICO tope de scope es la cantidad de TRABAJADORES (1 a 50).",
      "Una empresa de 43 trabajadores en 50 sucursales se cotiza igual que una en 1 oficina",
      "si las personas están dentro de 1-50, cotizas, tenga los puntos que tenga.",
      "Si el total sumado está entre 1 y 50, cotiza normal:",
      "— calcula un estimado mensual. Solo funciona para 1-50 trabajadores.",
    ]) {
      // Aparecen DOS veces: en el template del prompt y en el .replace().
      const veces = fuente.split(objetivo).length - 1
      assert.ok(
        veces >= 2,
        `la cadena ancla "${objetivo.slice(0, 40)}…" aparece ${veces} vez/veces — el replace de getSystemPromptV3 quedó desincronizado del prompt`,
      )
    }
  })

  test("los reemplazos dinámicos usan el umbral", () => {
    assert.match(fuente, /Si tiene 1-\$\{u\} → puede cotizar/)
    assert.match(fuente, /Si tiene MÁS de \$\{u\} y hasta 50/)
    assert.match(fuente, /entre 1 y \$\{u\} trabajadores/)
    assert.match(fuente, /Cuando el camino es cotizar \(1-\$\{u\} trabajadores\)/)
  })
})
