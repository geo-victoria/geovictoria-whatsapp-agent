import { test } from "node:test"
import assert from "node:assert/strict"
import { parsearFichaRues } from "../lib/paises/co/rues-nit.ts"

// Filas reales del dataset c82u-588k para el NIT 860002693 (3M Colombia):
// tres cámaras, una ACTIVA en Bogotá — esa manda.
const FILAS = [
  { camara_comercio: "BARRANQUILLA", razon_social: "3M COLOMBIA S.A.", clase_identificacion: "NIT", numero_identificacion: "860002693", digito_verificacion: "3", estado_matricula: "CANCELADA", codigo_categoria_matricula: "00", ultimo_ano_renovado: "2011", fecha_actualizacion: "2020/06/10" },
  { camara_comercio: "CALI", razon_social: "3M COLOMBIA S A", clase_identificacion: "NIT", numero_identificacion: "860002693", digito_verificacion: "3", estado_matricula: "NO ASIGNADO", codigo_categoria_matricula: "00", ultimo_ano_renovado: "1994", fecha_actualizacion: "1900/01/01" },
  { camara_comercio: "BOGOTA", razon_social: "3M COLOMBIA S A", clase_identificacion: "NIT", numero_identificacion: "860002693", digito_verificacion: "3", estado_matricula: "ACTIVA", codigo_categoria_matricula: "01", ultimo_ano_renovado: "2026", cod_ciiu_act_econ_pri: "4669", organizacion_juridica: "SOCIEDAD ANONIMA", fecha_actualizacion: "2026/06/25" },
]

test("RUES: elige la matrícula ACTIVA de categoría principal y trae razón social + DV", () => {
  const f = parsearFichaRues("860002693", FILAS)
  assert.ok(f)
  assert.equal(f.razonSocial, "3M COLOMBIA S A")
  assert.equal(f.camara, "BOGOTA")
  assert.equal(f.dv, "3")
  assert.equal(f.estado, "ACTIVA")
  assert.equal(f.organizacionJuridica, "SOCIEDAD ANONIMA")
})

test("RUES: sin filas del NIT (o con cédulas de otro número) devuelve null", () => {
  assert.equal(parsearFichaRues("900123456", []), null)
  assert.equal(parsearFichaRues("900123456", [{ clase_identificacion: "CEDULA DE CIUDADANIA", numero_identificacion: "900123456", razon_social: "X" }]), null)
})

test("RUES: sin ninguna activa, la CANCELADA se penaliza y gana la otra; la razón social sale igual", () => {
  const f = parsearFichaRues("860002693", FILAS.slice(0, 2))
  assert.ok(f)
  assert.equal(f.camara, "CALI")
  assert.match(f.razonSocial, /3M COLOMBIA/)
})
