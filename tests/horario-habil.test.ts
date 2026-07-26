/**
 * Horario hábil de los toques del Loop v2.
 *
 * CASO REAL QUE ORIGINA ESTE ARCHIVO — 24-jul-2026, 23:20 hora de Chile: el
 * primer tick del cron tocó 20 contactos vencidos de una migración vieja y
 * salieron 12 mensajes a medianoche. El gate de horario existía al AGENDAR pero
 * no al EJECUTAR, así que una fila con fecha vencida disparaba a la hora que
 * fuera. Estos casos fijan la garantía: nada sale fuera de L-V 9:00-19:00.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { ajustarAHabil, tzDePais, calcularProximoToque } from "../lib/loop-v2.ts"

const CONTACTO = "56966432322"

function partes(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(d)
  const g = (t: string) => f.find((p) => p.type === t)?.value || ""
  return { dia: g("weekday"), fecha: `${g("day")}-${g("month")}`, hora: Number(g("hour")) % 24 }
}

describe("ajustarAHabil", () => {
  const TZ = tzDePais("cl")

  test("las 23:20 de un viernes se corren al lunes (el incidente)", () => {
    const incidente = new Date("2026-07-25T03:20:00Z") // vie 24-jul 23:20 CL
    const p = partes(ajustarAHabil(incidente, TZ, CONTACTO), TZ)
    assert.equal(p.dia, "Mon")
    assert.equal(p.fecha, "27-07")
    assert.ok(p.hora >= 9 && p.hora < 10, `esperado ~9am, fue ${p.hora}h`)
  })

  test("un instante ya hábil NO se mueve", () => {
    const lunes10 = new Date("2026-07-27T14:00:00Z")
    assert.equal(ajustarAHabil(lunes10, TZ, CONTACTO).getTime(), lunes10.getTime())
  })

  test("antes de las 9 de un día hábil va a ese mismo día", () => {
    const lunes7am = new Date("2026-07-27T11:00:00Z")
    const p = partes(ajustarAHabil(lunes7am, TZ, CONTACTO), TZ)
    assert.equal(p.fecha, "27-07")
    assert.ok(p.hora >= 9 && p.hora < 10)
  })

  test("el fin de semana completo se corre al lunes", () => {
    for (const iso of ["2026-07-25T18:00:00Z", "2026-07-26T18:00:00Z"]) {
      const p = partes(ajustarAHabil(new Date(iso), TZ, CONTACTO), TZ)
      assert.equal(p.dia, "Mon", `${iso} no cayó en lunes`)
    }
  })

  test("barrido de 14 días × 24 horas: NADA queda fuera de horario", () => {
    const inicio = new Date("2026-07-20T00:00:00Z")
    for (let h = 0; h < 14 * 24; h++) {
      const d = new Date(inicio.getTime() + h * 3600e3)
      const p = partes(ajustarAHabil(d, TZ, CONTACTO), TZ)
      assert.ok(p.hora >= 9 && p.hora < 19, `${d.toISOString()} → ${p.hora}h`)
      assert.ok(!["Sat", "Sun"].includes(p.dia), `${d.toISOString()} → ${p.dia}`)
    }
  })

  test("el jitter es determinista y acotado a 45 min", () => {
    const sabado = new Date("2026-07-25T18:00:00Z")
    const a = ajustarAHabil(sabado, TZ, CONTACTO)
    const b = ajustarAHabil(sabado, TZ, CONTACTO)
    assert.equal(a.getTime(), b.getTime(), "mismo contacto → mismo corrimiento")

    const otro = ajustarAHabil(sabado, TZ, "56911112222")
    const deltaMin = Math.abs(a.getTime() - otro.getTime()) / 60000
    assert.ok(deltaMin <= 45, `separación de ${deltaMin} min entre contactos`)
  })
})

describe("cadencia de toques por país", () => {
  test("los 7 toques caen en horario hábil en CL, CO y MX", () => {
    // T0 deliberadamente pésimo: sábado a medianoche.
    const t0 = new Date("2026-07-25T03:20:00Z")
    for (const pais of ["cl", "co", "mx"]) {
      const tz = tzDePais(pais)
      for (let toque = 1; toque <= 7; toque++) {
        const p = partes(calcularProximoToque(t0, toque, pais, CONTACTO), tz)
        assert.ok(p.hora >= 9 && p.hora < 19, `${pais} toque ${toque} → ${p.hora}h`)
        assert.ok(!["Sat", "Sun"].includes(p.dia), `${pais} toque ${toque} → ${p.dia}`)
      }
    }
  })

  test("los toques van estrictamente hacia adelante", () => {
    const t0 = new Date("2026-07-27T13:00:00Z") // lunes 9:00 CL
    let previo = 0
    for (let toque = 1; toque <= 7; toque++) {
      const t = calcularProximoToque(t0, toque, "cl", CONTACTO).getTime()
      assert.ok(t > previo, `el toque ${toque} no avanza respecto del anterior`)
      previo = t
    }
  })

  test("cada país usa su propia zona horaria", () => {
    assert.equal(tzDePais("cl"), "America/Santiago")
    assert.equal(tzDePais("co"), "America/Bogota")
    assert.equal(tzDePais("mx"), "America/Mexico_City")
  })
})
