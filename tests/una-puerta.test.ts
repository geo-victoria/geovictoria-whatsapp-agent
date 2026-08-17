import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { quitarLinksDeAceptacion } from "../lib/una-puerta-cotizacion.ts"

describe("una sola puerta de entrega (Eduardo 17-ago)", () => {
  test("quita el link largo con token", () => {
    const r = quitarLinksDeAceptacion(
      "Te dejo el link donde puedes revisar, aceptar y pagar: https://cotizacion.geovictoria.com/quote-acceptance.html?token=eyJabc.def",
    )
    assert.equal(r.quitados, 1)
    assert.ok(!/quote-acceptance/.test(r.limpio))
  })

  test("quita el link corto /q/", () => {
    const r = quitarLinksDeAceptacion("Aquí: https://cotizacion.geovictoria.com/q/123-abc0000000")
    assert.equal(r.quitados, 1)
    assert.ok(!/\/q\//.test(r.limpio))
  })

  test("no toca un texto sin links de aceptación", () => {
    const t = "Perfecto! Te queda en $26.740 al mes 😊"
    const r = quitarLinksDeAceptacion(t)
    assert.equal(r.quitados, 0)
    assert.equal(r.limpio, t)
  })

  test("no se lleva otros links de GeoVictoria", () => {
    const t = "Mira la wiki: https://wiki.geovictoria.com/marcaje"
    assert.equal(quitarLinksDeAceptacion(t).quitados, 0)
  })
})

describe("entrega completa recortada cuando la plantilla ya salió (caso Rodrigo 17-ago)", () => {
  test("bota el bloque de entrega entero, incluida la línea Listo!", async () => {
    const { quitarEntregaCompleta } = await import("../lib/una-puerta-cotizacion.ts")
    const r = quitarEntregaCompleta(
      "Listo! 🎉\nAquí revisas, aceptas y pagas tu cotización: https://cotizacion.geovictoria.com/quote-acceptance.html?token=abc.def",
    )
    assert.equal(r.limpio, "")
  })

  test("bota el texto huérfano aunque venga sin link (el caso exacto del doble mensaje)", async () => {
    const { quitarEntregaCompleta } = await import("../lib/una-puerta-cotizacion.ts")
    const r = quitarEntregaCompleta("Listo! 🎉\nAquí revisas, aceptas y pagas tu cotización")
    assert.equal(r.limpio, "")
  })

  test("conserva lo que no es entrega", async () => {
    const { quitarEntregaCompleta } = await import("../lib/una-puerta-cotizacion.ts")
    const r = quitarEntregaCompleta(
      "Listo! 🎉\nAquí revisas, aceptas y pagas tu cotización\nCualquier duda me dices 😊",
    )
    assert.equal(r.limpio, "Cualquier duda me dices 😊")
  })
})
