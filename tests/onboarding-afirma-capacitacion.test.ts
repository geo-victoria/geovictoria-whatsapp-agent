import { test } from "node:test"
import assert from "node:assert/strict"
import { afirmaCapacitacionAgendada } from "../lib/onboarding/afirma-capacitacion.ts"

test("caso TESLA AUSTRAL 23-sep: confirmación con día, hora y relator sin la palabra agendada", () => {
  assert.equal(
    afirmaCapacitacionAgendada(
      "Perfecto Miguel, te confirmo por este chat: martes 29 de septiembre a las 09:15 AM con Diego Alegre. Ya le avisé a Diego Alegre, tu implementador, para que te contacte hoy y lo resuelvan juntos.",
    ),
    true,
  )
})

test("las formas del 05-sep siguen atrapadas", () => {
  assert.equal(afirmaCapacitacionAgendada("Listo, tu capacitación quedó agendada para el lunes 8 de septiembre a las 08:30."), true)
  assert.equal(afirmaCapacitacionAgendada("Ya te la agendé: la capacitación es el miércoles."), true)
  assert.equal(afirmaCapacitacionAgendada("Quedamos el jueves 2 de octubre a las 10:00 con Ignacio, te llega la invitación."), true)
})

test("ofrecer cupos o pedir confirmación NO es afirmar agenda", () => {
  assert.equal(
    afirmaCapacitacionAgendada("Tu relator Diego Alegre tiene estos horarios disponibles:\nMartes, 29 de septiembre\n• 09:15 AM\n• 04:30 PM\nCuál te acomoda mejor?"),
    false,
  )
  assert.equal(afirmaCapacitacionAgendada("Te confirmo la hora por este chat en un momento; no necesitas hacer nada."), false)
  assert.equal(afirmaCapacitacionAgendada("La hora que elegiste todavía NO quedó tomada en la agenda."), false)
  assert.equal(afirmaCapacitacionAgendada("Qué bueno, Miguel! Ya tienes harto avanzado."), false)
})
