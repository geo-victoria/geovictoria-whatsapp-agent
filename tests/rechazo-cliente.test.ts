import { test } from "node:test"
import assert from "node:assert/strict"
import {
  esRechazoCliente,
  esAutorespuesta,
  quitarSaludoInicial,
  pareceTextoInterno,
  ultimoMensajeCliente,
  posturaRechazoCliente,
  clasificarTextoInterno,
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

test("postura en contexto: el rechazo sobrevive a las cortesías posteriores (Marisol / Anderson 09-sep)", () => {
  const marisol = [
    { role: "assistant", content: "Hola Marisol! Perfecto, entonces te sigue interesando?" },
    { role: "user", content: "Ya lo resolvimos" },
    { role: "assistant", content: "Entiendo! Qué fue lo que eligieron?" },
    { role: "user", content: "Te agradezco" },
    { role: "assistant", content: "De nada!" },
    { role: "user", content: "Gracias de todas formas" },
    { role: "assistant", content: "De verdad, para eso estamos!" },
  ]
  assert.equal(posturaRechazoCliente(marisol), "no_interesa")
  const parqueMirador = [
    { role: "user", content: "Hola ya no admnistro ese edificio, por lo que no se en que quedo esa cotizacion" },
    { role: "assistant", content: "Entiendo, dejamos cerrada esa cotización. Hay algo más?" },
    { role: "assistant", content: "Para armarte el valor solo me falta saber cuántas personas marcarían" },
    { role: "user", content: "Nada gracias" },
    { role: "assistant", content: "Perfecto, cualquier cosa aquí estoy" },
  ]
  assert.equal(posturaRechazoCliente(parqueMirador), "no_interesa")
  const prem = [
    { role: "user", content: "No gracias" },
    { role: "assistant", content: "Entendido, sin problema" },
    { role: "user", content: "Gracias !!☺️" },
    { role: "assistant", content: "De nada! Un abrazo 👋" },
  ]
  assert.equal(posturaRechazoCliente(prem), "no_interesa")
})

test("postura en contexto: un 'no' a '¿algo más?' y un 'ok gracias' tras la formal NO son rechazo", () => {
  const gonzalo = [
    { role: "user", content: "gonzalo.carroza@gcb.cl" },
    { role: "assistant", content: "Perfecto, Gonzalo! Un ejecutivo te contactará. ¿Hay algo más en lo que pueda ayudarte?" },
    { role: "user", content: "no" },
    { role: "assistant", content: "Listo, Gonzalo! Cualquier cosa, aquí estoy" },
  ]
  assert.equal(posturaRechazoCliente(gonzalo), null)
  const capriccio = [
    { role: "user", content: "78267074-3" },
    { role: "assistant", content: "Lista tu cotización! Revísala aquí: https://cotizacion.geovictoria.com/q/x" },
    { role: "user", content: "Aramcoconcepcionbonilla@gmail.com" },
    { role: "assistant", content: "Perfecto! Ya tengo tu correo" },
    { role: "user", content: "Ok gracias" },
    { role: "assistant", content: "De nada!" },
  ]
  assert.equal(posturaRechazoCliente(capriccio), null)
  // "no" pelado DESPUÉS de un toque sí es rechazo.
  const toque = [
    { role: "assistant", content: "Hola, todo bien? Sigues interesado en el control de asistencia?" },
    { role: "user", content: "No" },
  ]
  assert.equal(posturaRechazoCliente(toque), "no_interesa")
})

// Caso Valeska (+56976048070, 14-sep): pidió cuatro veces que no insistieran y
// el loop le mandó otro toque cuatro días después. Ninguna frase disparaba el
// detector: "es spam?" fallaba porque el patrón exigía el "esto" delante.
test("la queja de insistencia cierra la proactividad", () => {
  for (const f of [
    "Hola disculpe pero es spam ?",
    "Me han hablado demasiado desde que hice cotizacion",
    "Si decido yo les escribo",
    "Pero ya a cada rato mensaje con la mismo jeje",
    "Y ya he dicho que voy a analizar",
    "son muy insistentes",
    "los voy a bloquear",
  ]) assert.equal(esRechazoCliente(f), true, f)
})

// Y lo que NO puede cerrarse: evaluar no es rechazar.
test("evaluar o consultar no es rechazo", () => {
  for (const f of [
    "Voy a analizar bien",
    "Estoy cotizando",
    "Lo voy a ver con mi jefe",
    "Cuantas personas marcan?",
    "Si, me interesa",
  ]) assert.equal(esRechazoCliente(f), false, f)
})

// Caso Montecosta Travel Spa (+56977741817, 14-sep): el razonamiento interno
// salió al cliente envuelto en el marco del toque. Tres marcas que el filtro
// del 08-sep no veía: "no puedo escribir", hablar del cliente en tercera
// persona, y citar la regla interna.
test("el razonamiento interno no se envia (caso Montecosta)", () => {
  const real =
    "No puedo escribir este mensaje. El cliente acaba de decir \"Avanzaré con el pago durante el día\" hace 1 hora. " +
    "Está dentro del plazo que él mismo señaló. Retomarlo ahora sería apurarlo sin razón y violaría la regla de " +
    "respetar los plazos que el cliente ya comunicó. Espera al menos hasta mañana, cuando sea evidente que no " +
    "cumplió su propia promesa de pagar."
  assert.equal(pareceTextoInterno(real), true)
  for (const f of [
    "No puedo enviar este mensaje todavía",
    "El cliente dijo que lo veía con su jefe",
    "Esto violaría la regla de no insistir",
    "Espera al menos hasta mañana",
  ]) assert.equal(pareceTextoInterno(f), true, f)
})

test("un toque normal no se confunde con texto interno", () => {
  for (const f of [
    "Hola Javiera! Te quedó alguna duda con la cotización?",
    "Tu cotización sigue vigente y con el mismo valor",
    "Quedaste en comentarme, así que no te apuro. ¿Cómo te fue?",
    "Te dejo el link por si quieres avanzar con el pago",
  ]) assert.equal(pareceTextoInterno(f), false, f)
})

/**
 * Deliberación vs decisión (14-sep, caso Luis Rivano +56930648645): el toque
 * de los 11 minutos le mandó al cliente el razonamiento del modelo. Cerrarle
 * el loop por eso sería castigarlo dos veces por un fallo nuestro.
 */
test("el razonamiento de Luis Rivano se detecta y NO cierra el loop", () => {
  const t =
    "Hola, todo bien? Entiendo que pasaron solo 11 minutos, así que técnicamente el cliente aún está en la " +
    "conversación inicial. Sin embargo, siguiendo las reglas: el cliente no ha respondido a la pregunta sobre " +
    "cómo trabaja su equipo. El mensaje de retome sería: Necesito entender un poco más tu operación."
  assert.equal(clasificarTextoInterno(t), "razonamiento")
  assert.equal(pareceTextoInterno(t), true)
})

test("la decisión de no escribir sigue cerrando el loop", () => {
  for (const t of [
    "No hay mensaje que escribir en este caso. El cliente se desvinculó de la empresa.",
    "NO_ENVIAR",
    "No puedo escribir este mensaje: el cliente acaba de decir que avanzará con el pago.",
  ]) assert.equal(clasificarTextoInterno(t), "no_enviar", t)
})

test("un toque legítimo no se confunde con texto interno", () => {
  for (const t of [
    "Quedaste en comentarme cómo trabaja tu equipo en el centro cultural. Los 5 están siempre en el mismo lugar o algunos se mueven?",
    "Vi que quedó pendiente lo del reloj para la sucursal nueva. Lo dejamos andando con app y después sumamos el equipo?",
    "Te quedó la duda de si el sistema calcula las horas extras solas. Sí lo hace. Seguimos?",
  ]) assert.equal(clasificarTextoInterno(t), "ok", t)
})

test("TODAVIA_NO es una salida propia: ni rechazo ni divagación", () => {
  assert.equal(clasificarTextoInterno("TODAVIA_NO"), "todavia_no")
  assert.equal(clasificarTextoInterno("todavia_no"), "todavia_no")
  // y sigue distinguiéndose de las otras dos
  assert.equal(clasificarTextoInterno("NO_ENVIAR"), "no_enviar")
  assert.equal(clasificarTextoInterno("El cliente no ha respondido todavía."), "razonamiento")
})
