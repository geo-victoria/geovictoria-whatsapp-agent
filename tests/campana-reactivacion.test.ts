import test from "node:test"
import assert from "node:assert/strict"
import {
  canalDelDia,
  casillaAbierta,
  debeDescansar,
  ganchoParaToque2,
  planDeToque,
  precioTextoClp,
  siguienteCasilla,
  DESCANSO_DIAS,
} from "../lib/campana-reactivacion-reglas.ts"

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

test("inactividad: 2 días hábiles = 18 h de 9 a 18, L-V sin feriados (Lalo 10-sep)", async () => {
  const { minutosHabilesEntre } = await import("../lib/ptv.ts")
  const { MINUTOS_HABILES_INACTIVIDAD, HORA_INICIO_CAMPANA } = await import("../lib/campana-reactivacion-reglas.ts")
  assert.equal(MINUTOS_HABILES_INACTIVIDAD, 1080)
  // Viernes 11-sep 11:00 CL (14:00Z) → martes 15-sep 11:00 CL: vie 7 h + lun 9 h + mar 2 h = 18 h.
  const min = minutosHabilesEntre(new Date("2026-09-11T14:00:00Z"), new Date("2026-09-15T14:00:00Z"), "cl", new Set(), HORA_INICIO_CAMPANA)
  assert.equal(min, 1080)
  // La hora 8-9 NO cuenta para la campaña (sí para el reloj de traspaso).
  const m8 = minutosHabilesEntre(new Date("2026-09-14T11:00:00Z"), new Date("2026-09-14T12:00:00Z"), "cl", new Set(), HORA_INICIO_CAMPANA)
  assert.equal(m8, 0)
  assert.equal(minutosHabilesEntre(new Date("2026-09-14T11:00:00Z"), new Date("2026-09-14T12:00:00Z"), "cl"), 60)
  // Feriado 18-sep: viernes entero congelado → jueves 17 11:00 a martes 22 11:00 = jue 7 + lun 9 + mar 2 = 18 h.
  const fer = new Set(["2026-09-18"])
  const mf = minutosHabilesEntre(new Date("2026-09-17T14:00:00Z"), new Date("2026-09-22T14:00:00Z"), "cl", fer, HORA_INICIO_CAMPANA)
  assert.equal(mf, 1080)
})

// ── DESCANSO de 4 semanas (Lalo 10-sep) ─────────────────────────────────────

test("descanso: sin toque previo entra al tiro", () => {
  const r = debeDescansar(null, new Date("2026-09-11T14:00:00Z"))
  assert.equal(r.descansa, false)
  assert.equal(r.diasFaltan, 0)
})

test("descanso: un toque de hace 10 días espera 18 más", () => {
  const r = debeDescansar(new Date("2026-09-01T14:00:00Z"), new Date("2026-09-11T14:00:00Z"))
  assert.equal(r.descansa, true)
  assert.equal(r.diasDesde, 10)
  assert.equal(r.diasFaltan, DESCANSO_DIAS - 10)
})

test("descanso: a los 28 días justos ya puede salir", () => {
  const r = debeDescansar(new Date("2026-08-14T14:00:00Z"), new Date("2026-09-11T14:00:00Z"))
  assert.equal(r.descansa, false)
})

// ── Gancho de cada toque ────────────────────────────────────────────────────

test("planDeToque: cada casilla su plantilla y sus variables", () => {
  assert.deepEqual(planDeToque(1, true).vars, ["nombre"])
  assert.deepEqual(planDeToque(1, false).vars, [])
  assert.notEqual(planDeToque(1, true).tpl, planDeToque(1, false).tpl)
  assert.deepEqual(planDeToque(2, true).vars, ["nombre", "gancho", "empresa", "link"])
  assert.equal(planDeToque(3, true).tipo, "dcto")
  assert.deepEqual(planDeToque(4, true).vars, ["nombre", "empresa", "precio", "link"])
})

test("gancho del toque 2: usa la objeción cuando la hay y no inventa cuando no", () => {
  assert.match(ganchoParaToque2("precio"), /permanencia/i)
  assert.match(ganchoParaToque2("hardware"), /app/i)
  assert.match(ganchoParaToque2("legal"), /Dirección del Trabajo/i)
  assert.match(ganchoParaToque2(null), /mismo día|permanencia/i)
})

test("precio de la plantilla: formato chileno, vacío si no hay monto", () => {
  assert.equal(precioTextoClp(46175), "46.175")
  assert.equal(precioTextoClp(0), "")
  assert.equal(precioTextoClp(null), "")
})
