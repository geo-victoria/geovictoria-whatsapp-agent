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
      referenciaRelojAt: new Date(MIERCOLES_HABIL.getTime() - 20 * 60000),
    })
    assert.equal(d.traspasar, true)
    assert.equal(d.ttv, 15)
  })

  test("sin precio y 20 min → NO traspasa (TTV 120)", () => {
    const d = debeTraspasar({
      ...base,
      precioMostrado: false,
      referenciaRelojAt: new Date(MIERCOLES_HABIL.getTime() - 20 * 60000),
    })
    assert.equal(d.traspasar, false)
  })

  test("el cliente respondió → nunca traspasa", () => {
    const d = debeTraspasar({
      ...base,
      clienteRespondioDespues: true,
      precioMostrado: true,
      referenciaRelojAt: new Date(MIERCOLES_HABIL.getTime() - 60 * 60000),
    })
    assert.equal(d.traspasar, false)
  })

  test("pausa anunciada vigente suspende el TTV", () => {
    const d = debeTraspasar({
      ...base,
      precioMostrado: true,
      referenciaRelojAt: new Date(MIERCOLES_HABIL.getTime() - 60 * 60000),
      compromisoAt: new Date(MIERCOLES_HABIL.getTime() + 60 * 60000),
    })
    assert.equal(d.traspasar, false)
  })

  test("pausa vencida: el TTV corre desde el vencimiento, no desde el mensaje", () => {
    const d = debeTraspasar({
      ...base,
      precioMostrado: true,
      referenciaRelojAt: new Date(MIERCOLES_HABIL.getTime() - 300 * 60000),
      compromisoAt: new Date(MIERCOLES_HABIL.getTime() - 5 * 60000), // venció hace 5 min < TTV 15
    })
    assert.equal(d.traspasar, false)
  })

  test("traspaso activo previo → jamás doble PTV", () => {
    const d = debeTraspasar({
      ...base,
      traspasoActivo: true,
      precioMostrado: true,
      referenciaRelojAt: new Date(MIERCOLES_HABIL.getTime() - 600 * 60000),
    })
    assert.equal(d.traspasar, false)
  })

  test("fuera de horario hábil el reloj no dispara", () => {
    const d = debeTraspasar({
      ...base,
      ahora: DOMINGO,
      precioMostrado: true,
      referenciaRelojAt: new Date(DOMINGO.getTime() - 600 * 60000),
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
    // Versión corta (Eduardo 17-ago): murió el "te va a llamar muy pronto" y
    // el "no tendrás que repetir nada" — la presentación es solo quién atiende
    // y sus datos. Se fija que las frases viejas no vuelvan.
    for (const pais of ["cl", "co", "mx"] as const) {
      const m = mensajePresentacion(pais, "Eddyluz")
      assert.ok(!/\bOye\b/i.test(m))
      assert.match(m, /Eddyluz/)
      assert.ok(!/te va a llamar/i.test(m), "volvió la promesa de llamada")
      assert.ok(!/repetir nada/i.test(m), "volvió el texto largo")
      assert.ok(!/¡Hola!/.test(m), "volvió el saludo — la presentación entra directo")
    }
  })

  test("la presentación incluye los datos de contacto del vendedor (Lalo 31-jul)", () => {
    const m = mensajePresentacion("cl", "Tamara Martínez", {
      email: "tmartinezq@geovictoria.com",
      whatsapp: "+56 9 3452 9937",
    })
    assert.match(m, /✉️ tmartinezq@geovictoria\.com/)
    assert.match(m, /📱 WhatsApp: \+56 9 3452 9937/)
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

  test("el reloj TTV mide desde el último mensaje del CLIENTE (los toques del Loop no lo reinician)", () => {
    assert.match(CRON, /referenciaRelojAt: ultimoCliente/)
    assert.match(CRON, /if \(!c\.last_user_at\) continue/)
  })

  test("ni contactos de prueba ni IDs sin teléfono discable entran al PTV", () => {
    assert.match(CRON, /isTestContact\(c\.contact, contactosPrueba\)/)
    assert.match(CRON, /\^\(56\|57\|52\|51\)/)
  })

  test("deals CERRADOS no se reasignan; sin lead se crea uno a nombre del vendedor", () => {
    // Aprendizaje 31-jul: el primer barrido reasignó Cierre Perdido ajenos.
    assert.match(CRON, /Cierre Perdido\|8\\\. Facturando/)
    assert.match(CRON, /no se reasigna/)
    assert.match(CRON, /createZohoLead/)
  })

  test("el deal traspasado pasa por la regla de tómbola de Zoho y se presenta al dueño real", () => {
    assert.match(CRON, /TOMBOLA_DEALS_RULE/)
    assert.match(CRON, /lar_id/)
    // La asignación resuelve el vendedor ANTES de la presentación: al
    // prospecto jamás se le nombra a alguien distinto del dueño en Zoho, y
    // la presentación lleva sus datos de contacto.
    assert.match(CRON, /mensajePresentacion\(pais, vendedor\.nombre, \{ email: vendedor\.email, whatsapp: vendedor\.telefono \}\)/)
    // Deal con dueño humano vigente → se presenta a ESE dueño, sin re-sorteo.
    assert.match(CRON, /via: "dueno_deal"/)
  })
})

describe("relojes v2 con-precio son de SILENCIO (orden Lalo 08-ago)", () => {
  // El diagnóstico de la caída de ventas: el reloj de etapa con precio caía
  // en plena compra (mediana histórica emisión→pago = 36 min; el reloj
  // cortaba a los 10-15). Con precio dado, el traspaso vuelve a medir
  // SILENCIO del cliente: quien conversa jamás se interrumpe.
  const min = (n: number) => new Date(MIERCOLES_HABIL.getTime() - n * 60000)
  const base = {
    pais: "cl" as const,
    ahora: MIERCOLES_HABIL,
    traspasoActivo: false,
    compromisoAt: null,
    aceptada: false,
    firstUserAt: min(300),
    userMsgCount: 5,
  }

  test("cliente ACTIVO con formal de hace 30 min → NO se traspasa", async () => {
    const { debeTraspasarEtapa } = await import("../lib/ptv.ts")
    const d = debeTraspasarEtapa({
      ...base,
      precioAt: min(40),
      formalAt: min(30),
      ultimoClienteAt: min(2),
      clienteRespondioDespues: true,
    })
    assert.equal(d.traspasar, false)
  })

  test("cliente recién respondió (silencio 2 min) tras la formal → NO se traspasa", async () => {
    const { debeTraspasarEtapa } = await import("../lib/ptv.ts")
    const d = debeTraspasarEtapa({
      ...base,
      precioAt: min(40),
      formalAt: min(30),
      ultimoClienteAt: min(2),
      clienteRespondioDespues: false,
    })
    assert.equal(d.traspasar, false)
  })

  // RELOJES DE LA BIBLIA (VB 12-ago): R2 referencial = 30' de silencio,
  // R3 formal = 40' de silencio (reemplazan el 15' único del 08-ago).
  test("silencio de 20 min tras ver el precio → aún NO traspasa (R2 es 30)", async () => {
    const { debeTraspasarEtapa } = await import("../lib/ptv.ts")
    const d = debeTraspasarEtapa({
      ...base,
      precioAt: min(25),
      formalAt: null,
      ultimoClienteAt: min(20),
      clienteRespondioDespues: false,
    })
    assert.equal(d.traspasar, false)
  })

  test("silencio de 35 min tras el precio referencial → traspasa (R2 = 30)", async () => {
    const { debeTraspasarEtapa } = await import("../lib/ptv.ts")
    const d = debeTraspasarEtapa({
      ...base,
      precioAt: min(40),
      formalAt: null,
      ultimoClienteAt: min(35),
      clienteRespondioDespues: false,
    })
    assert.equal(d.traspasar, true)
    assert.equal(d.motivo, "precio_sin_respuesta")
    assert.equal(d.ttv, 30)
  })

  test("silencio de 35 min tras la FORMAL → aún NO traspasa (R3 es 40)", async () => {
    const { debeTraspasarEtapa } = await import("../lib/ptv.ts")
    const d = debeTraspasarEtapa({
      ...base,
      precioAt: min(60),
      formalAt: min(35),
      ultimoClienteAt: min(50),
      clienteRespondioDespues: false,
    })
    assert.equal(d.traspasar, false)
  })

  test("silencio de 45 min tras la formal → traspasa (R3 = 40)", async () => {
    const { debeTraspasarEtapa } = await import("../lib/ptv.ts")
    const d = debeTraspasarEtapa({
      ...base,
      precioAt: min(60),
      formalAt: min(45),
      ultimoClienteAt: min(50),
      clienteRespondioDespues: false,
    })
    assert.equal(d.traspasar, true)
    assert.equal(d.motivo, "formal_sin_respuesta")
    assert.equal(d.ttv, 40)
  })

  test("formal recién emitida a cliente callado hace 1h: el silencio parte en la FORMAL", async () => {
    const { debeTraspasarEtapa } = await import("../lib/ptv.ts")
    const d = debeTraspasarEtapa({
      ...base,
      precioAt: min(70),
      formalAt: min(5),
      ultimoClienteAt: min(60),
      clienteRespondioDespues: false,
    })
    assert.equal(d.traspasar, false)
  })

  test("sin precio, reloj de etapa vencido + cliente ESCRIBIENDO (<10 min): el anuncio ESPERA (caso Loumar, 29-ago)", async () => {
    const { debeTraspasarEtapa } = await import("../lib/ptv.ts")
    const d = debeTraspasarEtapa({
      ...base,
      firstUserAt: min(130),
      precioAt: null,
      formalAt: null,
      ultimoClienteAt: min(3),
      clienteRespondioDespues: false,
    })
    // El reloj de ETAPA sigue vencido (08-ago intacto), pero el ANUNCIO se
    // aplaza mientras el cliente está activo: se dispara al próximo tick con
    // ≥10 min de silencio.
    assert.equal(d.traspasar, false)
  })

  test("sin precio, reloj de etapa vencido + cliente en PAUSA (≥10 min): el traspaso se anuncia", async () => {
    const { debeTraspasarEtapa } = await import("../lib/ptv.ts")
    const d = debeTraspasarEtapa({
      ...base,
      firstUserAt: min(130),
      precioAt: null,
      formalAt: null,
      ultimoClienteAt: min(12),
      clienteRespondioDespues: false,
    })
    assert.equal(d.traspasar, true)
    assert.equal(d.motivo, "etapa_sin_preform")
  })
})
