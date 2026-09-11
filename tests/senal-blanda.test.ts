/**
 * Señal blanda y su reconocimiento (Lalo 11-sep: "lo que duele es cuando
 * recibimos la señal pero seguimos hablando como si el cliente no hubiera
 * dicho nada"). Frases tomadas de los casos reales de la auditoría de
 * insistencia.
 */
import { test } from "node:test"
import assert from "node:assert"
import {
  detectarSenalBlanda,
  reconocimientoSenalBlanda,
  conReconocimiento,
} from "../lib/senal-blanda"

const cli = (t: string) => [{ role: "user", content: t }]

test("'lo revisamos y te comento' es señal blanda (el ejemplo de Lalo)", () => {
  const s = detectarSenalBlanda(cli("Lo revisamos y te comento"))
  assert.equal(s?.tipo, "te_confirmo")
})

test("'lo presentaré a la dirección' es revisión interna (caso Gonzalo / Los Álamos)", () => {
  assert.equal(detectarSenalBlanda(cli("lo presentare a la direccion"))?.tipo, "revision_interna")
  assert.equal(detectarSenalBlanda(cli("Lo presentaré a la dirección"))?.tipo, "revision_interna")
})

test("'lo veo con mi jefe' y 'lo estamos evaluando' también", () => {
  assert.equal(detectarSenalBlanda(cli("lo veo con mi jefe"))?.tipo, "revision_interna")
  assert.equal(detectarSenalBlanda(cli("Lo estamos evaluando con el equipo"))?.tipo, "revision_interna")
  assert.equal(detectarSenalBlanda(cli("queda en revisión"))?.tipo, "revision_interna")
})

test("'cualquier novedad le comento' (caso Gonzalo, 25-ago)", () => {
  assert.equal(detectarSenalBlanda(cli("muchas gracias hola, cualquier novedad le comento"))?.tipo, "te_confirmo")
})

test("'se lo enviaré a mi socia y le respondo'", () => {
  assert.ok(detectarSenalBlanda(cli("Se lo enviaré a mi socia y le respondo")))
})

test("'me tomaré más tiempo' y 'necesito unos días'", () => {
  assert.equal(detectarSenalBlanda(cli("me tomaré más tiempo"))?.tipo, "mas_tiempo")
  assert.equal(detectarSenalBlanda(cli("necesito unos días para decidir"))?.tipo, "mas_tiempo")
})

test("un mensaje normal NO es señal blanda", () => {
  assert.equal(detectarSenalBlanda(cli("Serían 5 personas")), null)
  assert.equal(detectarSenalBlanda(cli("cotízame la app por favor")), null)
  assert.equal(detectarSenalBlanda(cli("ya lo pagué")), null)
})

test("los [REGISTRO INTERNO] no cuentan como mensaje del cliente", () => {
  assert.equal(
    detectarSenalBlanda([{ role: "user", content: "[REGISTRO INTERNO] te confirmo algo" }]),
    null,
  )
})

test("la señal se busca en los últimos mensajes, no solo en el último", () => {
  const s = detectarSenalBlanda([
    { role: "user", content: "lo veo con mi jefe" },
    { role: "assistant", content: "perfecto" },
    { role: "user", content: "gracias" },
  ])
  assert.equal(s?.tipo, "revision_interna")
})

test("el reconocimiento va ADELANTE y la pregunta original queda intacta", () => {
  const senal = detectarSenalBlanda(cli("lo revisamos y te comento"))
  const salida = conReconocimiento("¿Cómo te fue con Anderson?", senal)
  assert.ok(salida.startsWith("Quedaste en comentarme"))
  assert.ok(salida.includes("¿Cómo te fue con Anderson?"))
})

test("sin señal el texto no se toca", () => {
  assert.equal(conReconocimiento("¿Cómo te fue con Anderson?", null), "¿Cómo te fue con Anderson?")
  assert.equal(reconocimientoSenalBlanda(null), "")
})
