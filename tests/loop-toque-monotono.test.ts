/**
 * LA ESCALERA DE TOQUES SOLO SUBE (04-sep, hallazgo de Rodrigo).
 *
 * `resetLoop` corre con CADA mensaje entrante del cliente. Hasta hoy ponía
 * `next_touch: 1`: la cadencia rebobinaba y el cliente recibía otra vez el
 * texto del toque 1 — con el toque 1 a diez minutos (10-ago), encima de la
 * conversación viva. Medido en producción: 1 de cada 5 toques retrocedía y
 * hubo 72 toques repetidos a 66 clientes en una semana.
 *
 * El reloj SÍ se reancla (el silencio se mide desde el último mensaje del
 * cliente); el contador no. Test de inspección: loop-v2 importa Supabase, y
 * lo que hay que fijar es la forma, no el efecto de red.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const FUENTE = readFileSync("lib/loop-v2.ts", "utf8")

/** Cuerpo de la función SIN comentarios: lo que importa es el código que
 *  corre, no lo que el comentario cuenta sobre el bug que se arregló. */
function cuerpoDe(nombre: string): string {
  const i = FUENTE.indexOf(`export async function ${nombre}(`)
  assert.ok(i > 0, `no se encontró ${nombre}`)
  const j = FUENTE.indexOf("\n}\n", i)
  return FUENTE.slice(i, j)
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n")
}

test("resetLoop nunca devuelve la cadencia al toque 1", () => {
  const cuerpo = cuerpoDe("resetLoop")
  assert.ok(
    !/next_touch:\s*1\b/.test(cuerpo),
    "rebobinar al toque 1 es el bug: el cliente recibe otra vez el mismo texto",
  )
  assert.ok(
    cuerpo.includes("Math.max(1, Number(row.next_touch) || 1)"),
    "el contador debe partir del toque vigente de la fila, con piso 1",
  )
})

test("resetLoop sí reancla el reloj: el silencio se mide desde ahora", () => {
  const cuerpo = cuerpoDe("resetLoop")
  assert.ok(cuerpo.includes("t0: t0.toISOString()"), "t0 debe volver a anclarse")
  assert.ok(
    cuerpo.includes("calcularProximoToque(t0, siguiente"),
    "la hora del próximo toque se calcula desde el t0 nuevo y el toque vigente",
  )
})

test("resetLoop lee next_touch de la fila (si no, no puede conservarlo)", () => {
  const cuerpo = cuerpoDe("resetLoop")
  assert.ok(
    /select=[^`]*next_touch/.test(cuerpo),
    "sin next_touch en el select, row.next_touch viene undefined y todo vuelve al toque 1",
  )
})

test("enrolarEnLoop delega en resetLoop cuando la fila ya existe", () => {
  const cuerpo = cuerpoDe("enrolarEnLoop")
  assert.ok(
    cuerpo.includes("await resetLoop(contact)"),
    "un contacto ya enrolado no puede re-crearse en el toque 1 por otra puerta",
  )
})
