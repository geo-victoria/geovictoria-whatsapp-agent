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
    // Sin el guard de valor no vacío, un "" también pisaría la variable buena
    // con nada.
    assert.match(LOOP, /const valor = \(disponibles\[v\] \|\| ""\)\.trim\(\)\s*\n\s*if \(valor\)/)
  })

  test("el envío usa el objeto construido, no un literal inline", () => {
    assert.match(LOOP, /sendBotmakerTemplate\(r\.contact, tpl, params, canal\)/)
  })
})

/**
 * SEGUNDA CAPA (27-jul, tarde): mandar un param que la plantilla NO declara
 * tampoco es inocuo. Botmaker escribe TODOS los params en las variables del
 * contacto antes de renderizar, use el cuerpo esa variable o no. Le estábamos
 * mandando `empresa` a plantillas cuyo texto ni la menciona.
 *
 * Los cuerpos reales se leyeron de la API de Botmaker
 * (GET /v2.0/whatsapp/templates?phoneLineNumber=56967308227): de las 11
 * plantillas de la matriz, 4 no tienen variables, 6 solo ${nombre} y 1 sola
 * —vicky_mx_react_corta— usa ${empresa}.
 */
describe("los params se limitan a las variables que la plantilla declara", () => {
  test("existe el mapa de variables por plantilla y la función que filtra", () => {
    assert.match(LOOP, /const VARS_PLANTILLA: Record<string, readonly string\[\]>/)
    assert.match(LOOP, /function paramsParaPlantilla\(/)
  })

  test("las plantillas sin variables quedan declaradas como vacías", () => {
    // Si alguien les agrega `empresa` acá, vuelve el write inútil.
    for (const tpl of [
      "vicky_loop_sin_precio",
      "vicky_loop_con_precio",
      "vicky_loop_con_precio_co",
      "vicky_loop_con_precio_mx",
    ]) {
      assert.match(
        LOOP,
        new RegExp(`${tpl}: \\[\\]`),
        `${tpl} no tiene variables en Botmaker: su celda debe ser []`,
      )
    }
  })

  test("solo vicky_mx_react_corta declara empresa", () => {
    const mapa = LOOP.slice(
      LOOP.indexOf("const VARS_PLANTILLA"),
      LOOP.indexOf("function paramsParaPlantilla"),
    )
    const conEmpresa = mapa
      .split("\n")
      .filter((l) => /"empresa"/.test(l))
      .map((l) => l.trim())
    assert.deepEqual(conEmpresa, ['vicky_mx_react_corta: ["nombre", "empresa"],'])
  })

  test("una plantilla desconocida no recibe params (default conservador)", () => {
    assert.match(LOOP, /const declaradas = VARS_PLANTILLA\[tpl\] \|\| \[\]/)
  })
})

/**
 * vicky_lead_nudge está DESINCRONIZADA con Meta: Botmaker guarda el texto
 * largo con ${nombre}/${empresa}, Meta tiene otro corto y sin variables
 * ("¿Todo ok? ¿Quieres que te cotice?"). Meta manda el suyo, los conteos de
 * parámetros no calzan y sale el #132000. Fuera de la matriz del loop.
 */
describe("la matriz no usa plantillas desincronizadas con Meta", () => {
  test("vicky_lead_nudge no aparece en el código del loop", () => {
    const codigo = LOOP.split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n")
    assert.ok(
      !codigo.includes("vicky_lead_nudge"),
      "vicky_lead_nudge volvió a la matriz: su copia en Meta no es la de Botmaker",
    )
  })

  test("todas las plantillas por defecto de la matriz están en VARS_PLANTILLA", () => {
    // Una plantilla en la matriz que no esté en el mapa se enviaría sin params
    // en silencio. Es el default seguro, pero debe ser una decisión escrita.
    const matriz = LOOP.slice(LOOP.indexOf("const CO_PREFORM"), LOOP.indexOf("const VARS_PLANTILLA"))
    const usadas = [...new Set([...matriz.matchAll(/"(vicky_[a-z0-9_]+)"/g)].map((m) => m[1]))]
    assert.ok(usadas.length >= 8, `se esperaban las plantillas de la matriz, se encontraron ${usadas.length}`)
    const faltantes = usadas.filter((t) => !new RegExp(`\\n  ${t}: `).test(LOOP))
    assert.deepEqual(faltantes, [], "plantillas de la matriz sin declarar en VARS_PLANTILLA")
  })
})
