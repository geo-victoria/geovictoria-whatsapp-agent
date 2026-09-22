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
  test("cubre a los ejecutivos con evento propio, con los IDs verificados", () => {
    // CL: eventos creados el 10-ago y verificados contra la API el mismo día
    // (200 y disponibilidad distinta entre sí — cada uno mira SU agenda).
    assert.equal(EVENTO_SEGUIMIENTO_POR_DUENO["emujica@geovictoria.com"], "6616710")
    assert.equal(EVENTO_SEGUIMIENTO_POR_DUENO["pdiaz@geovictoria.com"], "6616712")
    assert.equal(EVENTO_SEGUIMIENTO_POR_DUENO["gmelendez@geovictoria.com"], "6616718")
    assert.equal(EVENTO_SEGUIMIENTO_POR_DUENO["alopez@geovictoria.com"], "6616741")
    // CO/MX: IDs del 28-jul, sin cambios.
    assert.equal(EVENTO_SEGUIMIENTO_POR_DUENO["agordillo@geovictoria.com"], "6484393")
    assert.equal(EVENTO_SEGUIMIENTO_POR_DUENO["ysegura@geovictoria.com"], "6484399")
  })

  test("quien AÚN no tiene agenda utilizable no está en el mapa (cae al round-robin)", () => {
    for (const email of [
      // Anderson tiene evento creado (6616830) pero devuelve 0 slots: se
      // deja FUERA a propósito hasta que su agenda ofrezca horas.
      "adiazg@geovictoria.com",
      "dgalvez@geovictoria.com",
      "asepulveda@geovictoria.com",
      "aaraque@geovictoria.com",
    ]) {
      assert.equal(EVENTO_SEGUIMIENTO_POR_DUENO[email], undefined)
    }
  })

  test("Tamara SÍ tiene evento (6616775, verificado con slots reales)", () => {
    assert.equal(EVENTO_SEGUIMIENTO_POR_DUENO["tmartinezq@geovictoria.com"], "6616775")
  })

  test("se extiende por env para los vendedores de la tómbola de Zoho (sin deploy)", () => {
    process.env.VICKY_CAL_EVENTO_POR_DUENO = "ileiva@geovictoria.com:7000001"
    assert.equal(eventoSeguimientoDe("ileiva@geovictoria.com"), "7000001")
    // El mapa fijo sigue funcionando con el env presente.
    assert.equal(eventoSeguimientoDe("emujica@geovictoria.com"), "6616710")
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

  test("manda el dueño del DEAL; la formal queda de respaldo (Lalo 10-ago)", () => {
    // Regla nueva (10-ago, supersede la del 31-jul): "si se traspasa una
    // conversación a un ejecutivo, la reunión se queda a nombre de él" — el
    // dueño que sorteó la tómbola dirige la agenda. La cotización formal
    // sigue como respaldo cuando el deal no tiene dueño con evento.
    assert.match(LOOP, /let duenoDeal: DuenoReunion \| null = await duenoDealVigente\(contact\)/)
    assert.match(LOOP, /const eventoDeal = duenoDeal \? eventoSeguimientoDe\(duenoDeal\.email\) : undefined/)
    assert.match(LOOP, /if \(eventoDeal\) \{\s*\n\s*;\(toolInput as Record<string, unknown>\)\.eventTypeId = eventoDeal/)
    // Respaldo intacto: sin evento del dueño del deal, se mira la formal.
    assert.match(LOOP, /const formalReunion = await getFormalQuote\(contact\)\.catch/)
  })

  test("sin deal, la tómbola de ZOHO sortea antes de mirar agenda (Lalo 10-ago)", () => {
    // "La tómbola es la de deals de Zoho": Cal no elige a nadie. Sin deal se
    // dispara el hito (lead convertido + candados anti-duplicado) con
    // sorteoInmediato, y recién con ese dueño se busca disponibilidad.
    assert.match(LOOP, /if \(!duenoDeal\) \{[\s\S]{0,400}sincronizarHitoCrm\(contact, "intencion"/)
    assert.match(LOOP, /sorteoInmediato: true/)
    // Y con timeout: Zoho lento no puede dejar al cliente sin su reunión.
    assert.match(LOOP, /setTimeout\(r, 8000\)/)
    assert.match(LOOP, /duenoDeal = await duenoDealVigente\(contact\)\.catch/)
  })

  test("un ejecutivo SIN evento de host único nunca rompe la reunión", () => {
    // Cal no permite dirigir un evento multi-host a una persona (400 en
    // teamMemberEmail/username, re-verificado 10-ago): sin evento propio se
    // cae al camino de siempre, jamás a un error para el cliente.
    assert.match(LOOP, /Sin\s*\n?\s*\/\/ ese evento configurado, el comportamiento es el de siempre/)
  })

  test("el aviso determinista queda SOLO para dueños sin evento", () => {
    assert.match(LOOP, /else if \(dueno && toolName === "agendar_reunion"\) \{\s*\n\s*reunionPostFormal = true/)
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
