import { test } from "node:test"
import assert from "node:assert/strict"
import { clienteReclamaContacto } from "../lib/reclamo-contacto.ts"

test("reclamos reales de clientes traspasados (Robin 02-oct, ITV, Molécula, Aura)", () => {
  for (const t of [
    "hasta el momento andie se comunco",
    "No me contactaron",
    "Aún no me llamó la persona",
    "Desde la mañana estoy esperando",
    "No responde",
    "nadie me ha llamado todavía",
    "sigo esperando la cotización",
  ]) assert.equal(clienteReclamaContacto(t), true, t)
})

test("no confunde mensajes normales con un reclamo", () => {
  for (const t of [
    "ok srta ojala se comuniquen pronto",
    "estaré atento",
    "si que me llame",
    "normal que me llame",
    "gracias, espero su propuesta",
  ]) assert.equal(clienteReclamaContacto(t), false, t)
})
