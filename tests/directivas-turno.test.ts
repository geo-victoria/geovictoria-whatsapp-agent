import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { directivaConsultiva, directivaMarcaje, directivasDeTurno } from "../lib/directivas-turno.ts"
import { objecionSinTool, revisarSalida } from "../lib/cinturones-salida.ts"

// Chile consume el módulo compartido: el texto tiene que ser BYTE A BYTE el
// que su webhook tenía inline (fixture congelado el 22-sep desde el código).
const fx = JSON.parse(readFileSync(new URL("./fixtures/directivas-cl.json", import.meta.url), "utf8")) as {
  consultiva: string
  marcaje: string
}

test("directivaConsultiva: idéntica a la inline de Chile, y solo cuando ya preguntó y no mostró el menú", () => {
  const hist = [{ role: "assistant", content: "Para darte la mejor solución, cuéntame un poco de tu operación: a qué se dedican y cómo trabaja tu equipo" }]
  assert.equal(directivaConsultiva(hist), fx.consultiva)
  assert.equal(directivaConsultiva([]), "")
  assert.equal(directivaConsultiva([...hist, { role: "assistant", content: "las formas más usadas para marcar asistencia son:" }]), "")
})

test("directivaMarcaje: Chile 'comuna' idéntica; Perú dice distrito", () => {
  assert.equal(directivaMarcaje("ambos", "comuna"), fx.marcaje)
  assert.equal(directivaMarcaje("ambos"), fx.marcaje)
  const pe = directivaMarcaje("reloj", "distrito")
  assert.ok(pe.includes("el distrito de ese punto") && pe.includes("es el distrito;") && !pe.includes("comuna"), pe)
  assert.ok(!pe.includes("${zona}"))
  assert.equal(directivaMarcaje("quiero 3 relojes en 2 sedes", "comuna"), "")
  assert.equal(directivaMarcaje("app", "comuna"), "")
})

test("directivasDeTurno PE: RUC sin correo dispara con precio visto; con correo no", () => {
  const hist = [
    { role: "assistant", content: "Total mensual: S/66 + IGV" },
  ]
  const d = directivasDeTurno("mi ruc es 20605842055", hist, { zona: "distrito", documento: "RUC" })
  assert.ok(d.includes("entregarte el RUC"), d)
  assert.equal(directivasDeTurno("mi ruc es 20605842055, correo ana@x.pe", hist, { zona: "distrito", documento: "RUC" }), "")
  assert.equal(directivasDeTurno("mi nit es 900123456-7", hist, { zona: "ciudad", documento: "NIT" }), "")
})

test("cinturón objeción de precio: sin tool → reintento; con tool de descuento → ok", () => {
  assert.equal(objecionSinTool("es muy caro, tienen descuento?", []), true)
  assert.equal(objecionSinTool("es muy caro, tienen descuento?", ["consultar_descuento_referencial"]), false)
  assert.equal(objecionSinTool("dale, me interesa", []), false)
  const v = revisarSalida({
    reply: "Ana, para poder ayudarte con el mejor precio, primero necesito saber con qué modalidad te quedas.",
    toolCalls: [],
    historialAsistente: [],
    pais: "pe",
    userMessage: "es muy caro, tienen descuento?",
  })
  assert.equal(v.accion, "reintento")
  assert.equal(v.cinturon, "objecion_precio_sin_tool")
  assert.equal(v.siFallaReintento, "dejar_pasar")
})

test("reloj + ubicación en el mismo mensaje → cotizar sin repreguntar (E2E 24-sep)", async () => {
  const { directivaMarcaje, ubicacionEnMensaje } = await import("../lib/directivas-turno.ts")
  assert.equal(ubicacionEnMensaje("Quiero la app y un reloj, estamos en Providencia"), "estamos en Providencia")
  assert.equal(ubicacionEnMensaje("Quiero la app y un equipo biométrico, estamos en Bogotá"), "estamos en Bogotá")
  assert.equal(ubicacionEnMensaje("reloj, en CDMX"), "en CDMX")
  assert.equal(ubicacionEnMensaje("con reloj"), "")
  assert.equal(ubicacionEnMensaje("estamos en Providencia"), "")
  assert.match(directivaMarcaje("Quiero la app y un reloj, estamos en Providencia"), /PROHIBIDO volver a preguntar la comuna/)
})
