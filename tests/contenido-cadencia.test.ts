import { test } from "node:test"
import assert from "node:assert/strict"
import { PIEZAS, anioDePieza, correoDeContenido, piezaVigente, siguientePieza, temaParaMotivo, tocaContenido } from "../lib/contenido-cadencia.ts"

test("el catálogo no tiene ids ni URLs repetidas y todas son del blog CL", () => {
  const ids = new Set(PIEZAS.map((p) => p.id))
  const urls = new Set(PIEZAS.map((p) => p.url))
  assert.equal(ids.size, PIEZAS.length)
  assert.equal(urls.size, PIEZAS.length)
  for (const p of PIEZAS) assert.match(p.url, /^https:\/\/www\.geovictoria\.com\/es-cl\/blog\/[a-z0-9.\-]+\/$/)
})

test("rotación: nunca repite una pieza ya enviada y se agota", () => {
  const enviadas: string[] = []
  for (let i = 0; i < PIEZAS.length; i++) {
    const p = siguientePieza(enviadas)
    assert.ok(p, `debía quedar pieza en la vuelta ${i}`)
    assert.ok(!enviadas.includes(p.id))
    enviadas.push(p.id)
  }
  assert.equal(siguientePieza(enviadas), null)
})

test("la objeción manda: con motivo legal sale una pieza legal", () => {
  const p = siguientePieza(["art22", "res38"], "objeción legal / normativa")
  assert.ok(p)
  assert.ok(p.temas.includes("legal"))
  assert.ok(!["art22", "res38"].includes(p.id))
})

test("motivo de hardware trae una pieza de hardware, no la primera del orden", () => {
  const p = siguientePieza([], "el cliente quería otro reloj")
  assert.ok(p)
  assert.ok(p.temas.includes("hardware"))
})

test("temaParaMotivo no inventa tema cuando el motivo es genérico", () => {
  assert.equal(temaParaMotivo("silencio"), null)
  assert.equal(temaParaMotivo(null), null)
  assert.equal(temaParaMotivo("faltaron_datos"), null)
})

test("frecuencia: sin envío previo toca; dentro de los 30 días no", () => {
  const ahora = new Date("2026-09-13T14:00:00Z")
  assert.equal(tocaContenido(null, ahora).toca, true)
  assert.equal(tocaContenido("2026-09-01T14:00:00Z", ahora).toca, false)
  assert.equal(tocaContenido("2026-08-01T14:00:00Z", ahora).toca, true)
  // Fecha ilegible: no se queda pegado para siempre.
  assert.equal(tocaContenido("no-es-fecha", ahora).toca, true)
})

test("el correo de contenido NO vende: sin precio, sin cotización, sin descuento", () => {
  const { asunto, html } = correoDeContenido({ nombre: "Ana", pieza: PIEZAS[0], fromEmail: "vicky@geovictoria.com", waUrl: "https://wa.me/569" })
  assert.equal(asunto, PIEZAS[0].titulo)
  assert.match(html, /No vengo a venderte nada/)
  assert.match(html, new RegExp(PIEZAS[0].url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.doesNotMatch(html, /descuento|cotizaci[oó]n sigue vigente|\$\s?\d|UF/i)
  // Opt-out visible, compartido con el de la campaña.
  assert.match(html, /no recibir estos correos/)
})

test("sin nombre el saludo no queda cojo", () => {
  const { html } = correoDeContenido({ pieza: PIEZAS[1], fromEmail: "vicky@geovictoria.com", waUrl: "https://wa.me/569" })
  assert.match(html, /Hola! Soy <b>Vicky<\/b>/)
})

test("la objeción de PRECIO —la más frecuente— trae una pieza de costo, no la primera del orden", () => {
  const p = siguientePieza([], "precio")
  assert.ok(p)
  assert.ok(p.temas.includes("costo"), `salió ${p?.id}`)
  assert.equal(temaParaMotivo("el cliente lo encontró caro"), "costo")
  assert.equal(temaParaMotivo("no hay presupuesto este año"), "costo")
})

test("ninguna pieza promete un precio NUESTRO ni una oferta comercial", () => {
  // OJO: "Descuentos por atrasos" es un descuento de REMUNERACIONES, no una
  // oferta — por eso el patrón busca la oferta comercial, no la palabra suelta.
  const oferta = /% de descuento|descuento en el plan|oferta|promoci[oó]n|\$\s?\d|\bUF\b|barato|precio especial/i
  for (const p of PIEZAS) assert.doesNotMatch(`${p.titulo} ${p.gancho}`, oferta, `pieza ${p.id}`)
})

test("vigencia: una pieza con año pasado en el título NO sale, aunque nadie declare el campo", () => {
  const ahora = new Date("2026-09-13T12:00:00Z")
  const vieja = { id: "x", titulo: "Feriados en Chile 2025: todos los días festivos", gancho: "g", url: "https://x/", temas: ["legal" as const] }
  const deEsteAnio = { ...vieja, id: "y", titulo: "Feriados en Chile 2026" }
  const sinAnio = { ...vieja, id: "z", titulo: "Cómo se compensa un feriado irrenunciable" }
  assert.equal(anioDePieza(vieja), 2025)
  assert.equal(piezaVigente(vieja, ahora), false)
  assert.equal(piezaVigente(deEsteAnio, ahora), true)
  assert.equal(anioDePieza(sinAnio), null)
  assert.equal(piezaVigente(sinAnio, ahora), true)
  // El campo explícito manda sobre el título.
  assert.equal(piezaVigente({ ...sinAnio, anio: 2024 }, ahora), false)
})

test("ninguna pieza del catálogo está vencida hoy", () => {
  const ahora = new Date()
  const vencidas = PIEZAS.filter((p) => !piezaVigente(p, ahora)).map((p) => p.id)
  assert.deepEqual(vencidas, [])
})

test("la rotación salta las vencidas y las descartadas por link muerto", () => {
  const ahora = new Date("2026-09-13T12:00:00Z")
  const primera = siguientePieza([], null, { ahora })
  assert.ok(primera)
  const segunda = siguientePieza([], null, { ahora, excluir: [primera.id] })
  assert.ok(segunda)
  assert.notEqual(segunda.id, primera.id)
})

test("el catálogo cubre las objeciones que más aparecen", () => {
  const ahora = new Date()
  for (const motivo of ["precio", "el cliente quería otro reloj", "duda legal", "horas extras"]) {
    const p = siguientePieza([], motivo, { ahora })
    assert.ok(p, `sin pieza para ${motivo}`)
  }
  // Entrada, equipos y dudas operativas: los huecos que el catastro mostró.
  const ids = new Set(PIEZAS.map((p) => p.id))
  for (const id of ["cinco_razones", "tipos_reloj", "facial", "colacion", "derechos_registro", "conservar", "irrenunciable", "libro_asistencia"]) {
    assert.ok(ids.has(id), `falta ${id}`)
  }
  assert.equal(PIEZAS.filter((p) => p.temas.includes("hardware")).length, 4)
})
