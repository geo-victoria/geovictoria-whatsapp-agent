/**
 * Las llamadas automáticas (Dapta) están APAGADAS en todos los países.
 *
 * DECISIÓN (Eduardo, 27-jul). El motivo no es que molesten: es que no ocurrían
 * y el sistema decía que sí. El propio callback-cron lo registraba:
 *
 *   [callback-cron] llamada … marcada disparada pero NO existe en Dapta
 *
 * 6 de 6 llamadas del 27-jul cayeron así — `status: done` y `fired_at` puesto
 * en nuestra base, sin existir del otro lado. El daño mayor es aguas abajo: en
 * el seguimiento comercial quedaban como "no contesta", indistinguibles de un
 * rechazo real, y con eso se le bajaba la prioridad a clientes a los que nunca
 * se llamó (3 de los 12 "no contesta" del Excel de Anderson venían de ahí).
 *
 * La ausencia de la variable APAGA. No hay que tocar Vercel para detenerlo.
 */

import { test, describe, afterEach } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { llamadasDaptaHabilitadas } from "../lib/dapta-voice.ts"

const RAIZ = new URL("..", import.meta.url).pathname

afterEach(() => {
  delete process.env.DAPTA_ENABLED
})

describe("interruptor de llamadas Dapta", () => {
  test("sin la variable, APAGADO", () => {
    assert.equal(llamadasDaptaHabilitadas(), false)
  })

  test("solo 'on' lo enciende — cualquier otro valor deja apagado", () => {
    for (const v of ["", "off", "true", "1", "ON ", "si"]) {
      process.env.DAPTA_ENABLED = v
      assert.equal(llamadasDaptaHabilitadas(), v.trim().toLowerCase() === "on", `valor: ${JSON.stringify(v)}`)
    }
  })
})

describe("los tres puntos donde nacía o se disparaba una llamada", () => {
  const DAPTA = readFileSync(join(RAIZ, "lib/dapta-voice.ts"), "utf8")
  const LOOP = readFileSync(join(RAIZ, "app/api/vic-loop-cron/route.ts"), "utf8")

  test("scheduleCallback no agenda con el interruptor apagado", () => {
    assert.match(
      DAPTA,
      /export async function scheduleCallback[\s\S]{0,240}?if \(!llamadasDaptaHabilitadas\(\)\) return false/,
    )
  })

  test("claimDueCallbacks no dispara ni filas viejas que quedaran en cola", () => {
    assert.match(
      DAPTA,
      /export async function claimDueCallbacks[\s\S]{0,320}?if \(!llamadasDaptaHabilitadas\(\)\) return \[\]/,
    )
  })

  test("el loop salta el toque de llamada y AVANZA la cadencia", () => {
    // Sin marcar ejecutado, el loop se quedaría trabado reintentando el mismo
    // toque en cada tick y el cliente no recibiría nunca el siguiente WhatsApp.
    assert.match(LOOP, /touch === 2 \|\| touch === 3\) && !llamadasDaptaHabilitadas\(\)/)
    assert.match(LOOP, /skip: "dapta apagado"/)
  })
})

describe("lo que NO se apagó", () => {
  test("registrar_solicitud_callback sigue viva: es un Lead para un HUMANO", () => {
    // Esa tool crea un Lead en Zoho para que llame una persona. No toca Dapta
    // ni vic_scheduled_calls, así que apagarla habría sido apagar el canal
    // comercial equivocado.
    const TOOL = readFileSync(join(RAIZ, "lib/tools/registrar-solicitud-callback.ts"), "utf8")
    assert.ok(!/dapta|scheduleCallback|vic_scheduled_calls/i.test(TOOL))
    const INDEX = readFileSync(join(RAIZ, "lib/tools/index.ts"), "utf8")
    assert.match(INDEX, /registrarSolicitudCallbackSchema/)
  })
})
