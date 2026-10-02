import { test } from "node:test"
import assert from "node:assert/strict"
import { marcaVigente } from "../lib/campana-externa.ts"

test("campaña externa: vigente, vencida, vacía e ilegible", () => {
  const ahora = Date.parse("2026-10-02T12:00:00Z")
  const ok = JSON.stringify({ campana: "acrip", agente: "mgomez@geovictoria.com", hasta: "2026-11-01T00:00:00Z", at: "x" })
  assert.equal(marcaVigente(ok, ahora)?.agente, "mgomez@geovictoria.com")
  assert.equal(marcaVigente(JSON.stringify({ campana: "acrip", agente: "a@b", hasta: "2026-10-01T00:00:00Z" }), ahora), null)
  assert.equal(marcaVigente("", ahora), null)
  assert.equal(marcaVigente("no json", ahora), null)
  assert.equal(marcaVigente(JSON.stringify({ campana: "acrip", hasta: "2026-11-01T00:00:00Z" }), ahora), null)
})

test("marcaVigente conserva la línea de la campaña", async () => {
  const { marcaVigente } = await import("../lib/campana-externa.ts")
  const m = marcaVigente(
    JSON.stringify({ campana: "x", agente: "a@b.c", hasta: "2099-01-01T00:00:00Z", linea: "+57 318 107 0737" }),
    Date.now(),
  )
  if (m?.linea !== "573181070737") throw new Error(`linea: ${m?.linea}`)
})
