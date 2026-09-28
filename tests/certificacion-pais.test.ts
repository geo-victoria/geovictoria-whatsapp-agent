/**
 * CERTIFICACIÓN DE PAÍS (paso 6 del orden del 21-sep): las 15 dimensiones que
 * un país necesita para operar, medidas SIN red y SIN efectos — cero escrituras
 * en vic_kv o Zoho, ninguna regla con lar_id, ningún turno de tómbola.
 *
 * Todas son bloqueantes (Lalo 21-sep). Lo que la ficha operativa declara en
 * `pendientes` (gente, panel, decisiones) sale en el informe y no frena; una
 * falta no declarada sí frena: un país nuevo no se enciende con un hueco
 * escondido, y un país vivo no pierde una dimensión en silencio.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { certificarPais, PAISES_CERT, DIMENSIONES, matrizLoopDesdeTexto, TOOLS_CANONICAS, type Fuentes } from "../lib/certificacion-pais.ts"

const leer = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8")

// Tools de Chile: los nombres reales de lib/tools/*.ts (index.ts importa red; se lee el texto).
const toolsCL = [...new Set([...leer("lib/tools/index.ts").matchAll(/^\s*name:\s*"([a-z_]+)"/gm)].map((m) => m[1]))]
const toolsCLdesdeArchivos = [...new Set([...TOOLS_CANONICAS].filter((n) => leer(`lib/tools/${n.replace(/_/g, "-")}.ts`).includes(`"${n}"`)))]

const FUENTES: Fuentes = {
  loopCron: leer("app/api/vic-loop-cron/route.ts"),
  ptvCron: leer("app/api/vic-ptv-cron/route.ts"),
  outboundLead: leer("app/api/vic-outbound-lead/route.ts"),
  toolsCL: toolsCL.length >= 15 ? toolsCL : toolsCLdesdeArchivos,
}

test("el catálogo de dimensiones son las 15 del 21-sep, numeradas y sin repetir", () => {
  assert.equal(DIMENSIONES.length, 15)
  assert.deepEqual(
    DIMENSIONES.map((d) => d.n),
    Array.from({ length: 15 }, (_, i) => i + 1),
  )
  assert.equal(new Set(DIMENSIONES.map((d) => d.id)).size, 15)
})

test("la matriz de plantillas del loop se lee del cron (constantes resueltas)", () => {
  const m = matrizLoopDesdeTexto(FUENTES.loopCron!)
  assert.ok(m.length >= 10, `pocas celdas: ${m.length}`)
  const t1 = m.find((f) => f.env === "LOOP_TPL_T1_SIN_PRECIO")!
  assert.equal(t1.cl, "vicky_loop_sin_precio")
  assert.equal(t1.co, "vicky_co_react_preform")
  assert.equal(t1.pe, "vicky_pe_loop_sin_precio")
})

for (const pais of PAISES_CERT) {
  test(`${pais.toUpperCase()}: las 15 dimensiones certificadas (solo lectura)`, () => {
    const c = certificarPais(pais, FUENTES)
    assert.equal(c.soloLectura, true)
    const conFaltas = c.dimensiones.filter((d) => !d.ok)
    assert.deepEqual(
      conFaltas.map((d) => `${d.n}. ${d.id}`),
      [],
      `${pais.toUpperCase()} no certifica:\n${conFaltas
        .map((d) => `  ${d.n}. ${d.nombre}\n${d.faltas.map((f) => `      · ${f}`).join("\n")}`)
        .join("\n")}\nPendientes declarados en la ficha:\n${c.pendientesDeclarados.map((p) => `  - ${p}`).join("\n") || "  (ninguno)"}`,
    )
    assert.equal(c.resueltas, 15)
  })
}

test("la certificación no escribe ni consulta nada: el módulo no importa persistencia, red ni Zoho", () => {
  const src = leer("lib/certificacion-pais.ts")
  for (const prohibido of ["supabase", "fetch(", "zoho-", "botmaker", "setKv", "lar_id", "assignment"]) {
    assert.ok(!src.includes(prohibido), `lib/certificacion-pais.ts menciona "${prohibido}": la certificación es de solo lectura`)
  }
})
