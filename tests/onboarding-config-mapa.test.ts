/** El mapa cerebro→wizard produce las formas EXACTAS del wizard (F2). */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { wizardFormDataDesdeConfiguracion, ID_TURNO_LIBRE } from "../lib/onboarding/config-mapa.ts"
import type { Configuracion } from "../lib/onboarding/configuracion.ts"

const CFG: Configuracion = {
  trabajadores: [
    { rut: "18371911-4", correo: "v@gmail.com", nombres: "Victor", apellidos: "Flores", grupo: "Tienda", telefono1: "+56911111111" },
    { rut: "12345678-5", correo: "m@gmail.com", nombres: "Maria", apellidos: "Perez", grupo: "Bodega" },
    { rut: "9306036-9", correo: "p@gmail.com", nombres: "Pedro", apellidos: "Soto", grupo: "tienda" },
  ],
  turnos: [{ nombre: "Mañana", horaInicio: "9:00", horaFin: "18.30", tipoColacion: "libre", colacionMinutos: 45 }],
  planificaciones: [{ nombre: "Semana Normal", diasTurnos: ["Mañana", "Mañana", "Mañana", "Mañana", "Mañana", "Libre", "Libre"] }],
  asignaciones: [
    { rutTrabajador: "18.371.911-4", planificacion: "semana normal", desde: "2026-09-01", hasta: "permanente" },
  ],
}

describe("mapa configuración → formData wizard", () => {
  const m = wizardFormDataDesdeConfiguracion(CFG)

  test("grupos únicos por nombre (case/tilde-insensible), bajo empresa.grupos", () => {
    assert.equal(m.empresaGrupos.length, 2)
    assert.deepEqual(m.empresaGrupos.map((g) => g.nombre), ["Tienda", "Bodega"])
  })

  test("trabajadores con la forma de la carga masiva del wizard", () => {
    const t = m.trabajadores[0] as Record<string, unknown>
    assert.equal(t.nombre, "Victor Flores")
    assert.equal(t.correo, "v@gmail.com")
    assert.equal(t.grupoNombre, "Tienda")
    assert.equal(t.origen, "masivo")
    assert.equal(t.tipo, "usuario")
    // Pedro comparte grupoId con Victor ("tienda" ≈ "Tienda").
    assert.equal((m.trabajadores[2] as Record<string, unknown>).grupoId, t.grupoId)
  })

  test("horas normalizadas y turno Libre inyectado cuando la semana lo usa", () => {
    const manana = m.turnos[0] as Record<string, unknown>
    assert.equal(manana.horaInicio, "09:00")
    assert.equal(manana.horaFin, "18:30")
    assert.equal(manana.colacionMinutos, 45)
    assert.ok(m.turnos.some((t) => (t as Record<string, unknown>).id === ID_TURNO_LIBRE))
  })

  test("planificación con 7 turnoIds resueltos (finde = Libre)", () => {
    const p = m.planificaciones[0]
    assert.equal(p.diasTurnos.length, 7)
    assert.ok(p.diasTurnos.slice(0, 5).every((id) => id === (m.turnos[0] as { id: number }).id))
    assert.ok(p.diasTurnos.slice(5).every((id) => id === ID_TURNO_LIBRE))
  })

  test("asignación resuelve trabajador por RUT (con puntos) y plan por nombre", () => {
    assert.equal(m.asignaciones.length, 1)
    assert.equal(m.asignaciones[0].trabajadorId, (m.trabajadores[0] as { id: number }).id)
    assert.equal(m.asignaciones[0].planificacionId, m.planificaciones[0].id)
    assert.equal(m.asignaciones[0].hasta, "permanente")
  })

  test("determinismo: mismo estado → mismos ids", () => {
    assert.deepEqual(wizardFormDataDesdeConfiguracion(CFG), m)
  })
})
