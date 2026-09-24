import { test } from "node:test"
import assert from "node:assert/strict"
import { blindarSoporteInventadoPais } from "../lib/paises/blindaje-soporte.ts"
test("blindaje único de soporte: tarjeta MX y lista blanca de la ficha", async () => {
  const r = await blindarSoporteInventadoPais("mx", "Escribe a ayuda@geovictoria.com o al 600 914 3819; tu ejecutiva lmedina@geovictoria.com; admin juan@geovictoria.com", new Set(["juan@geovictoria.com"]))
  assert.ok(r.includes("soportemx@geovictoria.com") && r.includes("+52 33 4160 5435") && r.includes("lmedina@") && r.includes("juan@"))
})
