/**
 * Ruteo por país a partir del número del contacto.
 *
 * CASO REAL QUE ORIGINA ESTE ARCHIVO — 26-jul-2026: el Master Bot de Botmaker
 * rutea por ID DEL CANAL (la línea a la que el cliente escribió), no por el
 * prefijo del número, así que cualquier número puede aterrizar en cualquier
 * webhook. El chileno ya devolvía los +57/+52 al suyo, pero CO y MX atendían a
 * quien llegara: un chileno que escribiera al número colombiano recibía prompt
 * colombiano, precios en COP y la pregunta por el NIT. Falla silenciosa.
 *
 * Antecedente: María, 23-jul — misroute del master bot que le respondió por la
 * línea chilena a una clienta de la línea colombiana.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { paisDeContacto, WEBHOOK_POR_PAIS, SECRET_ENV_POR_PAIS } from "../lib/ruteo-pais.ts"

describe("paisDeContacto", () => {
  test("reconoce números reales de cada país", () => {
    for (const [numero, pais] of [
      ["56967308227", "cl"], // línea de Vicky CL
      ["56946910181", "cl"],
      ["56923948197", "cl"],
      ["573181070737", "co"], // línea de Vicky CO
      ["573112895086", "co"],
      ["573138157184", "co"],
      ["5215659778486", "mx"], // línea de Vicky MX
      ["5219234567890", "mx"],
    ] as const) {
      assert.equal(paisDeContacto(numero), pais, `mal clasificado: ${numero}`)
    }
  })

  test("tolera el formato con + y separadores", () => {
    assert.equal(paisDeContacto("+56 9 6730 8227"), "cl")
    assert.equal(paisDeContacto("+57 318 107 0737"), "co")
  })

  test("un país no soportado NO se fuerza a ninguno", () => {
    // Devolver 'desconocido' hace que lo atienda el webhook donde llegó, que es
    // lo conservador: mejor eso que mandarlo al flujo de otro país.
    for (const numero of ["12025550100", "5491123456789", "34600000000", ""]) {
      assert.equal(paisDeContacto(numero), "desconocido", `no debió clasificarse: ${numero}`)
    }
  })
})

describe("el reenvío no puede hacer ciclos", () => {
  test("cada webhook se queda con su propio prefijo", () => {
    // La garantía anti-loop: un webhook solo reenvía prefijos ajenos, y siempre
    // al webhook que SÍ se queda con ese prefijo. Si esto se rompiera, dos
    // webhooks podrían rebotarse un mensaje indefinidamente.
    const lineaDe = { cl: "56967308227", co: "573181070737", mx: "5215659778486" } as const
    for (const pais of ["cl", "co", "mx"] as const) {
      assert.equal(
        paisDeContacto(lineaDe[pais]),
        pais,
        `${pais} no se quedaría con su propio número → riesgo de rebote`,
      )
    }
  })

  test("los tres países tienen webhook y secret declarados", () => {
    for (const pais of ["cl", "co", "mx"] as const) {
      assert.match(WEBHOOK_POR_PAIS[pais], /^\/api\/vic-botmaker/)
      assert.match(SECRET_ENV_POR_PAIS[pais], /^BOTMAKER_SECRET/)
    }
    // Sin colisiones: dos países no pueden compartir destino ni secret.
    assert.equal(new Set(Object.values(WEBHOOK_POR_PAIS)).size, 3)
    assert.equal(new Set(Object.values(SECRET_ENV_POR_PAIS)).size, 3)
  })
})
