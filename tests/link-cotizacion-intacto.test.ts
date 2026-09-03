/**
 * CICATRIZ 03-sep: el cinturón de teléfonos rompía el LINK DE PAGO.
 *
 * Todo id de cotización de Zoho empieza en `35250450006…` y lleva un "52" en
 * la segunda posición. `RE_TELEFONO` podía arrancar ahí, comerse 13 dígitos y
 * reemplazarlos por el teléfono de un ejecutivo — bastaba que el mensaje
 * nombrara a UNA persona del directorio, y los clientes se llaman Ana, Paola
 * o Tamara todo el tiempo, así que el nombre del PROPIO CLIENTE lo disparaba.
 * Resultado: `/q/3+56 9 4401 387368552-…`, un link muerto. Tres clientes lo
 * recibieron (COT1105, COT1151 y COT1162) antes de que lo cazáramos.
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { corregirTelefonosEjecutivos } from "../lib/directorio-ejecutivos.ts"
import { blindarContactoComercial } from "../lib/voseo-v3.ts"

const LINK = "https://cotizacion.geovictoria.com/q/3525045000657868552-50234689d5"

describe("el link de la cotización sale intacto", () => {
  test("no se toca aunque el cliente se llame como una ejecutiva", () => {
    const { reply } = corregirTelefonosEjecutivos(
      `Lista tu cotización, Ana! 🎉 Revísala aquí: ${LINK}`,
      new Set(),
    )
    assert.ok(reply.includes(LINK))
    assert.ok(blindarContactoComercial(reply, false).includes(LINK))
  })

  test("tampoco con el id de COT1162 ni con nombre compuesto", () => {
    const link = "https://cotizacion.geovictoria.com/q/3525045000658072979-f47e3a8833"
    const { reply } = corregirTelefonosEjecutivos(
      `Lista tu cotización, Ana Maria! 🎉 Revísala aquí: ${link}`,
      new Set(),
    )
    assert.ok(reply.includes(link))
  })

  test("el link largo con token JWT tampoco se corrompe", () => {
    const largo =
      "https://cotizacion.geovictoria.com/quote-acceptance.html?token=eyJxdW90ZUlkIjoiMzUyNTA0NTAwMDY1NzU2NjE5NyJ9"
    const { reply } = corregirTelefonosEjecutivos(`Listo, Tamara: ${largo}`, new Set())
    assert.ok(reply.includes(largo))
  })

  test("PERO sigue corrigiendo un teléfono mal atribuido fuera de la URL", () => {
    const { reply, correcciones } = corregirTelefonosEjecutivos(
      "Te atiende Aleydis Araque, su WhatsApp es +56 9 1111 2222",
      new Set(),
    )
    assert.ok(reply.includes("+56 9 8291 6868"))
    assert.equal(correcciones.length, 1)
  })

  test("y el blindaje comercial sigue tapando el número de un ejecutivo suelto", () => {
    assert.ok(blindarContactoComercial("llama al +56 9 3937 2058", false).includes("+56 9 4401 3873"))
  })
})
