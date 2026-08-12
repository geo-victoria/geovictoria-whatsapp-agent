/**
 * DEMOLICIÓN DE LA BIBLIA (Fase 1, 12-ago-2026 — orden de Lalo).
 *
 * El documento "Regla General Vicky WhatsApp" es la spec única de la nueva
 * Vicky y no pueden quedar restos de maquinaria anterior. Este test vigila
 * que lo demolido NO resucite: si alguien re-crea uno de estos archivos o
 * re-cablea una de estas máquinas, la suite se pone roja.
 *
 * Demolido en Fase 1: followup viejo (nudges LLM 1h/23h), Dapta completo
 * (voz + post-llamada + despachador), reactivación vieja 47h/7d/15d + hook
 * ?to=, válvula de precio, toque sabatino, webhook legacy y hook test:true
 * del outbound. Reemplaza a tests/dapta-apagado.test.ts.
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

const RAIZ = new URL("..", import.meta.url).pathname

describe("archivos demolidos que no deben volver", () => {
  const BORRADOS = [
    "app/api/vic-followup-cron/route.ts",
    "app/api/vic-dapta-postcall/route.ts",
    "app/api/vic-sales-agent-v3/route.ts",
    "lib/dapta-voice.ts",
    "lib/dapta-verify.ts",
  ]
  for (const f of BORRADOS) {
    test(`${f} no existe`, () => {
      assert.equal(existsSync(join(RAIZ, f)), false, `${f} resucitó — la biblia lo demolió el 12-ago`)
    })
  }
})

describe("máquinas extirpadas de los crons vivos", () => {
  const LOOP = readFileSync(join(RAIZ, "app/api/vic-loop-cron/route.ts"), "utf8")
  const PTV = readFileSync(join(RAIZ, "app/api/vic-ptv-cron/route.ts"), "utf8")
  const REACT = readFileSync(join(RAIZ, "app/api/vic-reactivation-cron/route.ts"), "utf8")
  const CALLBACK = readFileSync(join(RAIZ, "app/api/vic-callback-cron/route.ts"), "utf8")
  const OUTBOUND = readFileSync(join(RAIZ, "app/api/vic-outbound-lead/route.ts"), "utf8")
  const HUERFANOS = readFileSync(join(RAIZ, "lib/despachador-huerfanos.ts"), "utf8")

  test("loop: sin toque sabatino ni llamadas", () => {
    assert.doesNotMatch(LOOP, /toqueSabatino|vic_scheduled_calls|dapta-voice/)
    // Los toques 2-3 siguen siendo WhatsApp con textos propios.
    assert.match(LOOP, /TEXTOS_T2\[stage\]\[paisKey\]/)
    assert.match(LOOP, /TEXTOS_T3\[stage\]\[paisKey\]/)
  })

  test("ptv: sin válvula de precio", () => {
    assert.doesNotMatch(PTV, /abrirValvulasDePrecio|valvula_precio_/)
  })

  test("reactivación: solo queda el consensuado (cadencia vieja y hook ?to= muertos)", () => {
    assert.doesNotMatch(REACT, /REACTIVATION_OLD_ENABLED|searchParams\.get\("to"\)/)
    assert.match(REACT, /enviarConsensuadoLista/)
  })

  test("callback-cron: solo latido del despachador, cero voz", () => {
    assert.doesNotMatch(CALLBACK, /claimDueCallbacks|dapta_flow|llamadaExisteEnDapta|sendBotmaker/i)
    assert.match(CALLBACK, /despacharHuerfanos/)
  })

  test("outbound: sin hook test:true que salte candados", () => {
    assert.doesNotMatch(OUTBOUND, /body\.test === true/)
  })

  test("despachador: el followup viejo fuera de los huérfanos", () => {
    assert.doesNotMatch(HUERFANOS, /vic-followup-cron/)
  })
})

describe("lo que NO se demolió (canal comercial humano)", () => {
  test("registrar_solicitud_callback sigue viva: es un Lead para un HUMANO", () => {
    const TOOL = readFileSync(join(RAIZ, "lib/tools/registrar-solicitud-callback.ts"), "utf8")
    assert.ok(!/dapta|scheduleCallback|vic_scheduled_calls/i.test(TOOL))
    const INDEX = readFileSync(join(RAIZ, "lib/tools/index.ts"), "utf8")
    assert.match(INDEX, /registrarSolicitudCallbackSchema/)
  })
})
