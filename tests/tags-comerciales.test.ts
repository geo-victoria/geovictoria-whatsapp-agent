/**
 * Tags de Botmaker por país (Lalo 28-jul): comercial_cl / comercial_co /
 * comercial_mx, para que cada ejecutivo filtre su bandeja "Por tag".
 *
 * La regla que protege este archivo: el tag se aplica por SEÑALES
 * DETERMINISTAS de compra (éxito de tools de venta), nunca por clasificador —
 * así una conversación de SOPORTE es imposible de taguear por accidente.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { paisDeContacto, TOOLS_SENAL_COMERCIAL } from "../lib/botmaker-tags.ts"

const RAIZ = new URL("..", import.meta.url).pathname
const TAGS = readFileSync(join(RAIZ, "lib/botmaker-tags.ts"), "utf8")
const LOOP = readFileSync(join(RAIZ, "lib/agent-loop.ts"), "utf8")

describe("país por prefijo telefónico", () => {
  test("CL, CO y MX se detectan; el resto queda sin tag", () => {
    assert.equal(paisDeContacto("56994696609"), "cl")
    assert.equal(paisDeContacto("+56 9 9469 6609"), "cl")
    assert.equal(paisDeContacto("573112895086"), "co")
    assert.equal(paisDeContacto("5215659778486"), "mx")
    assert.equal(paisDeContacto("5491147038123"), null) // Argentina: sin tag
    assert.equal(paisDeContacto("51983464296"), null) // Perú: sin tag
    assert.equal(paisDeContacto(""), null)
  })
})

describe("las señales comerciales excluyen soporte por construcción", () => {
  test("las tools de venta están; las de soporte NO", () => {
    for (const t of [
      "cotizar_referencial",
      "generar_link_cotizadora",
      "agendar_reunion",
      "registrar_solicitud_callback",
      "registrar_comprobante_transferencia",
    ]) {
      assert.ok(TOOLS_SENAL_COMERCIAL.has(t), `falta la señal comercial ${t}`)
    }
    assert.ok(!TOOLS_SENAL_COMERCIAL.has("consultar_agente_soporte"), "soporte jamás taguea")
    assert.ok(!TOOLS_SENAL_COMERCIAL.has("derivar_a_soporte"), "soporte jamás taguea")
  })
})

describe("el cableado en el agent-loop", () => {
  test("taguea tras el éxito de la tool, best-effort", () => {
    assert.match(LOOP, /TOOLS_SENAL_COMERCIAL\.has\(toolName\)/)
    assert.match(LOOP, /\?\.ok !== false/)
    assert.match(LOOP, /void tagearChatComercial\(contact\)\.catch/)
  })
})

describe("el PATCH a Botmaker", () => {
  test("usa la referencia línea:teléfono y tags {comercial_<pais>: true}", () => {
    assert.match(TAGS, /\$\{linea\}:\$\{clean\}/)
    assert.match(TAGS, /const tag = `comercial_\$\{pais\}`/)
    assert.match(TAGS, /tags: \{ \[tag\]: true \}/)
    assert.match(TAGS, /method: "PATCH"/)
  })

  test("nunca lanza: cualquier falla devuelve false", () => {
    assert.match(TAGS, /catch \(e\) \{[\s\S]*?return false/)
  })
})
