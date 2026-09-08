import { test } from "node:test"
import assert from "node:assert/strict"
import { esRechazoCliente, pareceTextoInterno, ultimoMensajeCliente } from "../lib/rechazo-cliente.ts"

// Casos REALES de la campaña remk_300 (08-sep).
test("rechazos reales de la campaña", () => {
  for (const t of [
    "no",
    "No muchas gracias",
    "perdon pero podrian dejar de escribirme y llamarme, ya dije que no quiero el servicio. muchas gracias",
    "Hola, me desvincule de la empresa interesada",
    "Quedamos hasta aquí, muchas gracias igualmente",
    "gracias, pero por ahora no estoy interesada",
    "hola, ya no lo necesito, gracias",
    "No gracias",
    "Hola ya no admnistro ese edificio, por lo que no se en que quedo esa cotizacion",
    "Ya lo resolvimos",
    "ya contratamos gracias",
    "Hola buenas ya compramos uno en otro lado",
    "No entiendo, esto sería spam? Ya se cerró la conversación y se está intentando retomar",
  ]) assert.equal(esRechazoCliente(t), true, t)
})

test("interés o preguntas NO son rechazo", () => {
  for (const t of [
    "Hola, ¿cómo estás? Sí, quiero retomar el tema",
    "Llameme",
    "Si",
    "Hola, firmarán 3 personas con app",
    "En el caso de que se termine la obra y tengamos que finiquitar hay algún valor permanente?",
    "Hola Buenas tardes, Patricia se encuentra de vacaciones, te puede volver a comunicar la próxima semana???",
    "no tengo el rut a mano, te lo mando mañana",
    "no sé cuántas personas serían todavía",
    "Gracias",
  ]) assert.equal(esRechazoCliente(t), false, t)
})

test("texto interno del generador se detecta", () => {
  assert.equal(pareceTextoInterno("No hay mensaje que escribir en este caso. El cliente se desvinculó de la empresa interesada y cerró explícitamente la conversación"), true)
  assert.equal(pareceTextoInterno("NO_ENVIAR"), true)
  assert.equal(pareceTextoInterno("Vi que consultaste por las obras menores y te preocupaba el tema de los meses sin personal. ¿Cuántas personas marcarían cuando arranque la próxima obra?"), false)
})

test("último mensaje del cliente ignora registros internos", () => {
  assert.equal(ultimoMensajeCliente([{ role: "user", content: "no gracias" }, { role: "assistant", content: "ok" }, { role: "user", content: "[REGISTRO INTERNO] x" }]), "no gracias")
})
