/**
 * Procedencia de links: qué URLs salieron REALMENTE de una tool en este turno.
 *
 * CASOS REALES QUE ORIGINAN ESTE ARCHIVO:
 *   - Transportes Viig, 22-jul: Vicky inventó una "ficha técnica" en
 *     storage.googleapis.com. De ahí nació el allowlist de dominios.
 *   - +56997018751 (24-jul) y Pablo/Ayres Lubricentro (25-jul, en pleno cierre):
 *     el allowlist se comió el link de la DEMO por no estar enumerado, y al
 *     cliente le llegó "(te lo hago llegar enseguida) (clave: 24680)" — la clave
 *     sin la URL. Enumerar dominios a mano no escala.
 *
 * La regla que se prueba acá: si la URL salió TEXTUAL de una tool que corrió OK
 * en este turno, la produjo nuestro backend y se respeta. Solo puede rescatar
 * links legítimos — una URL alucinada nunca está en un tool_result.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { urlsDeToolsDelTurno, vieneDeUnaTool } from "../lib/links-de-tools.ts"

const LINK_ONBOARDING = "https://onboarding-geovictoria.vercel.app?token=abc-123-def"
const LINK_ACEPTACION = "https://cotizacion.geovictoria.com/quote-acceptance.html?t=xyz789"

const turnoConComprobante = [
  {
    name: "registrar_comprobante_transferencia",
    ok: true,
    output: {
      ok: true,
      mensajeParaProspecto: `Recibí tu comprobante por $890.000 🙌 Aquí tienes tu acceso:\n${LINK_ONBOARDING}\n\nCualquier duda me escribes 😊`,
    },
  },
  { name: "cotizar_referencial", ok: true, output: { ok: true, mensajeParaProspecto: "sin links" } },
]

describe("rescate de links legítimos", () => {
  test("el acceso al onboarding sobrevive aunque su dominio no esté enumerado", () => {
    const urls = urlsDeToolsDelTurno(turnoConComprobante)
    assert.ok(vieneDeUnaTool(LINK_ONBOARDING, urls))
  })

  test("tolera la puntuación pegada al final de la URL", () => {
    const urls = urlsDeToolsDelTurno(turnoConComprobante)
    for (const sufijo of [".", ",", ")", "!"]) {
      assert.ok(vieneDeUnaTool(LINK_ONBOARDING + sufijo, urls), `falló con "${sufijo}"`)
    }
  })

  test("encuentra el link venga en el campo que venga del output", () => {
    const urls = urlsDeToolsDelTurno([
      { name: "generar_link_cotizadora", ok: true, output: { ok: true, acceptanceUrl: LINK_ACEPTACION } },
    ])
    assert.ok(vieneDeUnaTool(LINK_ACEPTACION, urls))
  })
})

describe("no deja pasar alucinaciones", () => {
  test("una URL inventada por el modelo NO se rescata", () => {
    const urls = urlsDeToolsDelTurno(turnoConComprobante)
    for (const inventada of [
      "https://storage.googleapis.com/geovictoria/ficha-tecnica.pdf", // Transportes Viig
      "https://cotizacion.geovictoria.com/accept/uuid-inventado", // ruta inexistente
      "https://geovictoria.com/manuales/reloj.pdf",
    ]) {
      assert.equal(vieneDeUnaTool(inventada, urls), false, `se coló: ${inventada}`)
    }
  })

  test("el mismo dominio con OTRO token no basta", () => {
    // Lo que legitima el link es el token que el backend generó, no el host.
    const urls = urlsDeToolsDelTurno(turnoConComprobante)
    assert.equal(
      vieneDeUnaTool("https://onboarding-geovictoria.vercel.app?token=TOKEN-FALSO", urls),
      false,
    )
  })

  test("una tool que FALLÓ no legitima sus URLs", () => {
    const urls = urlsDeToolsDelTurno([
      {
        name: "generar_link_cotizadora",
        ok: false,
        output: { ok: false, error: "timeout", acceptanceUrl: LINK_ACEPTACION },
      },
    ])
    assert.equal(vieneDeUnaTool(LINK_ACEPTACION, urls), false)
  })

  test("un turno sin tools no rescata nada", () => {
    for (const turno of [[], undefined]) {
      const urls = urlsDeToolsDelTurno(turno)
      assert.equal(urls.size, 0)
      assert.equal(vieneDeUnaTool(LINK_ONBOARDING, urls), false)
    }
  })

  test("un output no serializable no rompe el turno", () => {
    const circular: Record<string, unknown> = { ok: true }
    circular.self = circular
    assert.doesNotThrow(() =>
      urlsDeToolsDelTurno([{ name: "x", ok: true, output: circular }]),
    )
  })
})
