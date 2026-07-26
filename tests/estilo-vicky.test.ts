/**
 * Reglas de estilo y blindaje de Vicky (las de CLAUDE.md, órdenes de Eduardo).
 *
 * No son cosméticas: cada una nació de un caso real y se rompieron todas al
 * menos una vez cuando se editaba un prompt sin acordarse de la regla. Un test
 * se acuerda; una nota en un archivo no.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import {
  sanitizarVoseo,
  normalizarFormatoWhatsApp,
  quitarSignosApertura,
  blindarContactoComercial,
} from "../lib/voseo-v3.ts"

const RAIZ = new URL("..", import.meta.url).pathname

/** Todos los .ts de prompts y textos que Vicky puede llegar a decir. */
function archivosDeTexto(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e === ".next" || e === ".git" || e === "tests") continue
      const p = join(dir, e)
      if (statSync(p).isDirectory()) walk(p)
      else if (p.endsWith(".ts")) out.push(p)
    }
  }
  walk(join(RAIZ, "lib"))
  walk(join(RAIZ, "app"))
  return out
}

describe("prohibido 'Oye' (CLAUDE.md, 23-jul)", () => {
  test("ningún prompt ni texto hardcodeado empieza un mensaje con 'Oye'", () => {
    // Se busca el vocativo real ("Oye," / "Oye Juan"), no la palabra dentro de
    // la propia regla que lo prohíbe ni de un comentario que la explica.
    const VOCATIVO = /(?:^|["'`\n>*\-–—]\s*)Oye\b/m
    const infractores: string[] = []
    for (const f of archivosDeTexto()) {
      const contenido = readFileSync(f, "utf8")
      for (const linea of contenido.split("\n")) {
        if (!VOCATIVO.test(linea)) continue
        // Las líneas que ENUNCIAN la prohibición son legítimas.
        if (/NUNCA|PROHIBIDO|jam[aá]s|no (uses|digas|empieces)/i.test(linea)) continue
        infractores.push(`${f.replace(RAIZ, "")}: ${linea.trim().slice(0, 100)}`)
      }
    }
    assert.deepEqual(infractores, [], `"Oye" encontrado en:\n${infractores.join("\n")}`)
  })
})

describe("anti-voseo chileno", () => {
  test("convierte el voseo verbal a tuteo neutro", () => {
    for (const [entrada, esperado] of [
      ["Me los pasai?", "Me los pasas?"], // caso real
      ["Querís que te lo mande?", "Quieres que te lo mande?"],
      ["Podís pagarlo en línea", "Puedes pagarlo en línea"],
      ["Cuántos trabajadores tenís?", "Cuántos trabajadores tienes?"],
      ["Estái listo?", "Estás listo?"],
    ] as const) {
      assert.equal(sanitizarVoseo(entrada), esperado)
    }
  })

  test("NO rompe palabras legítimas que se parecen al voseo", () => {
    // La lista de verbos es curada justamente por esto: una regex genérica de
    // "-ai"/"-is" se comería estas.
    for (const palabra of [
      "el país tiene 16 regiones",
      "son seis puntos de marca",
      "hicimos el análisis de asistencia",
      "juega tenis los martes",
      "hay una crisis de rotación",
      "viajó a Dubái",
    ]) {
      assert.equal(sanitizarVoseo(palabra), palabra, `se rompió: ${palabra}`)
    }
  })
})

describe("formato de WhatsApp", () => {
  test("Vicky no usa negritas (se ve a bot)", () => {
    assert.equal(normalizarFormatoWhatsApp("El plan **mensual** es"), "El plan mensual es")
    assert.equal(normalizarFormatoWhatsApp("El plan *mensual* es"), "El plan mensual es")
  })

  test("un asterisco suelto de viñeta se conserva", () => {
    assert.equal(normalizarFormatoWhatsApp("* Control de asistencia"), "* Control de asistencia")
  })

  test("se quitan los signos de apertura", () => {
    assert.equal(quitarSignosApertura("¡Hola! ¿Cómo estás?"), "Hola! Cómo estás?")
  })
})

describe("sin ejecutivo antes del pago (17-jul)", () => {
  test("el teléfono del ejecutivo se reemplaza por el de soporte", () => {
    for (const texto of [
      "Escríbele a Anderson al +56 9 3937 2058",
      "su número es 993372058".replace("993372058", "9 3937 2058"),
      "contacto: 56939372058",
    ]) {
      const out = blindarContactoComercial(texto, false)
      assert.ok(!/3937[\s).-]*2058/.test(out), `se filtró el número en: ${texto}`)
      assert.ok(out.includes("+56 9 4401 3873"), `no quedó el de soporte en: ${texto}`)
    }
  })

  test("con el pago hecho, el contacto comercial SÍ puede salir", () => {
    const texto = "Anderson te escribe al +56 9 3937 2058"
    assert.equal(blindarContactoComercial(texto, true), texto)
  })
})
