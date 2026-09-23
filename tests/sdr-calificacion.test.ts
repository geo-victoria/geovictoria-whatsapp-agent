import test from "node:test"
import assert from "node:assert/strict"
import { destinoTrasCalificar, esSdrCalificacionCL, rosterSdrPorTerritorio } from "../lib/sdr-calificacion.ts"

const ALEYDIS = "3525045000583802005"
const ARACELLI = "3525045000594735052"

test("esSdrCalificacionCL reconoce a las dos por id y por correo", () => {
  assert.equal(esSdrCalificacionCL({ ownerId: ALEYDIS }), true)
  assert.equal(esSdrCalificacionCL({ ownerId: ARACELLI }), true)
  assert.equal(esSdrCalificacionCL({ ownerEmail: "AAraque@geovictoria.com" }), true)
  // Ejecutivos: su cartera se respeta como siempre.
  assert.equal(esSdrCalificacionCL({ ownerId: "3525045000000211283" }), false)
  assert.equal(esSdrCalificacionCL({ ownerEmail: "tmartinezq@geovictoria.com" }), false)
  assert.equal(esSdrCalificacionCL({}), false)
})

test("caso Cafetería: calificado con RUT en manos de la SDR → deal + tómbola", () => {
  assert.equal(
    destinoTrasCalificar({ territorio: "Chile", ownerId: ALEYDIS, calificado: true, rut: "77009088-1" }),
    "deal_tombola",
  )
})

test("caso Diego (40 app, sin RUT): calificado sin RUT → lead a TLMK", () => {
  assert.equal(
    destinoTrasCalificar({ territorio: "Chile", ownerId: ARACELLI, calificado: true, rut: "" }),
    "lead_tlmk",
  )
})

test("sin calificar se queda con la SDR: es exactamente su trabajo", () => {
  assert.equal(
    destinoTrasCalificar({ territorio: "Chile", ownerId: ALEYDIS, calificado: false, rut: "77009088-1" }),
    "sin_cambio",
  )
})

test("venta autónoma de Aleydis: jamás se re-sortea", () => {
  // Por hito post-pago…
  assert.equal(
    destinoTrasCalificar({ territorio: "Chile", ownerId: ALEYDIS, calificado: true, rut: "1-9", hito: "aceptada" }),
    "sin_cambio",
  )
  assert.equal(
    destinoTrasCalificar({ territorio: "Chile", ownerId: ALEYDIS, calificado: true, rut: "1-9", hito: "onboarding_listo" }),
    "sin_cambio",
  )
  // …y por venta ya cerrada (deal en 6/7/8 o pago registrado).
  assert.equal(
    destinoTrasCalificar({ territorio: "Chile", ownerId: ALEYDIS, calificado: true, rut: "1-9", ventaCerrada: true }),
    "sin_cambio",
  )
})

test("la cartera de un ejecutivo y los otros países no se tocan", () => {
  assert.equal(
    destinoTrasCalificar({ territorio: "Chile", ownerId: "3525045000223766001", calificado: true, rut: "1-9" }),
    "sin_cambio",
  )
  assert.equal(
    destinoTrasCalificar({ territorio: "Colombia", ownerId: ALEYDIS, calificado: true, rut: "1-9" }),
    "sin_cambio",
  )
})

// ── ASIGNACIÓN FRESCA (11-sep, caso MSS Asesores / Diego Cubillos) ──────────
// El daño que reclamó Victoria: dos deals del mismo cliente pasaron por la
// conciliación en el mismo minuto, la tómbola sorteó DOS veces y quedaron dos
// ejecutivos avisados llamando al mismo cliente. Un dueño recién sorteado no
// es una brecha: es el reparto funcionando.
test("asignacionFresca: el owner_assigned de la regla cuenta aunque no traiga field_history", async () => {
  const { asignacionFresca } = await import("../lib/owner-manual.ts")
  const ahora = Date.parse("2026-09-10T14:53:59-03:00")
  const eventos = [{ action: "owner_assigned", audited_time: "2026-09-10T14:48:42-03:00", done_by: { id: "3525045000484500876" } }]
  const r = asignacionFresca(eventos, ahora, 120)
  assert.equal(r.fresca, true)
  assert.equal(r.at, "2026-09-10T14:48:42-03:00")
})

test("asignacionFresca: una asignación vieja NO frena la conciliación", async () => {
  const { asignacionFresca } = await import("../lib/owner-manual.ts")
  const ahora = Date.parse("2026-09-10T14:53:59-03:00")
  const eventos = [
    { action: "updated", audited_time: "2026-08-31T10:00:00-03:00", field_history: [{ api_name: "Owner", _value: { old: "Vicky", new: "Aleydis Araque" } }] },
  ]
  assert.equal(asignacionFresca(eventos, ahora, 120).fresca, false)
})

test("asignacionFresca: sin eventos de asignación no hay freno", async () => {
  const { asignacionFresca } = await import("../lib/owner-manual.ts")
  assert.equal(asignacionFresca([{ action: "added", audited_time: "2026-09-10T14:00:00-03:00" }], Date.now(), 120).fresca, false)
})

test("asignacionFresca: ventana en cero o inválida nunca frena", async () => {
  const { asignacionFresca } = await import("../lib/owner-manual.ts")
  const eventos = [{ action: "owner_assigned", audited_time: new Date().toISOString() }]
  assert.equal(asignacionFresca(eventos, Date.now(), 0).fresca, false)
  assert.equal(asignacionFresca(eventos, Date.now(), Number.NaN).fresca, false)
})

// ── PERÚ (22-sep): las SDR peruanas entran a la misma regla ──────────────
test("Perú: SDR peruana con caso calificado y RUC → deal_tombola; sin RUC → lead_tlmk", () => {
  const ANA = "3525045000299130001"
  assert.equal(
    destinoTrasCalificar({ territorio: "Perú", ownerId: ANA, calificado: true, rut: "20605842055" }),
    "deal_tombola",
  )
  assert.equal(
    destinoTrasCalificar({ territorio: "Perú", ownerEmail: "pquispef@geovictoria.com", calificado: true }),
    "lead_tlmk",
  )
})

test("Perú: SDR peruana sin calificar, o Mónica (telemarketing), o SDR chilena en territorio Perú → sin_cambio", () => {
  assert.equal(destinoTrasCalificar({ territorio: "Perú", ownerId: "3525045000299130001", calificado: false }), "sin_cambio")
  assert.equal(destinoTrasCalificar({ territorio: "Perú", ownerEmail: "mmendozav@geovictoria.com", calificado: true, rut: "20605842055" }), "sin_cambio")
  assert.equal(destinoTrasCalificar({ territorio: "Perú", ownerId: ALEYDIS, calificado: true, rut: "20605842055" }), "sin_cambio")
})

test("rosterSdrPorTerritorio: Chile y Perú tienen roster; Colombia solo con el interruptor (encendido desde el 23-sep); México no", () => {
  assert.equal(rosterSdrPorTerritorio("Chile").length, 2)
  assert.equal(rosterSdrPorTerritorio(null).length, 2)
  assert.equal(rosterSdrPorTerritorio("Perú").length, 2)
  assert.equal(rosterSdrPorTerritorio("Colombia").length, 3)
  assert.equal(rosterSdrPorTerritorio("México").length, 0)
})

// COLOMBIA (Lalo 23-sep): las SDR son Sanabria Torres, Nariño Chavarro y
// Galindo, pero solo cuentan como "SDR de calificación" con el interruptor
// `tombolaZohoCoActiva` encendido; apagado rige la regla del 05-ago (el
// primero se lo queda) y no hay re-entrega.
test("Colombia: sin interruptor no hay roster SDR; con interruptor son los tres de la ficha", () => {
  const prev = process.env.VICKY_TOMBOLA_ZOHO_CO
  try {
    process.env.VICKY_TOMBOLA_ZOHO_CO = "off"
    assert.deepEqual(rosterSdrPorTerritorio("Colombia"), [])
    assert.equal(destinoTrasCalificar({ territorio: "Colombia", ownerEmail: "egalindo@geovictoria.com", calificado: true, rut: "" }), "sin_cambio")
    process.env.VICKY_TOMBOLA_ZOHO_CO = "on"
    const r = rosterSdrPorTerritorio("Colombia")
    assert.deepEqual(r.map((x) => x.email).sort(), ["egalindo@geovictoria.com", "jnarinoch@geovictoria.com", "msanabriat@geovictoria.com"])
    assert.equal(destinoTrasCalificar({ territorio: "Colombia", ownerEmail: "msanabriat@geovictoria.com", calificado: true, rut: "" }), "lead_tlmk")
    assert.equal(destinoTrasCalificar({ territorio: "Colombia", ownerEmail: "jnarinoch@geovictoria.com", calificado: true, rut: "901367959-1" }), "deal_tombola")
    // Un telemarketero colombiano no es SDR: su cartera se respeta.
    assert.equal(destinoTrasCalificar({ territorio: "Colombia", ownerEmail: "mcorredor@geovictoria.com", calificado: true, rut: "901367959-1" }), "sin_cambio")
  } finally {
    if (prev === undefined) delete process.env.VICKY_TOMBOLA_ZOHO_CO
    else process.env.VICKY_TOMBOLA_ZOHO_CO = prev
  }
})
