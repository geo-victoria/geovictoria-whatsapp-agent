/**
 * CICATRIZ 15-sep (Juan Manuel / ATTEX SPA, +56969063725): Vicky le dio el
 * WhatsApp de la MESA DE AYUDA (+56 9 4401 3873) rotulado como el de Tamara.
 * Mismo defecto el 11-ago (Tamara, +56988928202) y el 01-sep (Anderson,
 * +56956285670). Dos causas: el blindaje anti-fuga del 17-jul pisaba el
 * número correcto del ejecutivo YA PRESENTADO con el de soporte, y la
 * exención de "línea oficial en contexto de soporte" del cinturón del
 * directorio comparaba dígitos con prefijo contra dígitos sin prefijo y
 * miraba el contexto en toda la respuesta.
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { corregirTelefonosEjecutivos, esLineaOficial, contextoDeSoporte } from "../lib/directorio-ejecutivos.ts"
import { blindarContactoComercial } from "../lib/voseo-v3.ts"

const SOPORTE = "+56 9 4401 3873"
const TAMARA = "+56 9 3452 9937"

const JUAN_MANUEL =
  "Entiendo, Juan Manuel. A veces los ejecutivos están en otras llamadas o reuniones. De todas formas, te dejo el contacto directo de quien lleva tu caso:\n\n" +
  "Tamara Martinez\n📱 WhatsApp: +56 9 4401 3873\n📧 tmartinezq@geovictoria.com\n\nPuedes escribirle directamente por WhatsApp o correo."
const ANDERSON =
  "Perfecto! La instalación técnica la coordina Anderson Díaz, el ejecutivo asignado a tu cuenta.\n\nTe dejo sus datos de nuevo:\n📱 WhatsApp: +56 9 4401 3873\n✉️ adiazg@geovictoria.com"
const TAMARA_AGO =
  "Sí, Tamara Martínez es la ejecutiva del equipo comercial que quedó asignada a tu caso. Te dejé sus datos más arriba: su WhatsApp es +56 9 4401 3873 y su correo tmartinezq@geovictoria.com."

describe("el número de soporte rotulado como el del ejecutivo se corrige", () => {
  test("los tres mensajes reales", () => {
    for (const [texto, bueno] of [
      [JUAN_MANUEL, TAMARA],
      [ANDERSON, "+56 9 3937 2058"],
      [TAMARA_AGO, TAMARA],
    ] as const) {
      const r = corregirTelefonosEjecutivos(texto, new Set(["56969063725"]))
      assert.equal(r.correcciones.length, 1, texto.slice(0, 40))
      assert.ok(r.reply.includes(bueno))
      assert.ok(!r.reply.includes(SOPORTE))
    }
  })

  test("la Mesa de Ayuda nombrada COMO soporte junto a un ejecutivo se respeta", () => {
    const texto = `Tamara Martínez es tu ejecutiva. Y para cualquier tema técnico, la Mesa de Ayuda: ${SOPORTE}.`
    const r = corregirTelefonosEjecutivos(texto, new Set())
    assert.equal(r.correcciones.length, 0)
    assert.ok(r.reply.includes(SOPORTE))
  })

  test("'soporte' en OTRO párrafo no exime al número rotulado como del ejecutivo", () => {
    const texto = `El soporte está incluido en tu plan 😊\n\nTamara Martinez\n📱 WhatsApp: ${SOPORTE}`
    const r = corregirTelefonosEjecutivos(texto, new Set())
    assert.equal(r.correcciones.length, 1)
    assert.ok(r.reply.includes(TAMARA))
  })

  test("esLineaOficial reconoce la línea con y sin prefijo país", () => {
    assert.equal(esLineaOficial("944013873"), true)
    assert.equal(esLineaOficial("56944013873"), true)
    assert.equal(esLineaOficial("934529937"), false)
  })

  test("contextoDeSoporte mira la misma línea, no toda la respuesta", () => {
    assert.equal(contextoDeSoporte(`Soporte incluido.\nTamara: ${SOPORTE}`, SOPORTE), false)
    assert.equal(contextoDeSoporte(`Mesa de Ayuda: ${SOPORTE}`, SOPORTE), true)
  })
})

describe("el anti-fuga no pisa al ejecutivo ya presentado", () => {
  test("con traspaso activo el número de Tamara sale intacto", () => {
    const texto = `Tamara Martinez\n📱 WhatsApp: ${TAMARA}`
    assert.equal(blindarContactoComercial(texto, true), texto)
  })
  test("sin traspaso, la regla del 17-jul sigue: se reemplaza por soporte", () => {
    const out = blindarContactoComercial(`Tamara Martinez\n📱 WhatsApp: ${TAMARA}`, false)
    assert.ok(out.includes(SOPORTE))
    assert.ok(!out.includes(TAMARA))
  })
})
