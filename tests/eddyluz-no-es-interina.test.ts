/**
 * ORDEN DE LALO (03-sep): "ella no es interina, ni Anderson — quita cualquier
 * tipo de sentencia que lo indique en todo el código".
 *
 * Eddyluz venía marcada como interina desde el relevo del 27-jul, cuando TODO
 * lo nuevo nacía a su nombre y esa marca servía para saber que el registro aún
 * no tenía dueño real. Hace rato dejó de ser cierto, y la marca tenía un
 * efecto caro: un deal o un lead suyos contaban como "sin dueño", así que
 * cualquier hito con sorteoInmediato o cualquier reloj de traspaso podía
 * QUITÁRSELOS y sortearlos a otra persona.
 *
 * Interino hoy = solo el usuario Vicky y GeoVictoria Admin (info@), que son
 * dueños-bot de verdad. Anderson nunca estuvo en ninguna lista; este test lo
 * fija también para que no entre.
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const EDDYLUZ = "3525045000000211283"
const ANDERSON = "3525045000426432190"

/** Líneas de CÓDIGO (sin comentarios) de un archivo. */
const codigo = (ruta: string) =>
  readFileSync(ruta, "utf8")
    .split("\n")
    .filter((l) => {
      const t = l.trim()
      return t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*")
    })
    .join("\n")

describe("Eddyluz y Anderson son ejecutivos reales, no interinos", () => {
  test("ninguno está en la lista INTERINOS del agente", () => {
    const src = codigo("lib/crm-hitos.ts")
    const bloque = src.slice(src.indexOf("const INTERINOS"), src.indexOf("const SDR_CO_IDS"))
    assert.ok(!bloque.includes(EDDYLUZ), "Eddyluz volvió a INTERINOS")
    assert.ok(!bloque.includes(ANDERSON), "Anderson entró a INTERINOS")
  })

  test("el patrón de interinas del traspaso no los nombra", () => {
    const src = codigo("app/api/vic-ptv-cron/route.ts")
    const linea = src.split("\n").find((l) => l.includes("const esInterina =")) || ""
    assert.ok(linea, "no encontré el patrón de interinas")
    assert.ok(!linea.includes("emujica"), "emujica@ volvió al patrón de interinas")
    assert.ok(!linea.includes("adiazg"), "adiazg@ entró al patrón de interinas")
    // Y sigue reconociendo a los dueños-bot de verdad.
    assert.ok(linea.includes("vicky@"), "el patrón dejó de reconocer al usuario Vicky")
  })
})
