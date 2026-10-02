import { test } from "node:test"
import assert from "node:assert/strict"
import { camposUrgenciaAlEntregar } from "../lib/urgencia-pendientes.ts"

const ahora = new Date("2026-10-02T17:20:00Z") // 14:20 Chile, 12:20 Lima (caso Robin)

test("tarea que vencía el lunes queda para hoy", () => {
  assert.deepEqual(camposUrgenciaAlEntregar("Tasks", { Due_Date: "2026-10-05" }, { ahora }), { Due_Date: "2026-10-02" })
  assert.deepEqual(camposUrgenciaAlEntregar("Tasks", { Due_Date: "2026-10-05" }, { ahora, tz: "America/Lima" }), { Due_Date: "2026-10-02" })
})

test("tarea ya vencida conserva su fecha (sigue viéndose atrasada)", () => {
  assert.deepEqual(camposUrgenciaAlEntregar("Tasks", { Due_Date: "2026-09-30" }, { ahora }), {})
})

test("llamada vencida o sin hora pasa a 15 minutos; una futura no se toca", () => {
  assert.deepEqual(camposUrgenciaAlEntregar("Calls", { Call_Start_Time: "2026-10-02T13:10:00-03:00" }, { ahora }), {
    Call_Start_Time: "2026-10-02T17:35:00+00:00",
  })
  assert.deepEqual(camposUrgenciaAlEntregar("Calls", {}, { ahora }), { Call_Start_Time: "2026-10-02T17:35:00+00:00" })
  assert.deepEqual(camposUrgenciaAlEntregar("Calls", { Call_Start_Time: "2026-10-03T10:00:00-03:00" }, { ahora }), {})
})
