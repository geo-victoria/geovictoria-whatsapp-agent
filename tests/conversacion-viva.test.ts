/**
 * Casos REALES medidos el 14-sep sobre los 279 toques de 14 días.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { conversacionViva, VENTANA_VIVA_MIN } from "../lib/conversacion-viva.ts"

const t = (min: number) => new Date(Date.UTC(2026, 8, 14, 14, 0, 0) - min * 60000).toISOString()
const AHORA = Date.UTC(2026, 8, 14, 14, 0, 0)

test("Luis Rivano: 11 minutos y 3 mensajes suyos — está conversando", () => {
  const v = conversacionViva(
    [
      { role: "user", at: t(50), content: "Hola, quisiera saber del servicio" },
      { role: "assistant", at: t(49), content: "..." },
      { role: "user", at: t(47), content: "Es para un centro cultural, menos de 5 personas" },
      { role: "assistant", at: t(46), content: "¿Con quién tengo el gusto?" },
      { role: "user", at: t(11), content: "Luis Rivano" },
      { role: "assistant", at: t(11), content: "¿Cómo trabaja tu equipo?" },
    ],
    AHORA,
  )
  assert.equal(v.viva, true)
  assert.equal(v.mensajesCliente, 3)
  assert.ok(v.reintentarEnMs && v.reintentarEnMs > AHORA, "se pospone hacia adelante")
})

test("escribió una vez y se fue: ESE es el caso del toque de 10 minutos", () => {
  const v = conversacionViva(
    [
      { role: "user", at: t(11), content: "Hola, quiero cotizar" },
      { role: "assistant", at: t(11), content: "¿Cuántas personas marcarían?" },
    ],
    AHORA,
  )
  assert.equal(v.viva, false)
  assert.equal(v.reintentarEnMs, null)
})

test("conversó pero se enfrió: el toque sale", () => {
  const v = conversacionViva(
    [
      { role: "user", at: t(200), content: "Hola" },
      { role: "user", at: t(VENTANA_VIVA_MIN + 5), content: "Somos 8" },
      { role: "assistant", at: t(VENTANA_VIVA_MIN + 4), content: "..." },
    ],
    AHORA,
  )
  assert.equal(v.viva, false)
})

test("sin mensajes del cliente no hay conversación viva", () => {
  assert.equal(conversacionViva([{ role: "assistant", at: t(2) }], AHORA).viva, false)
  assert.equal(conversacionViva([], AHORA).viva, false)
})

test("mensajes sin fecha no rompen nada", () => {
  const v = conversacionViva([{ role: "user" }, { role: "user" }], AHORA)
  assert.equal(v.viva, false)
})
