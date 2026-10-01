import { test } from "node:test"
import assert from "node:assert/strict"
import { eleccionNumericaConReloj } from "../lib/eleccion-marcaje.ts"

const MENU = "Para un equipo que trabaja junto:\n\n1. App móvil — sin costo adicional.\n\n2. Reloj control físico — con costo de arriendo mensual.\n\nCuál te acomoda más?"
const DOBLE = "Te dejo las dos opciones:\n\n1 - Con Reloj en arriendo (Castro):\n- Plan mensual: $53.744\n\n2 - Una alternativa más económica sería si marcan solo mediante nuestra app: $53.744\n\nQué opción prefieres?"

test("caso Disco Sur: '2' al menú y '1' al doble valor = reloj", () => {
  const h = [
    { role: "assistant", content: MENU }, { role: "user", content: "2" },
    { role: "assistant", content: "En qué comuna?" }, { role: "user", content: "Castro" },
    { role: "assistant", content: DOBLE }, { role: "user", content: "1" },
    { role: "assistant", content: "Me falta RUT y email" }, { role: "user", content: "77.605.159-4\ncris@x.cl" },
  ]
  assert.equal(eleccionNumericaConReloj(h), true)
})

test("'2' frente al doble valor = sin reloj", () => {
  assert.equal(eleccionNumericaConReloj([{ role: "assistant", content: DOBLE }, { role: "user", content: "la 2" }]), false)
})

test("'1' frente al menú = app, sin reloj", () => {
  assert.equal(eleccionNumericaConReloj([{ role: "assistant", content: MENU }, { role: "user", content: "1" }]), false)
})

test("sin respuesta numérica = null; texto explícito posterior manda", () => {
  assert.equal(eleccionNumericaConReloj([{ role: "user", content: "hola" }]), null)
  assert.equal(eleccionNumericaConReloj([
    { role: "assistant", content: DOBLE }, { role: "user", content: "1" },
    { role: "assistant", content: "ok" }, { role: "user", content: "mejor solo app" },
  ]), null)
})
