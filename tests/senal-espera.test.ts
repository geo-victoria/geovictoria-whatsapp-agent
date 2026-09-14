/**
 * Señales de espera del cliente → cuándo corresponde el próximo toque.
 *
 * CASO REAL QUE ORIGINA ESTE ARCHIVO — Tamara, +56966432322, 24-jul-2026:
 * pidió que no la contactaran hasta el martes y el loop igual la tocó. Al
 * escribir estos casos apareció la causa: clasificarSenalEspera no miraba
 * NINGÚN día de la semana nombrado. "Próxima semana" sí, "mañana" sí, "el
 * martes" devolvía null → cadencia normal.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { clasificarSenalEspera, tzDePais, PAUSA_MIN_MS } from "../lib/loop-v2.ts"

const TZ_CL = tzDePais("cl")
const CONTACTO = "56966432322" // Tamara
// Lunes 27-jul-2026, 10:00 en Chile. Fijo: un test que depende de "hoy" miente
// un día distinto cada vez que corre.
const LUNES_10AM = new Date("2026-07-27T14:00:00Z")

function partes(d: Date) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ_CL,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(d)
  const g = (t: string) => f.find((p) => p.type === t)?.value || ""
  return { dia: g("weekday"), fecha: `${g("day")}-${g("month")}`, hora: Number(g("hour")) }
}

const clasificar = (m: string, ahora = LUNES_10AM) =>
  clasificarSenalEspera(m, "cl", CONTACTO, ahora)

describe("día de la semana nombrado (caso Tamara)", () => {
  test("'no me escribas hasta el martes' agenda el martes, no la cadencia normal", () => {
    const r = clasificar("no me escribas hasta el martes")
    assert.ok(r, "debe detectar señal de espera — este era el bug de Tamara")
    assert.equal(r.tipo, "dia_nombrado")
    assert.equal(partes(r.cuando).dia, "Tue")
    assert.equal(partes(r.cuando).fecha, "28-07")
  })

  test("cubre las otras formas de nombrar el día", () => {
    for (const [msg, dia] of [
      ["escríbeme el martes", "Tue"],
      ["el martes lo vemos", "Tue"],
      ["hasta el jueves porfa", "Thu"],
      ["me contactas el viernes", "Fri"],
      ["hablamos el miércoles", "Wed"],
    ] as const) {
      const r = clasificar(msg)
      assert.ok(r, `sin señal para ${JSON.stringify(msg)}`)
      assert.equal(partes(r.cuando).dia, dia, `día errado para ${JSON.stringify(msg)}`)
    }
  })

  test("nombrar el día de HOY se entiende como la semana siguiente", () => {
    // Un lunes, "hablamos el lunes" no habla del rato que viene.
    const r = clasificar("hablamos el lunes")
    assert.ok(r)
    assert.equal(partes(r.cuando).fecha, "03-08")
  })

  test("un finde nombrado cae en el finde mismo (ventana 9-21 todos los días, 09-ago)", () => {
    // Antes se corría al lunes; desde el 09-ago el seguimiento corre también
    // el fin de semana — quien dice "el sábado" recibe el toque el sábado.
    const r = clasificar("el sábado lo reviso")
    assert.ok(r)
    assert.equal(partes(r.cuando).dia, "Sat")
  })

  test("'la próxima semana' gana sobre el día nombrado", () => {
    // "el martes de la próxima semana" no debe caer en el martes de ESTA.
    const r = clasificar("el martes de la próxima semana lo vemos")
    assert.ok(r)
    assert.equal(partes(r.cuando).fecha, "04-08")
  })
})

describe("señales relativas", () => {
  test("'mañana' agenda el día siguiente", () => {
    const r = clasificar("mañana te confirmo")
    assert.ok(r)
    assert.equal(r.tipo, "manana")
    assert.equal(partes(r.cuando).fecha, "28-07")
  })

  test("'la mañana' es franja horaria, no el día siguiente", () => {
    // "te llamo en la mañana" SÍ es señal de espera (promete volver él), pero
    // no debe leerse como el día "mañana": son cosas distintas.
    const r = clasificar("te llamo en la mañana")
    assert.ok(r)
    assert.notEqual(r.tipo, "manana")
    // Y "esta mañana" a secas, sin promesa, no difiere nada.
    assert.equal(clasificar("lo vi esta mañana"), null)
  })

  test("decisión en manos de un tercero difiere el toque", () => {
    const r = clasificar("lo tengo que ver con mi jefe")
    assert.ok(r)
    assert.equal(r.tipo, "espera_tercero")
  })

  test("una promesa inmediata NO difiere nada", () => {
    assert.equal(clasificar("te confirmo enseguida"), null)
  })
})

describe("mensajes sin señal — no deben frenar la cadencia", () => {
  test("respuestas comerciales normales devuelven null", () => {
    for (const m of [
      "sí, dale",
      "el precio me parece caro",
      "cuántos trabajadores puedo cargar?",
      "somos 40 personas",
      "gracias!",
    ]) {
      assert.equal(clasificar(m), null, `${JSON.stringify(m)} no es señal de espera`)
    }
  })
})

describe("todo toque cae en la ventana de seguimiento", () => {
  test("ninguna señal agenda fuera de 9:00-21:00 (el finde SÍ se toca desde el 09-ago)", () => {
    const mensajes = [
      "no me escribas hasta el martes",
      "hablemos la próxima semana",
      "mañana te confirmo",
      "lo veo con mi jefe",
      "el sábado lo reviso",
      "lo vemos más adelante",
    ]
    // Se evalúa desde cada día de la semana: el bug del 24-jul salió justo de
    // un cálculo hecho un viernes por la noche.
    for (let offset = 0; offset < 7; offset++) {
      const ahora = new Date(LUNES_10AM.getTime() + offset * 24 * 3600e3)
      for (const m of mensajes) {
        const r = clasificar(m, ahora)
        if (!r) continue
        const p = partes(r.cuando)
        assert.ok(
          p.hora >= 9 && p.hora < 21,
          `${JSON.stringify(m)} (offset ${offset}) agendó a las ${p.hora}h`,
        )
      }
    }
  })
})

describe("fecha concreta de retoma (09-sep: meses, fechas, 'en N semanas')", () => {
  // LUNES_10AM = 27-jul-2026.
  test("'el 15 de septiembre' agenda ese día", () => {
    const r = clasificar("hablemos el 15 de septiembre")
    assert.ok(r)
    assert.equal(r.tipo, "fecha_explicita")
    assert.equal(partes(r.cuando).fecha, "15-09")
  })
  test("'en octubre' agenda el 1 de octubre; 'a fines de octubre' el 25", () => {
    const a = clasificar("retomamos en octubre")
    assert.ok(a)
    assert.equal(a.tipo, "mes_nombrado")
    assert.equal(partes(a.cuando).fecha, "01-10")
    const b = clasificar("a fines de octubre te aviso")
    assert.ok(b)
    assert.equal(partes(b.cuando).fecha, "25-10")
  })
  test("el mes en curso a secas es 'más adelante' (7 días)", () => {
    const r = clasificar("lo vemos en julio")
    assert.ok(r)
    assert.equal(r.tipo, "largo_plazo")
  })
  test("un mes ya pasado se entiende del año siguiente", () => {
    const r = clasificar("en marzo lo retomamos")
    assert.ok(r)
    assert.ok(r.cuando.getTime() > LUNES_10AM.getTime())
    assert.equal(partes(r.cuando).fecha, "01-03")
  })
  test("'en dos semanas' y 'en 15 días'", () => {
    const a = clasificar("en dos semanas te confirmo")
    assert.ok(a)
    assert.equal(a.tipo, "en_n_semanas")
    assert.equal(partes(a.cuando).fecha, "10-08")
    const b = clasificar("dame 15 días, en 15 dias te escribo")
    assert.ok(b)
    assert.equal(b.tipo, "en_n_dias")
    assert.equal(partes(b.cuando).fecha, "11-08")
  })
  test("no confunde 'mañana' ni 'el martes' con fechas", () => {
    assert.equal(clasificar("mañana te confirmo")?.tipo, "manana")
    assert.equal(clasificar("el martes lo vemos")?.tipo, "dia_nombrado")
  })
})

// HORAS (13-sep, caso +56932011618): "dentro de las 24 horas daré una
// respuesta" devolvía null y el loop le escribió a los 12 minutos.
test("señal en HORAS: 'dentro de las 24 horas' agenda a 24 h y pausa el loop", () => {
  const ahora = new Date("2026-09-13T18:50:00Z")
  const s = clasificarSenalEspera(
    "analizaré la cotización y dentro de las 24 horas daré una respuesta",
    "cl",
    "56932011618",
    ahora,
  )
  assert.ok(s, "debe detectar la señal")
  assert.equal(s!.tipo, "en_n_horas")
  const horas = (s!.cuando.getTime() - ahora.getTime()) / 3600e3
  assert.ok(horas >= 23 && horas <= 25, `esperaba ~24 h, dio ${horas}`)
  // Y por sobre el umbral de pausa, así que el loop se detiene.
  assert.ok(s!.cuando.getTime() - ahora.getTime() > PAUSA_MIN_MS)
})

test("'necesito 24 horas' también cuenta", () => {
  const s = clasificarSenalEspera("necesito 24 horas", "cl", "569", new Date("2026-09-13T18:50:00Z"))
  assert.equal(s?.tipo, "en_n_horas")
})

test("lo inmediato NO es señal de espera", () => {
  const ahora = new Date("2026-09-13T18:50:00Z")
  assert.equal(clasificarSenalEspera("al tiro te digo", "cl", "569", ahora), null)
  assert.equal(clasificarSenalEspera("en un ratito te confirmo", "cl", "569", ahora), null)
})

test("'mañana te confirmo' ahora SUPERA el umbral de pausa (antes solo >3 días pausaba)", () => {
  const ahora = new Date("2026-09-13T18:50:00Z")
  const s = clasificarSenalEspera("mañana te confirmo", "cl", "56932011618", ahora)
  assert.ok(s)
  assert.ok(s!.cuando.getTime() - ahora.getTime() > PAUSA_MIN_MS)
})
