/**
 * El cinturón de la certificación de la DT (14-sep). Los dos casos reales que
 * lo motivaron son tests: Dubraska (+56973921898, 14-sep) preguntando si el
 * sistema está "vinculado con DT", y Soledad / Comercial Zero (02-sep), donde
 * Vicky ofreció el documento tres veces y nunca lo mandó.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  preguntaPorCertificacionDT,
  respuestaTraeCertificacion,
  conCertificacionSiFalta,
  CERTIFICACION_DT_URL,
} from "../lib/certificacion-dt.ts"

test("reconoce la pregunta por la autorización de la DT", () => {
  for (const f of [
    "este sistema esta vinculado con DT ? lo q hagan horas extras se refleja en la dt ?",
    "¿Están autorizados por la Dirección del Trabajo?",
    "tienen la certificación?",
    "¿esto cumple con la normativa de control de asistencia?",
    "me pueden enviar el documento de la DT?",
    "sirve ante una fiscalización de la Inspección del Trabajo?",
    "necesito el dictamen que lo respalda",
  ]) assert.equal(preguntaPorCertificacionDT(f), true, f)
})

test("no confunde otras preguntas con la certificación", () => {
  for (const f of [
    "cuánto vale para 10 personas?",
    "cómo marcan desde el celular?",
    "¿el reloj necesita internet?",
    "en qué comuna hacen la instalación?",
    "quiero la cotización formal",
    "somos 8 pero pueden ser 10 a futuro",
  ]) assert.equal(preguntaPorCertificacionDT(f), false, f)
})

test("una respuesta que ya trae el documento no se toca", () => {
  const reply = `Sí, estamos autorizados. Te dejo el documento: ${CERTIFICACION_DT_URL}`
  assert.equal(respuestaTraeCertificacion(reply), true)
  const r = conCertificacionSiFalta("¿están autorizados por la DT?", reply)
  assert.equal(r.anexado, false)
  assert.equal(r.texto, reply)
})

test("el caso Dubraska: la respuesta era correcta pero llegaba sin el documento", () => {
  const cliente = "este sistema esta vinculado con DT ? lo q hagan horas extras se refleja en la dt ?"
  const reply =
    "Sí, GeoVictoria está autorizado por la Dirección del Trabajo (cumple la Resolución Exenta N°38) " +
    "— es un registro válido ante fiscalización."
  const r = conCertificacionSiFalta(cliente, reply)
  assert.equal(r.anexado, true)
  assert.ok(r.texto.startsWith(reply), "el texto del modelo se conserva entero")
  assert.ok(r.texto.includes(CERTIFICACION_DT_URL), "y queda el link oficial")
})

test("el caso Soledad: prometer el envío sin mandarlo tampoco pasa", () => {
  const r = conCertificacionSiFalta(
    "me puedes enviar el certificado de la Dirección del Trabajo?",
    "Claro, te hago llegar el documento de la DT en un momento 😊",
  )
  assert.equal(r.anexado, true)
  assert.ok(r.texto.includes(CERTIFICACION_DT_URL))
})

test("sin pregunta del cliente no se anexa nada", () => {
  const reply = "Para 10 personas son 0,95 UF + IVA al mes."
  const r = conCertificacionSiFalta("y cuánto sale para 10?", reply)
  assert.equal(r.anexado, false)
  assert.equal(r.texto, reply)
})

test("respuesta vacía no se inventa", () => {
  const r = conCertificacionSiFalta("¿están autorizados por la DT?", "")
  assert.equal(r.anexado, false)
})
