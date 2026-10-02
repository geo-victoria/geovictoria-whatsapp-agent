/**
 * Directiva "llegó el RUT, no hay correo, EMITE" (Lalo 31-ago).
 * El caso 1 es literal de la prueba en vivo que la motivó.
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import {
  directivaRutSinCorreo,
  directivaNombreSinCorreo,
  traeRutValido,
  clienteDioCorreo,
} from "../lib/rut-sin-correo.ts"

const conPrecio = [
  { role: "user", content: "somos 18 personas en una caleta de pesca artesanal" },
  { role: "assistant", content: "Con app móvil → $18.711/mes con IVA." },
]

describe("directiva RUT sin correo", () => {
  test("dispara con el caso real de la prueba (18435922-7)", () => {
    assert.match(directivaRutSinCorreo("18435922-7", conPrecio), /OMITIENDO/)
  })
  test("acepta el RUT con puntos y guion", () => {
    assert.notEqual(directivaRutSinCorreo("77.111.222-6", conPrecio), "")
  })
  test("NO dispara si el cliente ya dio su correo antes", () => {
    const h = [...conPrecio, { role: "user", content: "mi correo es lalo@geovictoria.com" }]
    assert.equal(directivaRutSinCorreo("18435922-7", h), "")
  })
  test("NO dispara si RUT y correo vienen juntos", () => {
    assert.equal(directivaRutSinCorreo("18435922-7 lalo@geovictoria.com", conPrecio), "")
  })
  test("NO dispara antes de mostrar precio", () => {
    assert.equal(directivaRutSinCorreo("18435922-7", [{ role: "user", content: "hola" }]), "")
  })
  test("NO dispara con dígito verificador malo", () => {
    assert.equal(directivaRutSinCorreo("18435922-3", conPrecio), "")
  })
  test("no confunde cantidades con RUT", () => {
    assert.equal(traeRutValido("somos 18 personas en 2 sedes"), false)
  })
  test("detecta el correo del turno", () => {
    assert.equal(clienteDioCorreo("ahi va: a@b.cl", []), true)
  })
})

// Caso Rodrigo MX (24-sep): Vicky pidió "RFC · razón social · tu email", él
// mandó solo el RFC y Vicky volvió a pedir razón social Y email. El correo no
// hace falta para emitir: jamás se vuelve a pedir (regla global).
const rodrigoMX = [
  { role: "user", content: "Ro, 18" },
  { role: "user", content: "promotores de retail" },
  { role: "user", content: "Queretaro" },
  {
    role: "assistant",
    content: "1 - Para 18 personas te recomiendo Reloj checador en renta + App:\n💰 $1,894 + IVA al mes.\n\n2.- Una alternativa más económica sería si marcan solo mediante nuestra app: $1,494 + IVA al mes.",
  },
  { role: "user", content: "la 2" },
  { role: "assistant", content: "Perfecto! Para armar la cotización formal me falta solo esto:\n• RFC de la empresa\n• Razón social\n• Tu email" },
]

describe("el correo no se vuelve a pedir (global, caso Rodrigo MX)", () => {
  test("MX: con el RFC y sin razón social, emite igual a nombre del contacto (02-oct)", () => {
    const d = directivaRutSinCorreo("BIM011108DJ5", rodrigoMX, { documento: "RFC" })
    assert.match(d, /Llama generar_link_cotizadora AHORA/)
    assert.match(d, /nombre del contacto/)
    assert.doesNotMatch(d, /ÚNICA pregunta/)
    assert.match(d, /PROHIBIDO volver a pedirlo/)
  })
  test("MX: el turno siguiente (razón social) emite sin correo", () => {
    const h = [...rodrigoMX, { role: "user", content: "BIM011108DJ5" }, { role: "assistant", content: "Me confirmas la razón social de la empresa?" }]
    assert.match(directivaRutSinCorreo("Grupo Bimbo SA de CV", h, { documento: "RFC" }), /OMITIENDO `contactoEmail`/)
  })
  test("Chile: RUT en un mensaje anterior, el siguiente tampoco pide correo", () => {
    const h = [...conPrecio, { role: "user", content: "18435922-7" }, { role: "assistant", content: "Y tu email?" }]
    assert.match(directivaRutSinCorreo("para qué lo necesitas?", h), /YA te entregó el RUT en un mensaje anterior/)
  })
  test("Colombia: el NIT también gatilla", () => {
    const h = [{ role: "user", content: "somos 9" }, { role: "assistant", content: "$315.000 al mes" }]
    assert.match(directivaRutSinCorreo("nit 900123456-8", h, { documento: "NIT" }), /OMITIENDO/)
  })
  test("con la formal ya emitida no dispara", () => {
    const h = [...rodrigoMX, { role: "user", content: "BIM011108DJ5 Grupo Bimbo" }, { role: "assistant", content: "Lista tu cotización! https://cotizacion.geovictoria.com/q/abc" }]
    assert.equal(directivaRutSinCorreo("gracias", h, { documento: "RFC" }), "")
  })
  test("si el cliente dio correo, no dispara", () => {
    assert.equal(directivaRutSinCorreo("BIM011108DJ5 ro@bimbo.mx", rodrigoMX, { documento: "RFC" }), "")
  })
})

describe("México: a nombre de quién va, sin correo → emite (02-oct)", () => {
  const h = [
    { role: "user", content: "Soy Antonio, somos 8 en un hotel, solo app" },
    {
      role: "assistant",
      content:
        "Resumen mensual recurrente:\n\n- Control de Asistencia: $499/mes\n\nTotal mensual: $499 + IVA\n\n[---]\n\nPara armar la cotización formal me falta solo esto:\n• A nombre de quién va (tu empresa o tú)\n• Tu email",
    },
  ]
  test("responde el nombre sin correo → directiva de emitir", () => {
    const d = directivaNombreSinCorreo("Hotel Las Palmas, mándamela", h)
    assert.match(d, /Llama generar_link_cotizadora AHORA/)
    assert.match(d, /NO pidas el RFC/)
  })
  test("con correo, pregunta o rechazo → nada", () => {
    assert.equal(directivaNombreSinCorreo("Hotel Las Palmas, ana@palmas.mx", h), "")
    assert.equal(directivaNombreSinCorreo("¿y eso incluye la app?", h), "")
    assert.equal(directivaNombreSinCorreo("no gracias", h), "")
  })
  test("solo en México: directivasDeTurno con RUT no la agrega", async () => {
    const { directivasDeTurno } = await import("../lib/directivas-turno.ts")
    assert.doesNotMatch(directivasDeTurno("Hotel Las Palmas", h, { zona: "comuna", documento: "RUT" }), /a nombre de quién va la cotización y el cliente/)
    assert.match(directivasDeTurno("Hotel Las Palmas", h, { zona: "ciudad", documento: "RFC" }), /a nombre de quién va la cotización y el cliente/)
  })
})
