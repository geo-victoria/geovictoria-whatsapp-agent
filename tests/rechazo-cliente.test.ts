import { test } from "node:test"
import assert from "node:assert/strict"
import {
  esRechazoCliente,
  esAutorespuesta,
  quitarSaludoInicial,
  pareceTextoInterno,
  ultimoMensajeCliente,
} from "../lib/rechazo-cliente.ts"

// Autorespuestas REALES recibidas en la campaña remk_300 (08-sep).
test("autorespuestas reales se detectan", () => {
  for (const t of [
    "Gracias por comunicarte con Lolalash.\n\nPara agendar hora \nMall Vivo Los Trapenses +569 2003 2773 - 229558037",
    "Gracias por comunicarte con Agua rural las quemas. ¿Cómo podemos ayudarte?",
    "Gracias por comunicarte con nosotros. Por favor, haznos saber cómo podemos ayudarte.",
    "Gracias por tu mensaje. En este momento no estamos disponibles por este medio. Por favor utilice los canales de comunicación formal",
    "Gracias por comunicarte con Veterinaria móvil Amivet.🐾\nEn este contacto solo puedes agendar atención a domicilio",
    "Hola! Este es un mensaje automático. Te responderemos a la brevedad.",
  ]) assert.equal(esAutorespuesta(t), true, t)
})

test("personas reales NO son autorespuesta", () => {
  for (const t of [
    "Hola buenas tardes",
    "si estoy interesada",
    "Gracias !!☺️",
    "Gracias de todas formas",
    "Ok. Depende del precio.",
    "gracias, te confirmo mañana cuántas personas son",
    "Hola Buenas tardes, Patricia se encuentra de vacaciones, te puede volver a comunicar la próxima semana???",
  ]) assert.equal(esAutorespuesta(t), false, t)
})

test("el saludo duplicado del toque 5 se quita", () => {
  assert.equal(
    quitarSaludoInicial("Hola, todo bien? Recordaba que quedamos en que me pasaras la información."),
    "Recordaba que quedamos en que me pasaras la información.",
  )
  assert.equal(quitarSaludoInicial("¡Hola! ¿Cómo estás? vi que Grey te contactó"), "Vi que Grey te contactó")
  assert.equal(quitarSaludoInicial("Vi que consultaste por las obras menores."), "Vi que consultaste por las obras menores.")
  assert.equal(quitarSaludoInicial("Hola, todo bien?"), "Hola, todo bien?")
})

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
