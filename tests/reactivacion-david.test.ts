import { test } from "node:test"
import assert from "node:assert/strict"
import { planReactivacionDavid, ETAPA_PROPUESTA, ETAPA_LISTO_CIERRE } from "../lib/crm-hitos.ts"

const ahora = new Date("2026-09-08T15:00:00Z")

test("no toca deals que no están en Cierre Perdido", () => {
  assert.equal(planReactivacionDavid({ Stage: "4. Propuesta Enviada / En Negociación", Fecha_paso_a_Cierre_Perdido: null }, ahora), null)
})

test("regla 1: perdido hace <3 meses vuelve a Propuesta y limpia razón + fecha de pérdida", () => {
  const p = planReactivacionDavid({ Stage: "Cierre Perdido", Fecha_paso_a_Cierre_Perdido: "2026-08-19T14:54:00-04:00" }, ahora)!
  assert.equal(p.regla, 1)
  assert.equal(p.etapa, ETAPA_PROPUESTA)
  assert.deepEqual(p.campos, { Raz_n_de_P_rdida: null, Fecha_paso_a_Cierre_Perdido: null })
})

test("regla 1: si alcanzó Listo para Cierre, vuelve ahí", () => {
  const p = planReactivacionDavid({ Stage: "Cierre Perdido", Fecha_paso_a_Cierre_Perdido: "2026-08-01T10:00:00-04:00", Fecha_paso_a_Listo_para_cierre_v2: "2026-07-20T10:00:00-04:00" }, ahora)!
  assert.equal(p.etapa, ETAPA_LISTO_CIERRE)
})

test("regla 2: perdido hace ≥3 meses → Propuesta con fecha nueva y fechas de piloto/cierre limpias", () => {
  const p = planReactivacionDavid({ Stage: "Cierre Perdido", Fecha_paso_a_Cierre_Perdido: "2026-06-03T09:03:00-04:00", Fecha_paso_a_Listo_para_cierre_v2: "2026-05-30T10:00:00-04:00" }, ahora)!
  assert.equal(p.regla, 2)
  assert.equal(p.etapa, ETAPA_PROPUESTA)
  assert.equal(p.campos.Fecha_paso_a_Piloto, null)
  assert.equal(p.campos.Fecha_paso_a_Listo_para_cierre_v2, null)
  assert.equal(p.campos.Fecha_Hora_Env_o_Propuesta, "2026-09-08T15:00:00+00:00")
})

test("sin fecha de pérdida se trata como antiguo (regla 2)", () => {
  assert.equal(planReactivacionDavid({ Stage: "Cierre Perdido" }, ahora)!.regla, 2)
})
