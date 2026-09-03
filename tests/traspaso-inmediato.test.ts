/**
 * TRASPASO INMEDIATO (Lalo, 03-sep): "quiero que me llamen" deja de generar
 * una promesa que muere y dispara el traspaso completo — registro en Zoho por
 * la escalera, tómbola, y presentación del ejecutivo en el mismo turno.
 *
 * MOTIVO: de 33 promesas hechas desde el 29-ago, 20 vencieron sin cumplirse
 * (61%), y las 33 nacieron con vendedor_email en NULL porque se preguntaba
 * quién era el responsable ANTES de que la tómbola lo decidiera.
 *
 * Este test fija por INSPECCIÓN las reglas que no se pueden romper, sin tocar
 * Zoho ni Supabase: son invariantes del código, no del entorno.
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const cron = readFileSync("app/api/vic-ptv-cron/route.ts", "utf8")
const bloque = cron.slice(cron.indexOf("export async function traspasarAhora"), cron.indexOf("export async function GET"))
const loop = readFileSync("lib/agent-loop.ts", "utf8")

describe("traspasarAhora: las reglas que no se pueden romper", () => {
  test("existe y se exporta desde el módulo que ya tiene la asignación", () => {
    assert.ok(bloque.length > 500, "no encontré traspasarAhora")
  })

  test("un contacto YA traspasado no se re-sortea", () => {
    // El candado va ANTES de pedir vendedor: mover a alguien de manos dos
    // veces es peor que no moverlo.
    const iCandado = bloque.indexOf("estado=eq.activo")
    const iVendedor = bloque.indexOf("siguienteVendedor")
    assert.ok(iCandado > 0, "falta la consulta de traspaso activo")
    assert.ok(iCandado < iVendedor, "el candado de traspaso activo debe ir ANTES de sortear")
    assert.ok(bloque.includes("yaTeniaVendedor"), "debe devolver el vendedor existente en vez de sortear otro")
  })

  test("el registro en vic_ptv se crea ANTES de asignar en Zoho (candado anti-carrera)", () => {
    const iFila = bloque.indexOf("vic_ptv`, {")
    const iZoho = bloque.indexOf("asignarEnZoho")
    assert.ok(iFila > 0 && iZoho > 0 && iFila < iZoho, "la fila de vic_ptv debe crearse antes de asignarEnZoho")
  })

  test("la propiedad la decide asignarEnZoho, no este código", () => {
    // Ninguna lógica de dueño propia: así el candado de dueño humano —que
    // ahora respeta también a Eddyluz y Anderson— viaja incluido.
    assert.ok(bloque.includes("asignarEnZoho"), "debe delegar en asignarEnZoho")
    assert.ok(!/INTERINOS|esInterina/.test(bloque), "no puede tener lógica de interinos propia")
  })

  test("apaga la cadencia y avisa al equipo", () => {
    assert.ok(bloque.includes("ptv_traspasado"), "debe cerrar el loop")
    assert.ok(bloque.includes("avisarEquipoInterno"), "debe avisar al equipo")
  })
})

describe("el agente presenta al ejecutivo en el mismo turno", () => {
  test("pasa los datos del vendedor al modelo y prohíbe la promesa vaga", () => {
    assert.ok(loop.includes("traspasarAhora"), "el agente no llama al traspaso")
    assert.ok(loop.includes("instruccionPresentacion"), "no inyecta la instrucción de presentar")
    assert.ok(
      loop.includes('PROHIBIDO decir "se va a contactar contigo en las próximas horas"'),
      "debe prohibir explícitamente la promesa de plazo que no controlamos",
    )
  })

  test("la promesa se sigue registrando, pero ya con el dueño real", () => {
    const i = loop.indexOf("const ejecPromesa")
    const frag = loop.slice(i, i + 260)
    assert.ok(frag.includes("ejecTraspaso"), "la promesa debe heredar el dueño que devolvió la tómbola")
  })
})
