import { test } from "node:test"
import assert from "node:assert/strict"
import { nombreDealVicky } from "../lib/nombre-deal.ts"

test("Chile conserva el formato con paréntesis", () => {
  assert.equal(nombreDealVicky("Chile", "Legacy Capital Group SpA", { documento: "77202964-0" }), "Legacy Capital Group SpA (Control de Asistencia)")
})

test("Perú: RUC - razón - sufijo, sin duplicar el RUC que ya venía en la razón", () => {
  assert.equal(
    nombreDealVicky("Perú", "20543160891 - CONSTRUCTORA UNIMET S.A.C.", { documento: "20543160891" }),
    "20543160891 - CONSTRUCTORA UNIMET S.A.C. - Control de Asistencia",
  )
  assert.equal(nombreDealVicky("Perú", "FBK PERU SAC", { documento: "20511013080" }), "20511013080 - FBK PERU SAC - Control de Asistencia")
})

test("Perú sin RUC conocido: razón - sufijo (el RUC llega después)", () => {
  assert.equal(nombreDealVicky("Perú", "Prospecto WhatsApp"), "Prospecto WhatsApp - Control de Asistencia")
})

test("Perú: un sufijo heredado entre paréntesis se normaliza", () => {
  assert.equal(
    nombreDealVicky("Perú", "20508306831 - WORLD MOTORS SAC (Control de Asistencia)", { documento: "20508306831" }),
    "20508306831 - WORLD MOTORS SAC - Control de Asistencia",
  )
})
