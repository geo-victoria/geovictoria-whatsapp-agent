/**
 * PTV — Proceso de Traspaso a Vendedor (doc "Vicky paso a paso", 30-jul).
 * Reglas duras del doc: TTV 120 min sin precio / 15 min con precio; el TTV
 * solo corre en horario hábil (L-V no feriado, 8-18 h del país); la pausa
 * anunciada por el cliente suspende el reloj; nunca se traspasa dos veces.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  ttvMinutos,
  esHorarioHabil,
  debeTraspasar,
  sumarHorasHabiles,
  mensajePresentacion,
  TTV_SIN_PRECIO_MIN,
  TTV_CON_PRECIO_MIN,
} from "../lib/ptv.ts"

const RAIZ = new URL("..", import.meta.url).pathname

// Miércoles 2026-08-05 15:00 Chile (UTC-4) = 19:00Z → hábil.
const MIERCOLES_HABIL = new Date("2026-08-05T19:00:00Z")
// Domingo → no hábil.
const DOMINGO = new Date("2026-08-02T19:00:00Z")

describe("TTV según el documento", () => {
  test("120 sin precio, 15 con precio", () => {
    assert.equal(ttvMinutos(false), 120)
    assert.equal(ttvMinutos(true), 15)
    assert.equal(TTV_SIN_PRECIO_MIN, 120)
    assert.equal(TTV_CON_PRECIO_MIN, 15)
  })
})

describe("horario hábil (L-V no feriado, 8-18 h del país)", () => {
  test("miércoles 15:00 Chile es hábil; domingo no", () => {
    assert.equal(esHorarioHabil("cl", MIERCOLES_HABIL), true)
    assert.equal(esHorarioHabil("cl", DOMINGO), false)
  })

  test("las 19:00 de Chile no son hábiles aunque en México sean las 17:00", () => {
    const tarde = new Date("2026-08-05T23:30:00Z") // 19:30 CL / 17:30 CDMX
    assert.equal(esHorarioHabil("cl", tarde), false)
    assert.equal(esHorarioHabil("mx", tarde), true)
  })

  test("un feriado del país congela el reloj", () => {
    assert.equal(esHorarioHabil("cl", MIERCOLES_HABIL, new Set(["2026-08-05"])), false)
  })
})

describe("decisión de traspaso", () => {
  const base = {
    pais: "cl" as const,
    ahora: MIERCOLES_HABIL,
    traspasoActivo: false,
    clienteRespondioDespues: false,
    compromisoAt: null,
  }

  test("con precio y 20 min sin respuesta → traspasa (TTV 15)", () => {
    const d = debeTraspasar({
      ...base,
      precioMostrado: true,
      ultimoMensajeVickyAt: new Date(MIERCOLES_HABIL.getTime() - 20 * 60000),
    })
    assert.equal(d.traspasar, true)
    assert.equal(d.ttv, 15)
  })

  test("sin precio y 20 min → NO traspasa (TTV 120)", () => {
    const d = debeTraspasar({
      ...base,
      precioMostrado: false,
      ultimoMensajeVickyAt: new Date(MIERCOLES_HABIL.getTime() - 20 * 60000),
    })
    assert.equal(d.traspasar, false)
  })

  test("el cliente respondió → nunca traspasa", () => {
    const d = debeTraspasar({
      ...base,
      clienteRespondioDespues: true,
      precioMostrado: true,
      ultimoMensajeVickyAt: new Date(MIERCOLES_HABIL.getTime() - 60 * 60000),
    })
    assert.equal(d.traspasar, false)
  })

  test("pausa anunciada vigente suspende el TTV", () => {
    const d = debeTraspasar({
      ...base,
      precioMostrado: true,
      ultimoMensajeVickyAt: new Date(MIERCOLES_HABIL.getTime() - 60 * 60000),
      compromisoAt: new Date(MIERCOLES_HABIL.getTime() + 60 * 60000),
    })
    assert.equal(d.traspasar, false)
  })

  test("pausa vencida: el TTV corre desde el vencimiento, no desde el mensaje", () => {
    const d = debeTraspasar({
      ...base,
      precioMostrado: true,
      ultimoMensajeVickyAt: new Date(MIERCOLES_HABIL.getTime() - 300 * 60000),
      compromisoAt: new Date(MIERCOLES_HABIL.getTime() - 5 * 60000), // venció hace 5 min < TTV 15
    })
    assert.equal(d.traspasar, false)
  })

  test("traspaso activo previo → jamás doble PTV", () => {
    const d = debeTraspasar({
      ...base,
      traspasoActivo: true,
      precioMostrado: true,
      ultimoMensajeVickyAt: new Date(MIERCOLES_HABIL.getTime() - 600 * 60000),
    })
    assert.equal(d.traspasar, false)
  })

  test("fuera de horario hábil el reloj no dispara", () => {
    const d = debeTraspasar({
      ...base,
      ahora: DOMINGO,
      precioMostrado: true,
      ultimoMensajeVickyAt: new Date(DOMINGO.getTime() - 600 * 60000),
    })
    assert.equal(d.traspasar, false)
  })
})

describe("chequeo de calidad y presentación", () => {
  test("9 horas hábiles ≈ un día hábil después (viernes 15:00 + 9h → lunes)", () => {
    const viernes = new Date("2026-08-07T19:00:00Z") // viernes 15:00 CL
    const chequeo = sumarHorasHabiles(viernes, 9, "cl")
    assert.equal(chequeo.getUTCDay(), 1) // lunes
  })

  test("la presentación nunca dice 'Oye' y nombra al vendedor", () => {
    for (const pais of ["cl", "co", "mx"] as const) {
      const m = mensajePresentacion(pais, "Eddyluz")
      assert.ok(!/\bOye\b/i.test(m))
      assert.match(m, /Eddyluz/)
      assert.match(m, /no tendrás que repetir nada/)
    }
  })
})

describe("cableado del cron", () => {
  const CRON = readFileSync(join(RAIZ, "app/api/vic-ptv-cron/route.ts"), "utf8")
  const VERCEL = readFileSync(join(RAIZ, "vercel.json"), "utf8")

  test("agendado cada 10 minutos y detrás del flag", () => {
    assert.match(VERCEL, /"\/api\/vic-ptv-cron"/)
    assert.match(VERCEL, /"\*\/10 \* \* \* \*"/)
    assert.match(CRON, /VICKY_PTV_ENABLED/)
  })

  test("registra el traspaso ANTES de avisar (candado anti doble PTV)", () => {
    assert.match(CRON, /Registro PRIMERO/)
  })

  test("alerta interna exige llamar en <5 minutos y menciona el link de pago", () => {
    assert.match(CRON, /LLAMAR EN MENOS DE 5 MINUTOS/)
    assert.match(CRON, /empujar el mismo link/)
  })
})
