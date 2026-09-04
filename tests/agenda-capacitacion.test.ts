import { test, describe } from "node:test"
import assert from "node:assert/strict"
import {
  primeraFechaAgendable,
  fechasAgendables,
  esDiaHabil,
  aFormatoBookings,
  servicioCurso1De,
  staffDe,
  momentoBookings,
  mismaHora,
} from "../lib/onboarding/agenda-capacitacion.ts"

/** Mediodía en Chile del día dado, para que la fecha no se corra por zona. */
const clMediodia = (iso: string) => new Date(`${iso}T16:00:00Z`)

describe("holgura de 2 días hábiles", () => {
  test("jueves → lunes: el fin de semana no consume holgura", () => {
    assert.equal(primeraFechaAgendable(clMediodia("2026-09-03")), "2026-09-07")
  })
  test("viernes → martes", () => {
    assert.equal(primeraFechaAgendable(clMediodia("2026-09-04")), "2026-09-08")
  })
  test("lunes → miércoles", () => {
    assert.equal(primeraFechaAgendable(clMediodia("2026-09-07")), "2026-09-09")
  })
  test("sábado → miércoles (el sábado no cuenta como día de partida)", () => {
    assert.equal(primeraFechaAgendable(clMediodia("2026-09-05")), "2026-09-08")
  })
  test("hoy NUNCA es agendable, aunque sea temprano y hábil", () => {
    const hoy = "2026-09-07"
    assert.notEqual(primeraFechaAgendable(new Date(`${hoy}T12:00:00Z`)), hoy)
  })
  test("un feriado en medio corre la fecha", () => {
    // 18-sep-2026 es viernes (feriado). Miércoles 16 + 2 hábiles saltando el 18.
    const feriados = new Set(["2026-09-18"])
    assert.equal(primeraFechaAgendable(clMediodia("2026-09-16"), feriados), "2026-09-21")
  })
})

describe("días hábiles", () => {
  test("sábado y domingo no son hábiles", () => {
    assert.equal(esDiaHabil(clMediodia("2026-09-05")), false)
    assert.equal(esDiaHabil(clMediodia("2026-09-06")), false)
  })
  test("un feriado declarado no es hábil", () => {
    assert.equal(esDiaHabil(clMediodia("2026-09-18"), new Set(["2026-09-18"])), false)
  })
})

describe("lista de fechas ofrecibles", () => {
  test("arranca en la primera válida y son todas hábiles y consecutivas", () => {
    const f = fechasAgendables(clMediodia("2026-09-03"), 5)
    assert.equal(f.length, 5)
    assert.equal(f[0], "2026-09-07")
    assert.deepEqual(f, ["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"])
  })
  test("ninguna cae en fin de semana", () => {
    for (const d of fechasAgendables(clMediodia("2026-09-04"), 10)) {
      assert.ok(esDiaHabil(clMediodia(d)), `${d} no debería estar: cae en fin de semana`)
    }
  })
})

describe("formato que exige Bookings", () => {
  test("YYYY-MM-DD → dd-MMM-yyyy", () => {
    assert.equal(aFormatoBookings("2026-09-08"), "08-Sep-2026")
    assert.equal(aFormatoBookings("2026-12-01"), "01-Dec-2026")
  })
})

describe("el curso sigue al jefe de proyecto", () => {
  test("cada relator tiene su propio servicio", () => {
    assert.equal(servicioCurso1De("isalinas@geovictoria.com"), "4631613000006516369")
    assert.equal(servicioCurso1De("dalegre@geovictoria.com"), "4631613000006546573")
  })
  test("mayúsculas y espacios no importan", () => {
    assert.equal(servicioCurso1De("  DAlegre@GeoVictoria.com "), "4631613000006546573")
  })
  test("un relator desconocido devuelve null, no un servicio equivocado", () => {
    assert.equal(servicioCurso1De("otra@geovictoria.com"), null)
  })
})

describe("traducción de horas — donde nacen los bugs de agenda", () => {
  test("los cupos vienen en AM/PM y el cliente escribe en 24h: son la misma hora", () => {
    assert.equal(mismaHora("02:30 PM", "14:30"), true)
    assert.equal(mismaHora("08:30 AM", "8:30"), true)
    assert.equal(mismaHora("12:00 AM", "00:00"), true)
    assert.equal(mismaHora("12:00 PM", "12:00"), true)
  })
  test("horas distintas no se confunden", () => {
    assert.equal(mismaHora("02:30 PM", "02:30 AM"), false)
    assert.equal(mismaHora("09:00 AM", "09:15"), false)
  })
  test("basura no calza con nada — jamás abre la puerta a reservar", () => {
    assert.equal(mismaHora("cuando sea", "14:30"), false)
    assert.equal(mismaHora("", "14:30"), false)
  })
  test("arma el momento que come Bookings", () => {
    assert.equal(momentoBookings("2026-09-10", "04:00 PM"), "10-Sep-2026 16:00:00")
    assert.equal(momentoBookings("2026-09-08", "8:30"), "08-Sep-2026 08:30:00")
  })
  test("rechaza lo que no puede traducir, en vez de inventar una hora", () => {
    assert.equal(momentoBookings("2026-09-10", "en la tarde"), null)
    assert.equal(momentoBookings("10-09-2026", "16:00"), null)
    assert.equal(momentoBookings("2026-09-10", "25:00"), null)
  })
})

describe("el relator y su calendario", () => {
  test("cada uno con su servicio y su ficha en Bookings", () => {
    assert.equal(staffDe("dalegre@geovictoria.com"), "4631613000006545465")
    assert.equal(staffDe("isalinas@geovictoria.com"), "4631613000006534230")
  })
  test("un correo desconocido no devuelve el calendario de otro", () => {
    assert.equal(staffDe("cualquiera@geovictoria.com"), null)
  })
})
