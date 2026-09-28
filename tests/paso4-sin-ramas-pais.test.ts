import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * CANDADO DEL PASO 4 (28-sep, Lalo "un país nuevo se habilita EN LA FICHA y
 * no agregando `if (pais === …)`"): los procesos automáticos de TRASPASO y
 * POST-PAGO no vuelven a bifurcar por país a mano. Lo que varía por país es
 * un DATO de lib/paises/ficha-operativa.ts (procesos.*, zoho.*, plantillas.*,
 * equipo, tz, documento) y el código lo LEE con fichaOperativa/paisTieneProceso/
 * reglaZoho/paisDeTelefonoOperativo/documentoEnTexto/razonSocialPorPadron.
 *
 * Las excepciones van declaradas con MOTIVO y solo pueden achicarse: son
 * convenciones (Chile = llave kv sin sufijo, línea por defecto del push, país
 * de origen del roster chileno), no decisiones de negocio escondidas.
 */

const RAIZ = join(import.meta.dirname, "..")
const ARCHIVOS = ["app/api/vic-ptv-cron/route.ts", "lib/traspaso-postpago.ts", "lib/crm-hitos.ts"]

const PROHIBIDO: Array<{ que: string; re: RegExp }> = [
  { que: 'pais === "cc"', re: /\bpais\w*\s*===\s*"(cl|pe|co|mx)"/ },
  { que: 'pais !== "cc"', re: /\bpais\w*\s*!==\s*"(cl|pe|co|mx)"/ },
  { que: 'startsWith("5x")', re: /startsWith\("5[1267]/ },
  { que: '=== "Territorio"', re: /(===|!==)\s*"(Chile|Colombia|M[eé]xico|Per[uú])"/ },
  { que: "esCL/esCO/esMX/esPE/esChile", re: /\b(esCL|esCO|esMX|esPE|esChile)\b\s*=[^=]/ },
  { que: "interruptor/plantilla por país a mano", re: /\b(tombolaZohoCoActiva|pePresentaHabilitado|TM_PAIS_NOMBRE|TM_TEMPLATE_(PE|CO|MX))\b/ },
]

/** Excepciones vigentes: {archivo, fragmento literal de la línea, motivo}. */
const EXCEPCIONES: Array<{ archivo: string; fragmento: string; motivo: string }> = [
  {
    archivo: "app/api/vic-ptv-cron/route.ts",
    fragmento: '.filter((f) => f.pais !== "cl")',
    motivo: "leads cruzados: Chile es el país de ORIGEN del roster de calificación chileno (la función existe para sacar de ahí a los otros países)",
  },
  {
    archivo: "app/api/vic-ptv-cron/route.ts",
    fragmento: 'if (!paisLead || paisLead === "cl" || !l.id) continue',
    motivo: "leads cruzados: un lead con Territorio Chile no está cruzado (mismo motivo)",
  },
  {
    archivo: "lib/traspaso-postpago.ts",
    fragmento: 'const sufijo = pais === "cl" ? "" : `_${pais}`',
    motivo: "convención histórica de llaves kv/env de Chile sin sufijo (owner_venta_autonoma, VICKY_OWNER_VENTA_AUTONOMA)",
  },
  {
    archivo: "lib/traspaso-postpago.ts",
    fragmento: 'paisChat === "cl" ? undefined : channelIdPorPais(paisChat)',
    motivo: "la línea de Chile es el canal por defecto de botmaker-push (convención del push, no decisión de negocio)",
  },
  {
    archivo: "lib/traspaso-postpago.ts",
    fragmento: 'paisChat === "cl" ? undefined : (await import("./linea-por-pais")).channelIdPorPais(paisChat)',
    motivo: "idem: canal por defecto del push",
  },
]

function esComentario(linea: string): boolean {
  const t = linea.trim()
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
}

function hallazgos(): Array<{ archivo: string; linea: number; texto: string; que: string }> {
  const out: Array<{ archivo: string; linea: number; texto: string; que: string }> = []
  for (const rel of ARCHIVOS) {
    const lineas = readFileSync(join(RAIZ, rel), "utf8").split("\n")
    lineas.forEach((texto, i) => {
      if (esComentario(texto)) return
      for (const p of PROHIBIDO) if (p.re.test(texto)) out.push({ archivo: rel, linea: i + 1, texto: texto.trim(), que: p.que })
    })
  }
  return out
}

test("traspaso y post-pago no bifurcan por país a mano: todo lo que varía es un dato de la ficha operativa", () => {
  const sinExcepcion = hallazgos().filter((h) => !EXCEPCIONES.some((e) => e.archivo === h.archivo && h.texto.includes(e.fragmento)))
  const detalle = sinExcepcion.map((h) => `  ${h.archivo}:${h.linea} [${h.que}] ${h.texto}`).join("\n")
  assert.equal(
    sinExcepcion.length,
    0,
    `Bifurcación por país fuera de la ficha (léelo de lib/paises/ficha-operativa.ts o decláralo en EXCEPCIONES con motivo):\n${detalle}`,
  )
})

test("las excepciones declaradas siguen existiendo (la lista solo se achica)", () => {
  const h = hallazgos()
  const muertas = EXCEPCIONES.filter((e) => !h.some((x) => x.archivo === e.archivo && x.texto.includes(e.fragmento)))
  assert.deepEqual(muertas.map((e) => e.fragmento), [], "estas excepciones ya no están en el código: bórralas de la lista")
})
