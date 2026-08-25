/**
 * Configuración por chat (trabajadores/turnos/planificaciones): el candado
 * determinista es la transcripción de las validaciones del WIZARD traducidas
 * a lenguaje cotidiano (Lalo 24-ago). Estos tests fijan las reglas — si el
 * wizard cambia las suyas, este archivo es el recordatorio de actualizar.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import {
  parsearNominaPegada,
  pendientesTrabajador,
  pendientesTurno,
  pendientesPlanificacion,
  pendientesConfiguracion,
  configuracionVacia,
  normalizarHora,
  resumenConfiguracion,
  type Configuracion,
} from "../lib/onboarding/configuracion.ts"

const TRABAJADOR_OK = {
  rut: "18371911-4",
  correo: "victor@gmail.com",
  nombres: "Victor Manuel",
  apellidos: "Flores",
  grupo: "Tienda",
  telefono1: "+56912345678",
}

const TURNO_OK = { nombre: "Mañana", horaInicio: "09:00", horaFin: "18:30", tipoColacion: "sin" as const }

describe("nómina pegada (8 columnas del wizard)", () => {
  test("parsea filas con tab y con pipe", () => {
    const filas = parsearNominaPegada(
      "18371911-4\tvictor@gmail.com\tVictor\tFlores\tTienda\t+56912345678\n" +
        "12345678-5|maria@gmail.com|Maria|Perez|Bodega",
    )
    assert.equal(filas.length, 2)
    assert.equal(filas[0].correo, "victor@gmail.com")
    assert.equal(filas[1].grupo, "Bodega")
  })

  test("fila completa y válida no deja pendientes", () => {
    assert.deepEqual(pendientesTrabajador(TRABAJADOR_OK, 0), [])
  })

  test("correo personal es OBLIGATORIO (regla Lalo 24-ago) y se dice cotidiano", () => {
    const faltas = pendientesTrabajador({ ...TRABAJADOR_OK, correo: "" }, 0)
    assert.equal(faltas.length, 1)
    assert.match(faltas[0].mensaje, /correo personal/)
    assert.match(faltas[0].mensaje, /Victor Manuel Flores/)
  })

  test("RUT con dígito malo se reporta con el RUT a la vista", () => {
    const faltas = pendientesTrabajador({ ...TRABAJADOR_OK, rut: "18371911-9" }, 0)
    assert.equal(faltas.length, 1)
    assert.match(faltas[0].mensaje, /dígito verificador/)
  })

  test("grupo faltante sugiere el grupo general", () => {
    const faltas = pendientesTrabajador({ ...TRABAJADOR_OK, grupo: "" }, 0)
    assert.match(faltas[0].mensaje, /grupo/)
  })

  test("teléfono opcional: vacío pasa, basura no", () => {
    assert.deepEqual(pendientesTrabajador({ ...TRABAJADOR_OK, telefono1: "" }, 0), [])
    assert.equal(pendientesTrabajador({ ...TRABAJADOR_OK, telefono1: "123" }, 0).length, 1)
  })
})

describe("turnos (reglas del wizard)", () => {
  test("turno completo pasa", () => {
    assert.deepEqual(pendientesTurno(TURNO_OK), [])
  })

  test("sin hora de salida se pide en cotidiano", () => {
    const faltas = pendientesTurno({ ...TURNO_OK, horaFin: "" })
    assert.equal(faltas.length, 1)
    assert.match(faltas[0].mensaje, /hora de salida del turno Mañana/)
  })

  test("Libre y Descanso no exigen horas", () => {
    assert.deepEqual(pendientesTurno({ nombre: "Libre" }), [])
    assert.deepEqual(pendientesTurno({ nombre: "Descanso" }), [])
  })

  test("colación libre exige minutos; fija exige horario", () => {
    assert.match(pendientesTurno({ ...TURNO_OK, tipoColacion: "libre" })[0].mensaje, /cuántos minutos/)
    assert.match(pendientesTurno({ ...TURNO_OK, tipoColacion: "fija" })[0].mensaje, /horario/)
    assert.deepEqual(pendientesTurno({ ...TURNO_OK, tipoColacion: "libre", colacionMinutos: 45 }), [])
    assert.deepEqual(
      pendientesTurno({ ...TURNO_OK, tipoColacion: "fija", colacionInicio: "13:00", colacionFin: "13:45" }),
      [],
    )
  })

  test("horas en formatos humanos se normalizan; basura no", () => {
    assert.equal(normalizarHora("9:00"), "09:00")
    assert.equal(normalizarHora("18.30"), "18:30")
    assert.equal(normalizarHora("0900"), "09:00")
    assert.equal(normalizarHora("25:00"), null)
  })
})

describe("planificaciones (7 días, turnos existentes)", () => {
  const TURNOS = [TURNO_OK, { nombre: "Tarde", horaInicio: "14:00", horaFin: "22:00", tipoColacion: "sin" as const }]

  test("semana completa con turnos reales y Libre pasa", () => {
    const plan = { nombre: "Semana Normal", diasTurnos: ["Mañana", "Mañana", "Mañana", "Mañana", "Tarde", "Libre", "Libre"] }
    assert.deepEqual(pendientesPlanificacion(plan, TURNOS), [])
  })

  test("día vacío se pregunta con el día por su nombre", () => {
    const plan = { nombre: "Semana Normal", diasTurnos: ["Mañana", "Mañana", "Mañana", "Mañana", "Tarde", "Libre", null] }
    const faltas = pendientesPlanificacion(plan, TURNOS)
    assert.equal(faltas.length, 1)
    assert.match(faltas[0].mensaje, /domingo/)
    assert.match(faltas[0].mensaje, /Libre/)
  })

  test("turno inexistente se acusa por nombre", () => {
    const plan = { nombre: "Rotativo", diasTurnos: ["Nocturno", "Mañana", "Mañana", "Mañana", "Tarde", "Libre", "Libre"] }
    const faltas = pendientesPlanificacion(plan, TURNOS)
    assert.equal(faltas.length, 1)
    assert.match(faltas[0].mensaje, /"Nocturno".*no está creado/)
  })
})

describe("el candado de conjunto", () => {
  function cfgCompleta(): Configuracion {
    return {
      trabajadores: [TRABAJADOR_OK],
      turnos: [TURNO_OK],
      planificaciones: [{ nombre: "Semana Normal", diasTurnos: ["Mañana", "Mañana", "Mañana", "Mañana", "Mañana", "Libre", "Libre"] }],
      asignaciones: [{ rutTrabajador: "18371911-4", planificacion: "Semana Normal", desde: "2026-09-01", hasta: "permanente" }],
    }
  }

  test("configuración completa: cero pendientes → se puede confirmar", () => {
    assert.deepEqual(pendientesConfiguracion(cfgCompleta()), [])
  })

  test("trabajador sin asignación bloquea con su nombre", () => {
    const cfg = cfgCompleta()
    cfg.asignaciones = []
    const faltas = pendientesConfiguracion(cfg)
    assert.equal(faltas.length, 1)
    assert.match(faltas[0].mensaje, /asignarle planificación a: Victor Manuel Flores/)
  })

  test("asignación sin fechas pide desde y hasta/permanente", () => {
    const cfg = cfgCompleta()
    cfg.asignaciones = [{ rutTrabajador: "18371911-4", planificacion: "Semana Normal" }]
    const mensajes = pendientesConfiguracion(cfg).map((f) => f.mensaje).join(" | ")
    assert.match(mensajes, /desde cuándo/)
    assert.match(mensajes, /permanente/)
  })

  test("nómina SOLA basta: turnos/planificaciones son opcionales (Lalo 25-ago)", () => {
    const cfg = configuracionVacia()
    cfg.trabajadores = [TRABAJADOR_OK]
    assert.deepEqual(pendientesConfiguracion(cfg), [])
  })

  test("configuración vacía no inventa pendientes (el riel es opcional)", () => {
    assert.deepEqual(pendientesConfiguracion(configuracionVacia()), [])
  })

  test("el resumen pre-confirmación nombra nómina, turnos y semana", () => {
    const r = resumenConfiguracion(cfgCompleta())
    assert.match(r, /Trabajadores: 1/)
    assert.match(r, /Turno Mañana: 09:00–18:30/)
    assert.match(r, /Semana Normal/)
  })
})
