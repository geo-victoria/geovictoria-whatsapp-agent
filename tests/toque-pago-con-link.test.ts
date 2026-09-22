/**
 * EL TOQUE DE COBRO LLEVA EL LINK (04-sep).
 *
 * Fuera de la ventana de 24 h el toque post-aceptación salía por la plantilla
 * `vicky_loop_pago`, cuyo cuerpo aprobado es literalmente "Hola ${nombre},
 * ¿te ayudo con el pago?😄" — sin link y sin botón. Le pedíamos el pago a un
 * cliente que YA había aceptado y no le dábamos dónde pagar: 28 mensajes a 14
 * clientes entre el 27-ago y el 04-sep, en el punto del embudo donde el link
 * ES el toque.
 *
 * Gemela nueva `vicky_loop_pago_link_cl` con ${nombre} y ${link}. Se enciende
 * por env LOOP_TPL_ACEPTADA cuando Meta la apruebe (hoy BOTMAKER_PENDING).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { linkCortoDe } from "../lib/link-cotizacion.ts"
import { createHmac } from "node:crypto"

const CRON = readFileSync("app/api/vic-loop-cron/route.ts", "utf8")

test("la plantilla nueva declara el link como variable", () => {
  assert.match(
    CRON,
    /vicky_loop_pago_link_cl:\s*\["nombre",\s*"link"\]/,
    "sin declararla, el param no se manda (VARS_PLANTILLA manda)",
  )
})

test("el link viaja a la plantilla en los params", () => {
  assert.ok(
    /paramsParaPlantilla\(tpl,\s*\{\s*empresa: empresaReal,\s*link: linkPago\s*\}\)/.test(CRON),
    "el toque fuera de ventana debe recibir el link",
  )
})

test("linkPago se resuelve en la etapa aceptada, no se inventa", () => {
  const i = CRON.indexOf("let linkPago")
  const j = CRON.indexOf("linkPago = linkCortoDe")
  assert.ok(i > 0 && j > i, "se declara antes y se llena desde el puntero real")
  assert.ok(
    CRON.includes("|| puntero.acceptanceUrl"),
    "sin secreto para firmar el corto, va el link largo — nunca vacío",
  )
})

test("linkCortoDe firma igual que el cotizador, y sin secreto no inventa nada", () => {
  delete process.env.VICKY_COTIZADORA_SECRET
  assert.equal(linkCortoDe("3525045000658246794"), "", "sin secreto devuelve vacío, jamás un link falso")
  process.env.VICKY_COTIZADORA_SECRET = "secreto-de-prueba"
  const id = "3525045000658246794"
  const firma = createHmac("sha256", "secreto-de-prueba").update(id).digest("hex").slice(0, 10)
  assert.equal(linkCortoDe(id), `https://cotizacion.geovictoria.com/q/${id}-${firma}`)
  delete process.env.VICKY_COTIZADORA_SECRET
})
