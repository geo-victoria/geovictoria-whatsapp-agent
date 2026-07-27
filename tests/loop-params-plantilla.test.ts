/**
 * Los params de una plantilla PISAN las variables del contacto en Botmaker.
 *
 * CASO REAL QUE ORIGINA ESTE ARCHIVO (27-jul, contacto 5656941286390): el
 * cron del Loop v2 mandaba `{ nombre: "de nuevo", empresa: "tu empresa" }`
 * fijos en cada toque por plantilla. Botmaker no solo sustituye esos valores
 * en el texto: los ESCRIBE en las variables del contacto. En la consola quedó
 * el destrozo:
 *
 *   ${nombre}  se actualizó con el valor `de nuevo`   (antes: `alejandro`)
 *   ${empresa} se actualizó con el valor `tu empresa` (antes: `Bar & Restaurant`)
 *
 * Es irreversible y contamina TODAS las plantillas futuras de ese contacto:
 * un cliente que se presentó como Alejandro de Bar & Restaurant pasa a ser
 * "de nuevo" de "tu empresa" para siempre.
 *
 * La regla que queda: solo se manda un param cuando tenemos el valor REAL. Lo
 * que no sabemos se omite, para que Botmaker resuelva con la variable que ya
 * guardó del mensaje de apertura — que es justamente el dato bueno.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const RAIZ = new URL("..", import.meta.url).pathname
const LOOP = readFileSync(join(RAIZ, "app/api/vic-loop-cron/route.ts"), "utf8")

describe("el cron del loop no pisa las variables del contacto", () => {
  test("no manda literales de relleno como params de plantilla", () => {
    // Se buscan los literales SOLO dentro del código, no en los comentarios que
    // explican por qué no deben estar.
    const codigo = LOOP.split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n")
    for (const relleno of ['"de nuevo"', '"tu empresa"']) {
      assert.ok(
        !codigo.includes(relleno),
        `el loop volvió a mandar el relleno ${relleno} — pisa el dato real del contacto`,
      )
    }
  })

  test("resuelve la empresa REAL desde el puntero de la cotización", () => {
    assert.match(LOOP, /async function empresaDeCotizacion/)
    assert.match(LOOP, /vic_v3_quote_pointers\?contact=eq\./)
  })

  test("solo agrega el param cuando hay valor: nunca manda vacío", () => {
    // `if (empresaReal) params.empresa = ...` — sin el guard, un "" también
    // pisaría la variable buena con nada.
    assert.match(LOOP, /if \(empresaReal\) params\.empresa = empresaReal/)
  })

  test("el envío usa el objeto construido, no un literal inline", () => {
    assert.match(LOOP, /sendBotmakerTemplate\(r\.contact, tpl, params, canal\)/)
  })
})
