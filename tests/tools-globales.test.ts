// UNA implementación por tool: la de Chile (27-sep, orden de Lalo "todas las
// tools deben ser UNA implementación global: la de Chile").
//
// Este candado falla si un adaptador de país (lib/paises/<cc>/tools-
// unificadas.ts) vuelve a atender por su cuenta una tool GLOBAL —con su propio
// mensaje, su propio saneador o su propia derivación— en vez de pasar por
// lib/paises/tools-globales.ts, que solo llama a lib/tools/* con los datos del
// país. Un país NO puede sumar una tool propia sin declararla acá con motivo.
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { TOOLS_GLOBALES } from "../lib/paises/tools-globales.ts"
import { derivarASoporte, derivarASoporteSchema, derivarASoporteSchemaPais } from "../lib/tools/derivar-a-soporte.ts"
import { programarSeguimientoSchema, programarSeguimientoSchemaPais } from "../lib/tools/programar-seguimiento.ts"

const ADAPTADORES = ["pe", "co", "mx"].map((cc) => ({ cc, file: `lib/paises/${cc}/tools-unificadas.ts` }))

/**
 * Lo único que un adaptador puede atender con código propio, y por qué.
 * Achicar esta lista es el trabajo que queda; agrandarla exige un motivo.
 */
const PROPIAS_PERMITIDAS: Record<string, string> = {
  cotizar_referencial: "motor de precios del país = el motor único de Chile (lib/cotizacion-unica) con los datos del país",
  consultar_descuento_referencial: "misma escalera 10 → 20 sobre el motor único; memoria del estimado <pais>_pref_",
  generar_link_cotizadora: "DEUDA: la emisión todavía es la del país (validación RUC/NIT/RFC, create-from-vicky-<cc>, mensaje de entrega propio)",
  anualizar_cotizacion: "DEUDA: cálculo país-neutro en lib/paises/anualizar-pais.ts (plan y equipo en líneas separadas por impuesto), no el de Chile",
  enviar_certificacion: "stub honesto: fuera de Chile no existe un documento equivalente a la Resolución Exenta N°38",
}

function cuerpoDespacho(src: string): string {
  const i = src.indexOf("export function buildDispatch")
  assert.ok(i >= 0, "no encontré el despacho del adaptador")
  return src.slice(i)
}

test("los adaptadores de país no atienden ninguna tool global por su cuenta", () => {
  for (const { cc, file } of ADAPTADORES) {
    const d = cuerpoDespacho(readFileSync(file, "utf8"))
    for (const t of TOOLS_GLOBALES) {
      assert.ok(!d.includes(`case "${t}"`), `${cc}: el adaptador atiende '${t}' por su cuenta; va por lib/paises/tools-globales.ts`)
    }
    assert.match(d, /if \(esToolGlobal\(name\)\) return despacharToolGlobal\(ctx, name, input\)/, `${cc}: el despacho debe mandar las tools globales a despacharToolGlobal`)
  }
})

test("un adaptador solo atiende las tools propias declaradas (con motivo)", () => {
  for (const { cc, file } of ADAPTADORES) {
    const d = cuerpoDespacho(readFileSync(file, "utf8"))
    const propias = Array.from(d.matchAll(/case "([a-z_]+)"/g)).map((m) => m[1])
    for (const t of propias) {
      assert.ok(t in PROPIAS_PERMITIDAS, `${cc}: '${t}' tiene implementación propia sin declarar — hazla global o decláralo en PROPIAS_PERMITIDAS con motivo`)
    }
  }
})

test("los adaptadores no escriben textos al cliente para las tools globales", () => {
  for (const { cc, file } of ADAPTADORES) {
    const src = readFileSync(file, "utf8")
    // Las confirmaciones de agenda y seguimiento eran copias por país.
    assert.ok(!/Tu reunión quedó (re)?agendada/.test(src), `${cc}: el adaptador reescribe la confirmación de la reunión`)
    assert.ok(!/Mesa de Ayuda/.test(src), `${cc}: el adaptador arma su propia tarjeta de soporte`)
  }
})

test("tools-globales solo llama a las implementaciones de lib/tools", () => {
  const src = readFileSync("lib/paises/tools-globales.ts", "utf8")
  const sw = src.slice(src.indexOf("export async function despacharToolGlobal"))
  const casos = sw.split(/\n    case "/).slice(1)
  assert.equal(casos.length, TOOLS_GLOBALES.length, "cada tool global tiene exactamente un caso")
  for (const c of casos) {
    const nombre = c.slice(0, c.indexOf('"'))
    assert.match(c, /import\("\.\.\/tools\/[a-z-]+\.ts"\)/, `'${nombre}' no llama a lib/tools/*`)
    assert.ok(!/mensajeParaProspecto|mensajeSugeridoUsuario/.test(c), `'${nombre}' arma un texto al cliente`)
  }
})

test("Chile recibe exactamente los schemas y mensajes de siempre", () => {
  assert.equal(derivarASoporteSchemaPais("cl"), derivarASoporteSchema)
  assert.equal(derivarASoporteSchemaPais(), derivarASoporteSchema)
  assert.equal(programarSeguimientoSchemaPais("cl"), programarSeguimientoSchema)
  assert.equal(programarSeguimientoSchemaPais(), programarSeguimientoSchema)
  for (const motivo of ["fuera_de_rango_trabajadores", "callback", "tool_fallo"] as const) {
    assert.deepEqual(derivarASoporte({ motivo, contexto: "x" }), derivarASoporte({ motivo, contexto: "x", _pais: "cl" }))
  }
})

test("los países reciben el schema chileno con SUS datos", () => {
  const pe = derivarASoporteSchemaPais("pe")
  assert.equal(pe.description, derivarASoporteSchema.description)
  assert.match(pe.input_schema.properties.rutEmpresa.description, /^RUC de la empresa \(formato 20605842055\)/)
  assert.match(pe.input_schema.properties.rutEmpresa.description, /SUNAT/)
  assert.doesNotMatch(pe.input_schema.properties.rutEmpresa.description, /\bRUT\b|SII/)
  assert.match(derivarASoporteSchemaPais("co").input_schema.properties.rutEmpresa.description, /^NIT/)
  assert.match(derivarASoporteSchemaPais("mx").input_schema.properties.rutEmpresa.description, /^RFC/)
  assert.match(programarSeguimientoSchemaPais("pe").input_schema.properties.cuandoIso.description, /default Perú\/America\/Lima/)
  assert.match(programarSeguimientoSchemaPais("mx").input_schema.properties.cuandoIso.description, /America\/Mexico_City/)
})

test("los adaptadores exponen el schema chileno de derivar_a_soporte y programar_seguimiento", async () => {
  const mods = {
    pe: (await import("../lib/paises/pe/tools-unificadas.ts")).TOOL_SCHEMAS_PE_UNIFICADAS,
    co: (await import("../lib/paises/co/tools-unificadas.ts")).TOOL_SCHEMAS_CO_UNIFICADAS,
    mx: (await import("../lib/paises/mx/tools-unificadas.ts")).TOOL_SCHEMAS_MX_UNIFICADAS,
  } as Record<string, Array<{ name: string }>>
  for (const [cc, schemas] of Object.entries(mods)) {
    assert.deepEqual(schemas.find((s) => s.name === "derivar_a_soporte"), derivarASoporteSchemaPais(cc), `${cc}: derivar_a_soporte`)
    assert.deepEqual(schemas.find((s) => s.name === "programar_seguimiento"), programarSeguimientoSchemaPais(cc), `${cc}: programar_seguimiento`)
  }
})

test("el CUÁNDO de la derivación se mide en la hora del país", () => {
  // 21:30Z de un jueves = 18:30 Chile (fuera de horario) · 16:30 Lima (hábil).
  const RealDate = Date
  const fija = RealDate.parse("2026-09-24T21:30:00Z")
  class F extends RealDate {
    constructor(...a: unknown[]) {
      // @ts-ignore
      if (a.length === 0) super(fija)
      // @ts-ignore
      else super(...a)
    }
  }
  // @ts-ignore
  globalThis.Date = F
  try {
    assert.match(derivarASoporte({ motivo: "fuera_de_rango_trabajadores", contexto: "x" }).mensajeSugeridoUsuario, /mañana en la mañana/)
    assert.match(derivarASoporte({ motivo: "fuera_de_rango_trabajadores", contexto: "x", _pais: "pe" }).mensajeSugeridoUsuario, /hoy mismo/)
  } finally {
    // @ts-ignore
    globalThis.Date = RealDate
  }
})
