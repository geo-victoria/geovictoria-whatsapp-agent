import test from "node:test"
import assert from "node:assert/strict"
import { canalDelDia, casillaAbierta, siguienteCasilla } from "../lib/campana-reactivacion-reglas.ts"

test("siguienteCasilla: primera en falso, null tras la 4", () => {
  assert.equal(siguienteCasilla(null), 1)
  assert.equal(siguienteCasilla({ toque1_wsp_at: "2026-09-01T14:00:00Z" }), 2)
  assert.equal(siguienteCasilla({ toque1_wsp_at: "x", toque2_wsp_at: "x", toque3_wsp_at: "x" }), 4)
  assert.equal(siguienteCasilla({ toque1_wsp_at: "x", toque2_wsp_at: "x", toque3_wsp_at: "x", toque4_wsp_at: "x" }), null)
})

test("siguienteCasilla no se reinicia: el hueco manda aunque haya actividad", () => {
  // Toque 2 salió hace 3 semanas, el cliente respondió, volvió a callar → sigue en la 3.
  assert.equal(siguienteCasilla({ toque1_wsp_at: "2026-08-18T14:00:00Z", toque2_wsp_at: "2026-08-25T14:00:00Z" }), 3)
})

test("casillaAbierta: la última con wsp dentro de la semana", () => {
  const ahora = new Date("2026-09-10T15:00:00Z") // jueves
  assert.equal(casillaAbierta({ toque1_wsp_at: "2026-09-08T14:00:00Z" }, ahora), 1)
  assert.equal(casillaAbierta({ toque1_wsp_at: "2026-09-01T14:00:00Z", toque2_wsp_at: "2026-09-08T14:00:00Z" }, ahora), 2)
  assert.equal(casillaAbierta({ toque1_wsp_at: "2026-09-01T14:00:00Z" }, ahora), null)
  assert.equal(casillaAbierta(null, ahora), null)
})

test("canalDelDia: martes wsp, miércoles mail, jueves call, resto null (hora CL)", () => {
  assert.equal(canalDelDia("cl", new Date("2026-09-08T15:00:00Z")), "wsp")
  assert.equal(canalDelDia("cl", new Date("2026-09-09T15:00:00Z")), "mail")
  assert.equal(canalDelDia("cl", new Date("2026-09-10T15:00:00Z")), "call")
  assert.equal(canalDelDia("cl", new Date("2026-09-11T15:00:00Z")), null)
  // Borde de zona: lunes 23:30 CL sigue siendo lunes aunque en UTC ya sea martes.
  assert.equal(canalDelDia("cl", new Date("2026-09-08T02:30:00Z")), null)
})
