import test from "node:test"
import assert from "node:assert/strict"
import { EVENTOS_AGENDA_CO, agendaCoActiva } from "../lib/paises/co/agenda.ts"
import { eventoSeguimientoDe } from "../lib/eventos-seguimiento.ts"
import { rosterTelemarketingOperativo } from "../lib/paises/ficha-operativa.ts"

// Colombia (Lalo 23-sep): un evento de Cal por telemarketera del tramo 1-199,
// y el mapa por dueño del agent-loop los conoce (la reunión sigue al dueño).
test("las tres telemarketeras de la ficha CO tienen evento de Cal y el mapa por dueño lo devuelve", () => {
  const tlmk = rosterTelemarketingOperativo("co").map((p) => p.email).filter((e) => !/agordillo@/.test(e))
  assert.equal(tlmk.length, 3)
  for (const e of tlmk) {
    assert.match(EVENTOS_AGENDA_CO[e] || "", /^\d{6,}$/, `sin evento para ${e}`)
    assert.equal(eventoSeguimientoDe(e), EVENTOS_AGENDA_CO[e])
  }
  assert.equal(new Set(Object.values(EVENTOS_AGENDA_CO)).size, 3)
})

test("la agenda CO está activa por defecto y se apaga con VICKY_AGENDA_CO=off", () => {
  const prev = process.env.VICKY_AGENDA_CO
  try {
    delete process.env.VICKY_AGENDA_CO
    assert.equal(agendaCoActiva(), true)
    process.env.VICKY_AGENDA_CO = "off"
    assert.equal(agendaCoActiva(), false)
  } finally {
    if (prev === undefined) delete process.env.VICKY_AGENDA_CO
    else process.env.VICKY_AGENDA_CO = prev
  }
})
