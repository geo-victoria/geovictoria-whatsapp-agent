/**
 * EL VIGÍA DE PROMESAS, DESPUÉS DEL DIAGNÓSTICO DEL 03-sep.
 *
 * Datos que lo motivan: de 33 promesas desde el 29-ago, 20 vencieron sin
 * cumplirse (61%) — y LAS 33 nacieron con vendedor_email en NULL. La causa era
 * de orden: se preguntaba quién era el responsable un segundo ANTES de que la
 * tómbola lo decidiera, así que la alerta salía sin destinatario ("promesa
 * vencida con +569…" sin decir de quién era). Y `alertada` era terminal: el
 * vigía solo miraba `pendiente`, así que una promesa alertada no se volvía a
 * revisar nunca — ni para marcarla cumplida si alguien la atendía tarde.
 *
 * Tres invariantes, verificados por inspección (sin tocar Supabase).
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const src = readFileSync("lib/promesas.ts", "utf8")

describe("el vigía persigue a alguien, no al vacío", () => {
  test("el dueño se resuelve TARDE, cuando la tómbola ya corrió", () => {
    assert.ok(src.includes("async function duenoDeLaPromesa"), "falta el resolutor de dueño")
    assert.ok(src.includes("vic_ptv?contact="), "debe leer el dueño real del traspaso")
    // Y se persiste, para que la Cartera y el correo diario lo vean.
    assert.ok(/vendedor_email: responsable/.test(src), "el dueño resuelto debe guardarse")
  })

  test("la alerta dice de quién es, o dice que no tiene dueño", () => {
    assert.ok(src.includes("RESPONSABLE:"), "la alerta debe nombrar al responsable")
    assert.ok(src.includes("SIN RESPONSABLE ASIGNADO"), "y decirlo explícito cuando no hay")
  })

  test("alertada dejó de ser terminal: se revisa y escala", () => {
    assert.ok(src.includes("estado=in.(pendiente,alertada)"), "el vigía debe mirar también las alertadas")
    assert.ok(src.includes("ESCALAMIENTO"), "falta el escalamiento")
    assert.ok(src.includes('estado: "escalada"'), "la escalada debe cerrar el ciclo del vigía")
  })
})

describe("el reloj del escalamiento es en horas HÁBILES", () => {
  test("el escalamiento usa sumarHorasHabiles, no una suma de milisegundos", () => {
    // Una promesa hecha el viernes por la tarde no puede escalar el sábado:
    // el plazo tiene que caminar en horas hábiles, como el deadline original.
    const i = src.indexOf("SEGUNDA VUELTA")
    const bloque = src.slice(i, i + 700)
    assert.ok(bloque.includes("sumarHorasHabiles"), "el escalamiento debe usar horas hábiles")
    assert.ok(!/\d+\s*\*\s*3600e?3/.test(bloque), "no puede sumar milisegundos crudos")
  })
})
