import { test } from "node:test"
import assert from "node:assert/strict"
import {
  prometeContactoSinRegistro,
  afirmaRegistroExplicito,
  afirmaContactoGenerico,
  clientePidioContacto,
  preguntaOperativaDePlazo,
} from "../lib/promesa-contacto.ts"

// CASO FRANCISCA (14-sep, +56956387811): preguntó el plazo de instalación dos
// minutos después de recibir su cotización y el cinturón le tapó la respuesta.
test("pregunta de plazo de instalación no es promesa de callback", () => {
  const reply =
    "El equipo de implementación te va a contactar para coordinar la instalación del reloj 😊"
  assert.equal(
    prometeContactoSinRegistro(reply, {
      mensajeCliente: "cuando podrian instalarlo?",
      textosCliente: ["3 app", "las condes", "reloj pared", "instalar reloj, no app", "19079676-0  fraanhites@gmail.com", "gracias", "cuando podrian instalarlo?"],
    }),
    false,
  )
})

test("otras preguntas operativas de plazo tampoco disparan", () => {
  const reply = "Un ejecutivo del equipo te va a contactar para coordinarlo"
  for (const m of [
    "cuanto demora la implementacion?",
    "en cuanto tiempo llega el reloj?",
    "para cuando la capacitacion?",
    "cuando me despachan el equipo?",
  ]) {
    assert.equal(prometeContactoSinRegistro(reply, { mensajeCliente: m }), false, m)
  }
})

// Lo que el cinturón SÍ debe seguir atrapando.
test("afirmar que registró los datos siempre cuenta, aunque pregunte un plazo", () => {
  assert.equal(
    prometeContactoSinRegistro("Dejé registrada tu solicitud y el equipo la tiene con tus datos", {
      mensajeCliente: "cuando podrian instalarlo?",
    }),
    true,
  )
})

test("casos Daniela y Rosa (10-sep) siguen disparando", () => {
  assert.equal(afirmaRegistroExplicito("Ya está escalado para que Paola te llame HOY"), true)
  assert.equal(afirmaRegistroExplicito("Te conectamos con el ejecutivo que lleva tu cuenta"), true)
  assert.equal(afirmaRegistroExplicito("Listo, ya quedaste registrada en el sistema"), true)
  assert.equal(afirmaRegistroExplicito("Le pasé tus datos a nuestro equipo comercial"), true)
})

test("el cliente que PIDE ser llamado dispara igual, incluso preguntando plazos", () => {
  const reply = "Un ejecutivo te va a llamar para coordinar la instalación"
  assert.equal(
    prometeContactoSinRegistro(reply, {
      mensajeCliente: "cuando podrian instalarlo? prefiero que me llamen",
      textosCliente: ["prefiero que me llamen"],
    }),
    true,
  )
  assert.equal(clientePidioContacto(["Llámeme"]), true)
  assert.equal(clientePidioContacto(["quiero hablar con un ejecutivo"]), true)
  assert.equal(clientePidioContacto(["3 app", "las condes"]), false)
})

test("la oferta en subjuntivo nunca fue promesa", () => {
  assert.equal(afirmaContactoGenerico("¿Quieres que un ejecutivo te contacte?"), false)
  assert.equal(prometeContactoSinRegistro("¿Te contacto con un ejecutivo?", {}), false)
})

test("sin pregunta de plazo, la forma genérica sigue exigiendo tool", () => {
  assert.equal(
    prometeContactoSinRegistro("Un ejecutivo te va a contactar a la brevedad", { mensajeCliente: "ok gracias" }),
    true,
  )
})

test("preguntaOperativaDePlazo exige plazo Y tema operativo", () => {
  assert.equal(preguntaOperativaDePlazo("cuando podrian instalarlo?"), true)
  assert.equal(preguntaOperativaDePlazo("cuando me llaman?"), false)
  assert.equal(preguntaOperativaDePlazo("me instalan el reloj"), false)
})
