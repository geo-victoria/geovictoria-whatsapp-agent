/**
 * La frontera del cerebro de onboarding, como test.
 *
 * DECISIÓN QUE ORIGINA ESTE ARCHIVO (26-jul-2026): Vicky onboarding es un
 * segundo agente en el MISMO repo, y la condición para que eso no se convierta
 * en enredo es que lib/onboarding/ sea PURO — sin Supabase, sin Botmaker, sin
 * Foundry, sin tools de venta, sin red. Si esta frontera se respeta, extraerlo
 * a servicio propio el día que haga falta (chat in-app, otro equipo dueño) es
 * mecánico; si se rompe, ningún repo aparte lo habría salvado.
 *
 * Este test convierte esa regla de arquitectura en algo que falla en CI: el
 * import prohibido no llega a producción aunque el reviewer no lo vea.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const DIR = join(new URL("..", import.meta.url).pathname, "lib/onboarding")

// Lo ÚNICO que el cerebro puede importar:
//  - sus propios módulos (./)
//  - los validadores de identificador (puros, y la razón de vivir en este repo)
//  - node builtins (node:)
const PERMITIDOS = [
  /^\.\//,
  /^\.\.\/rut(\.ts)?$/,
  /^\.\.\/paises\/co\/nit(\.ts)?$/,
  /^\.\.\/paises\/mx\/rfc(\.ts)?$/,
  /^node:/,
]

describe("frontera de lib/onboarding", () => {
  const archivos = readdirSync(DIR).filter((f) => f.endsWith(".ts"))

  test("el directorio existe y tiene módulos (el test no puede pasar en vacío)", () => {
    assert.ok(archivos.length >= 2, `esperaba módulos en lib/onboarding, hay ${archivos.length}`)
  })

  test("ningún módulo del cerebro importa fuera de la allowlist", () => {
    const violaciones: string[] = []
    for (const archivo of archivos) {
      const contenido = readFileSync(join(DIR, archivo), "utf8")
      for (const m of contenido.matchAll(/from\s+["']([^"']+)["']/g)) {
        const spec = m[1]
        if (!PERMITIDOS.some((re) => re.test(spec))) {
          violaciones.push(`${archivo} importa "${spec}"`)
        }
      }
    }
    assert.deepEqual(
      violaciones,
      [],
      `La frontera del cerebro se rompió:\n${violaciones.join("\n")}\n` +
        "Si el import es legítimo, la conversación es sobre la arquitectura, no sobre este test.",
    )
  })

  test("en particular: nada de I/O ni del lado ventas", () => {
    // Redundante con la allowlist, pero nombra los prohibidos que más tientan,
    // para que el mensaje de error diga QUÉ se intentó meter.
    const PROHIBIDOS = /supabase|botmaker|foundry|dapta|zoho|@\/|\.\.\/tools\/|\.\.\/loop-v2|fetch\(/
    for (const archivo of archivos) {
      const contenido = readFileSync(join(DIR, archivo), "utf8")
      for (const m of contenido.matchAll(/from\s+["']([^"']+)["']/g)) {
        assert.ok(!PROHIBIDOS.test(m[1]), `${archivo} importa "${m[1]}"`)
      }
      assert.ok(!/\bfetch\s*\(/.test(contenido), `${archivo} hace red — el cerebro no habla HTTP`)
    }
  })
})
