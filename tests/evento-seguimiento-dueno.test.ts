/**
 * Reunión POST-cotización: se agenda DE VERDAD, en la agenda del dueño.
 *
 * Historia (28-jul): la API v2 de Cal no permite forzar host en un evento
 * round-robin (probado con la key real: `teamMemberEmail` de primer nivel →
 * 400 "property teamMemberEmail should not exist"). La solución son los
 * eventos "Seguimiento cotización" — de EQUIPO, con UN host — uno por
 * ejecutivo de Vicky por país. Con formal vigente, el agent-loop inyecta el
 * evento del dueño en consultar_disponibilidad Y en agendar_reunion: las
 * alternativas ofrecidas y el booking corren contra la agenda de quien
 * realmente va a atender. Los dueños legacy sin evento (Anderson) conservan
 * el camino determinista del 21-jul: aviso interno y el dueño invita.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { EVENTO_SEGUIMIENTO_POR_DUENO, eventoSeguimientoDe } from "../lib/eventos-seguimiento.ts"

const RAIZ = new URL("..", import.meta.url).pathname
const leer = (p: string) => readFileSync(join(RAIZ, p), "utf8")
const LOOP = leer("lib/agent-loop.ts")
const DISPO = leer("lib/tools/consultar-disponibilidad-horario.ts")
const CO = leer("lib/paises/co/tools.ts")
const MX = leer("lib/paises/mx/tools.ts")

describe("el mapa dueño → evento de seguimiento", () => {
  test("cubre a los tres ejecutivos de Vicky con los IDs verificados", () => {
    // IDs leídos de las páginas públicas de los eventos el 28-jul, cada una
    // mostrando al host correcto (Eddyluz / Gordillo / Yahel).
    assert.equal(EVENTO_SEGUIMIENTO_POR_DUENO["emujica@geovictoria.com"], "6484386")
    assert.equal(EVENTO_SEGUIMIENTO_POR_DUENO["agordillo@geovictoria.com"], "6484393")
    assert.equal(EVENTO_SEGUIMIENTO_POR_DUENO["ysegura@geovictoria.com"], "6484399")
  })

  test("Anderson NO está en el mapa: su cartera legacy usa el camino determinista", () => {
    assert.equal(EVENTO_SEGUIMIENTO_POR_DUENO["adiazg@geovictoria.com"], undefined)
  })

  test("se extiende por env para los vendedores de la tómbola de Zoho (sin deploy)", () => {
    process.env.VICKY_CAL_EVENTO_POR_DUENO = "ileiva@geovictoria.com:7000001"
    assert.equal(eventoSeguimientoDe("ileiva@geovictoria.com"), "7000001")
    // El mapa fijo sigue funcionando con el env presente.
    assert.equal(eventoSeguimientoDe("emujica@geovictoria.com"), "6484386")
    delete process.env.VICKY_CAL_EVENTO_POR_DUENO
    assert.equal(eventoSeguimientoDe("ileiva@geovictoria.com"), undefined)
  })
})

describe("el agent-loop inyecta el evento del dueño", () => {
  test("en las DOS tools: disponibilidad y agendamiento", () => {
    assert.match(
      LOOP,
      /\(toolName === "agendar_reunion" \|\| toolName === "consultar_disponibilidad_horario"\)/,
    )
    assert.match(LOOP, /eventoSeguimientoDe\(dueno\.email\)/)
    assert.match(LOOP, /\.eventTypeId = eventoDelDueno/)
  })

  test("el dueño del DEAL manda; la cotización formal es fallback (Lalo 31-jul)", () => {
    assert.match(LOOP, /await duenoDealVigente\(contact\)\.catch\(\(\) => null\)/)
    // La cotización solo se consulta cuando NO hay dueño de deal.
    assert.match(LOOP, /if \(!dueno\) \{\s*\n\s*const formalReunion/)
  })

  test("el aviso determinista queda SOLO para dueños sin evento", () => {
    assert.match(LOOP, /else if \(toolName === "agendar_reunion"\) \{\s*\n\s*reunionPostFormal = true/)
    // El texto del camino legacy sigue existiendo (lo protege también
    // relevo-ejecutivo-cl.test.ts).
    assert.match(LOOP, /al ejecutivo a cargo de tu cotización/)
  })
})

describe("las tools respetan el evento inyectado", () => {
  test("consultar_disponibilidad (CL) lo declara en su input y lo reenvía", () => {
    assert.match(DISPO, /eventTypeId\?: string/)
    assert.match(DISPO, /eventTypeId: args\.eventTypeId/)
  })

  test("CO y MX prefieren el evento inyectado sobre el default del país", () => {
    assert.match(CO, /\(i\.eventTypeId \|\| ""\)\.trim\(\) \|\| CAL_EVENT_TYPE_ID_CO/)
    assert.match(CO, /\(\(input as \{ eventTypeId\?: string \}\)\?\.eventTypeId \|\| ""\)\.trim\(\) \|\|\s*\n\s*CAL_EVENT_TYPE_ID_CO/)
    assert.match(MX, /\(i\.eventTypeId \|\| ""\)\.trim\(\) \|\| CAL_EVENT_TYPE_ID_MX/)
    assert.match(MX, /\(\(input as \{ eventTypeId\?: string \}\)\?\.eventTypeId \|\| ""\)\.trim\(\) \|\|\s*\n\s*CAL_EVENT_TYPE_ID_MX/)
  })
})
