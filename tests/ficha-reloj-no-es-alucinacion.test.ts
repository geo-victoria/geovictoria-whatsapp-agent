/**
 * El guardrail de URL del cotizador respeta la PROCEDENCIA de las tools.
 *
 * CASO REAL (+56958112916, 29-jul 11:14): el cliente pidió "me envías las
 * características del huellero". Vicky llamó enviar_ficha_reloj (tool OK) y
 * respondió con la URL real de la ficha — que vive en
 * cotizacion.geovictoria.com/pdf/assets/. El guardrail anti-alucinación solo
 * aceptaba las 3 tools de cotización, así que fusiló DOS VECES la respuesta
 * correcta y contestó "tuve un problema generando tu cotización formal" a
 * alguien que preguntó por especificaciones. Doble daño: no respondió lo
 * preguntado y confesó un problema inexistente.
 *
 * La regla que queda (la misma de links-de-tools): si TODAS las URLs del
 * cotizador presentes en el reply salieron del output de una tool exitosa de
 * ESTE turno, el link es del backend — no hay alucinación que bloquear.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const RAIZ = new URL("..", import.meta.url).pathname
const V3 = readFileSync(join(RAIZ, "app/api/vic-botmaker-v3/route.ts"), "utf8")

describe("guardrail ALUCINACIÓN_URL con procedencia (webhook v3)", () => {
  test("calcula si las URLs del reply vienen de tools del turno", () => {
    assert.match(V3, /const urlsToolsTurno = urlsDeToolsDelTurno\(toolCalls\)/)
    assert.match(V3, /urlsCotizadorReply\.every\(\(u\) => vieneDeUnaTool\(u, urlsToolsTurno\)\)/)
  })

  test("y esa procedencia forma parte de la condición de disparo", () => {
    assert.match(V3, /!reenviaLinkConocido &&\s*\n\s*!urlsVienenDeTools/)
  })

  test("el reintento también acepta URLs con procedencia de tool", () => {
    assert.match(V3, /const retryUrlsDeTools = urlsDeToolsDelTurno\(retryTools\)/)
    assert.match(V3, /retryReal \|\| retryLinkConocido \|\| retryVieneDeTools \|\| !retryTieneUrl/)
  })
})
