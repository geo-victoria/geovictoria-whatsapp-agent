import { test } from "node:test"
import assert from "node:assert/strict"
import { fechaPagoDesdeMarcas, refecharVenta } from "../lib/fecha-pago-reglas.ts"

// Caso real 15-sep: Arquiglass COT1303 aceptada el 09-sep, pagada con tarjeta el 15.
const CAJA_ARQUIGLASS = JSON.stringify({
  empresa: "ARQUIGLASS SPA",
  numero: "COT1303",
  pagoIso: "2026-09-09T09:44:15-03:00",
  montoClp: 26758,
})

test("la marca pago_online_ de ESTA cotización da la fecha real", () => {
  const f = fechaPagoDesdeMarcas(
    { pagoOnline: JSON.stringify({ at: "2026-09-15T12:18:51.831Z", quoteId: "3525045000659607516" }) },
    "3525045000659607516",
  )
  assert.equal(f, "2026-09-15T12:18:51.831Z")
})

test("una marca de OTRA cotización del mismo teléfono no cuenta (caso Lorena, dos pagadas)", () => {
  const f = fechaPagoDesdeMarcas(
    { pagoOnline: JSON.stringify({ at: "2026-09-08T15:00:00Z", quoteId: "111" }) },
    "222",
  )
  assert.equal(f, null)
})

test("con tarjeta y comprobante de la misma cotización gana la más temprana", () => {
  const f = fechaPagoDesdeMarcas(
    {
      comprobante: JSON.stringify({ at: "2026-09-08T14:00:00Z", numero: "COT1274", quoteId: "999" }),
      pagoOnline: JSON.stringify({ at: "2026-09-10T14:00:00Z", quoteId: "999" }),
    },
    "999",
  )
  assert.equal(f, "2026-09-08T14:00:00Z")
})

test("marca ilegible o sin fecha → null, sin reventar", () => {
  assert.equal(fechaPagoDesdeMarcas({ pagoOnline: "no-json", comprobante: JSON.stringify({ quoteId: "1" }) }, "1"), null)
})

test("refecharVenta mueve pagoIso adelante y conserva la aceptación", () => {
  const out = refecharVenta(CAJA_ARQUIGLASS, "2026-09-15T09:18:36-03:00")
  assert.ok(out)
  const v = JSON.parse(out as string)
  assert.equal(v.pagoIso, "2026-09-15T09:18:36-03:00")
  assert.equal(v.pagoIsoAceptacion, "2026-09-09T09:44:15-03:00")
  assert.equal(v.montoClp, 26758)
})

test("refecharVenta no retrocede ni repite: misma fecha o anterior → null", () => {
  assert.equal(refecharVenta(CAJA_ARQUIGLASS, "2026-09-09T09:44:30-03:00"), null)
  assert.equal(refecharVenta(CAJA_ARQUIGLASS, "2026-09-01T09:00:00-03:00"), null)
  assert.equal(refecharVenta("{{", "2026-09-15T09:18:36-03:00"), null)
})

test("una segunda re-fecha conserva la aceptación ORIGINAL", () => {
  const una = refecharVenta(CAJA_ARQUIGLASS, "2026-09-15T09:18:36-03:00") as string
  const dos = refecharVenta(una, "2026-09-16T10:00:00-03:00") as string
  assert.equal(JSON.parse(dos).pagoIsoAceptacion, "2026-09-09T09:44:15-03:00")
})
