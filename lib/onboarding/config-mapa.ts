/**
 * MAPA cerebro → formData del WIZARD (F2, 25-ago).
 *
 * La configuración conversada por chat (lib/onboarding/configuracion.ts) se
 * escribe en la SESIÓN del wizard con SUS formas exactas (decisión 24-ago:
 * reusar el downstream — PATCH + submit-to-zoho generan las mismas planillas
 * y disparan el mismo Zoho Flow; wizard y chat conviven sobre el mismo
 * estado). Formas transcritas de components/onboarding-turnos.tsx y del merge
 * de app/api/onboarding/[id]:
 *   - empresa.grupos: [{ id, nombre }]
 *   - trabajadores:   [{ id, nombre, rut, correo, grupoId, grupoNombre,
 *                        telefono1..3, origen: "masivo", tipo: "usuario" }]
 *   - turnos:         [{ id, nombre, horaInicio, horaFin, tipoColacion,
 *                        colacionMinutos?, colacionInicio?, colacionFin? }]
 *   - planificaciones:[{ id, nombre, diasTurnos: [turnoId x7 lun→dom] }]
 *   - asignaciones:   [{ id, trabajadorId, planificacionId, desde, hasta }]
 *
 * Ids DETERMINISTAS por índice (base fija por familia): el mismo estado del
 * chat siempre produce los mismos ids — re-escrituras idempotentes, sin
 * Date.now() (módulo puro).
 */

import { type Configuracion, normalizarHora, esTurnoLibre, DIAS_SEMANA } from "./configuracion.ts"

const BASE_GRUPO = 910_000
const BASE_TRABAJADOR = 920_000
const BASE_TURNO = 930_000
const BASE_PLAN = 940_000
const BASE_ASIGNACION = 950_000

/** Id fijo del turno "Libre" que se inyecta cuando alguna planificación lo usa. */
export const ID_TURNO_LIBRE = BASE_TURNO + 999

function clave(s: string | undefined): string {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
}

export type WizardFormDataParcial = {
  empresaGrupos: Array<{ id: number; nombre: string }>
  trabajadores: Array<Record<string, unknown>>
  turnos: Array<Record<string, unknown>>
  planificaciones: Array<{ id: number; nombre: string; diasTurnos: number[] }>
  asignaciones: Array<{ id: number; trabajadorId: number; planificacionId: number; desde: string; hasta: string }>
}

/**
 * Traduce la configuración del chat a los arreglos del wizard. NO valida:
 * el candado (pendientesConfiguracion) debe estar en cero ANTES de llamar —
 * la tool de confirmación lo garantiza.
 */
export function wizardFormDataDesdeConfiguracion(cfg: Configuracion): WizardFormDataParcial {
  // Grupos: únicos por nombre, en orden de aparición en la nómina.
  const grupos: Array<{ id: number; nombre: string }> = []
  const grupoIdPorClave = new Map<string, number>()
  for (const t of cfg.trabajadores) {
    const k = clave(t.grupo)
    if (!k || grupoIdPorClave.has(k)) continue
    const id = BASE_GRUPO + grupos.length + 1
    grupoIdPorClave.set(k, id)
    grupos.push({ id, nombre: String(t.grupo || "").trim() })
  }

  const trabajadores = cfg.trabajadores.map((t, i) => {
    const id = BASE_TRABAJADOR + i + 1
    const k = clave(t.grupo)
    return {
      id,
      nombre: `${t.nombres || ""} ${t.apellidos || ""}`.trim(),
      rut: String(t.rut || "").trim(),
      correo: String(t.correo || "").trim(),
      grupoId: grupoIdPorClave.get(k) ?? "",
      grupoNombre: String(t.grupo || "").trim(),
      telefono1: String(t.telefono1 || "").trim(),
      telefono2: String(t.telefono2 || "").trim(),
      telefono3: String(t.telefono3 || "").trim(),
      origen: "masivo",
      tipo: "usuario",
    }
  })

  // Turnos declarados + el turno Libre si alguna planificación lo referencia.
  const turnoIdPorClave = new Map<string, number>()
  const turnos: Array<Record<string, unknown>> = []
  cfg.turnos.forEach((t, i) => {
    const id = BASE_TURNO + i + 1
    turnoIdPorClave.set(clave(t.nombre), id)
    const tipo = t.tipoColacion || "sin"
    turnos.push({
      id,
      nombre: String(t.nombre || "").trim(),
      horaInicio: esTurnoLibre(t.nombre) ? "" : normalizarHora(t.horaInicio) || "",
      horaFin: esTurnoLibre(t.nombre) ? "" : normalizarHora(t.horaFin) || "",
      tipoColacion: tipo,
      ...(tipo === "libre" ? { colacionMinutos: Number(t.colacionMinutos) || 0 } : {}),
      ...(tipo === "fija"
        ? { colacionInicio: normalizarHora(t.colacionInicio) || "", colacionFin: normalizarHora(t.colacionFin) || "" }
        : {}),
    })
  })
  const usaLibre = cfg.planificaciones.some((p) => (p.diasTurnos || []).some((d) => esTurnoLibre(String(d || ""))))
  const hayTurnoLibreDeclarado = [...turnoIdPorClave.keys()].some((k) => k === "libre" || k === "descanso")
  if (usaLibre && !hayTurnoLibreDeclarado) {
    turnos.push({ id: ID_TURNO_LIBRE, nombre: "Libre", horaInicio: "", horaFin: "", tipoColacion: "sin" })
    turnoIdPorClave.set("libre", ID_TURNO_LIBRE)
    turnoIdPorClave.set("descanso", ID_TURNO_LIBRE)
  }

  const planIdPorClave = new Map<string, number>()
  const planificaciones = cfg.planificaciones.map((p, i) => {
    const id = BASE_PLAN + i + 1
    planIdPorClave.set(clave(p.nombre), id)
    const dias = DIAS_SEMANA.map((_, d) => {
      const nombreTurno = String((p.diasTurnos || [])[d] || "").trim()
      const k = clave(nombreTurno)
      return turnoIdPorClave.get(esTurnoLibre(nombreTurno) ? "libre" : k) ?? turnoIdPorClave.get(k) ?? 0
    })
    return { id, nombre: String(p.nombre || "").trim(), diasTurnos: dias }
  })

  const rutCompacto = (v: string | undefined) => String(v || "").replace(/[^0-9kK]/g, "").toUpperCase()
  const trabajadorIdPorRut = new Map<string, number>()
  cfg.trabajadores.forEach((t, i) => {
    const r = rutCompacto(t.rut)
    if (r) trabajadorIdPorRut.set(r, BASE_TRABAJADOR + i + 1)
  })

  const asignaciones = cfg.asignaciones
    .map((a, i) => {
      const trabajadorId = trabajadorIdPorRut.get(rutCompacto(a.rutTrabajador)) ?? 0
      const planificacionId = planIdPorClave.get(clave(a.planificacion)) ?? 0
      return {
        id: BASE_ASIGNACION + i + 1,
        trabajadorId,
        planificacionId,
        desde: String(a.desde || "").trim(),
        hasta: String(a.hasta || "").trim(),
      }
    })
    .filter((a) => a.trabajadorId && a.planificacionId)

  return { empresaGrupos: grupos, trabajadores, turnos, planificaciones, asignaciones }
}
