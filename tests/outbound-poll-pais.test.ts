/**
 * El poller de leads asignados a Vicky reenvía el PAÍS del lead.
 *
 * CONTEXTO (27-jul): Lalo agregó a Vicky a la tómbola de MÉXICO (Country
 * contiene mex/xico/Mex, rango 1-19) junto a dos SDR humanos. El poller
 * encuentra esos leads —filtra solo por owner— pero no seleccionaba ni
 * reenviaba Country, y vic-outbound-lead necesita el país para normalizar un
 * teléfono mexicano en formato LOCAL (10 dígitos, sin +52) a 521 + número.
 *
 * Consecuencia sin el fix: el lead con teléfono local no calza con ningún
 * prefijo, country queda null, y el endpoint lo reasigna a un SDR humano — la
 * tómbola le da el lead a Vicky y Vicky lo devuelve en silencio. Los leads
 * con +52 explícito sí funcionaban, por eso el hueco era invisible.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const RAIZ = new URL("..", import.meta.url).pathname
const POLL = readFileSync(join(RAIZ, "app/api/vic-outbound-poll/route.ts"), "utf8")
const LEAD = readFileSync(join(RAIZ, "app/api/vic-outbound-lead/route.ts"), "utf8")

describe("el poll reenvía el país al toque 0", () => {
  test("la COQL trae Country y Territorio", () => {
    assert.match(POLL, /Rango_de_Empleados, Country, Territorio from Leads/)
  })

  test("el body hacia vic-outbound-lead lleva country", () => {
    assert.match(POLL, /country: \(\(lead\.Country \|\| lead\.Territorio \|\| ""\) as string\)\.trim\(\)/)
  })

  test("y el endpoint efectivamente lee body.country", () => {
    assert.match(LEAD, /\(body\.country \|\| body\.territorio \|\| ""\)/)
  })

  test("el endpoint normaliza el celular mexicano local con ese país", () => {
    // 10 dígitos + territorio mx → 521XXXXXXXXXX (formato WhatsApp).
    assert.match(LEAD, /territorio === "mx" && contact\.length === 10/)
    assert.match(LEAD, /contact = `521\$\{contact\}`/)
  })
})
