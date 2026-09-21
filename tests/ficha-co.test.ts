/**
 * FICHA DE COLOMBIA sobre el núcleo (21-sep): el prompt que Colombia recibe
 * del núcleo NO puede arrastrar Chile ni Perú, y toda tool que el núcleo
 * nombra tiene que existir en el set único de Colombia.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { promptBaseCONucleo, formatCatalogoParaPromptCO } from "../lib/paises/co/prompt-nucleo.ts"
import { textoNucleo } from "../lib/prompt-nucleo/texto.ts"
import { FICHA_CO } from "../lib/paises/co/ficha.ts"
import { TOOL_SCHEMAS_CO_UNIFICADAS, aInputCotizarCO, relojDeHardwareCO } from "../lib/paises/co/tools-unificadas.ts"

const PROHIBIDOS: Array<[string, RegExp]> = [
  ["UF (moneda chilena)", /\bUF\b/],
  ["CLP", /\bCLP\b/],
  ["IGV / soles (Perú)", /\bIGV\b|\bsoles\b|\bS\/\s?\d/],
  ["RUT (documento chileno)", /\bRUT\b/],
  ["RUC (Perú)", /\bRUC\b/],
  ["SII", /\bSII\b/],
  ["comuna", /\bcomunas?\b/i],
  ["Región Metropolitana / RM", /\bRegi[oó]n Metropolitana\b|\bRM\b/],
  ["chileno/a (salvo el hecho \"empresa chilena\")", /(?<!empresa )chilen[oa]s?\b/i],
  ["Dirección del Trabajo / DT", /Direcci[oó]n del Trabajo|\bDT\b/],
  ["Resolución Exenta N°38", /Resoluci[oó]n Exenta/i],
  ["SUNAFIL (Perú)", /SUNAFIL/],
  ["ids de hardware chileno", /senseface_2a|uru4500|kit_qr|tarjeta_id|impresora_termica|reloj_pe/],
  ["Cal.com", /Cal\.com/i],
  ["Los Leones (bodega CL)", /Los Leones/],
]

function lineasQueMatchean(texto: string, re: RegExp): string[] {
  return texto.split("\n").filter((l) => re.test(l)).slice(0, 3).map((l) => l.trim().slice(0, 140))
}

test("el prompt de Colombia armado desde el núcleo no arrastra Chile ni Perú", () => {
  const prompt = promptBaseCONucleo()
  assert.ok(prompt.length > 100_000, `prompt CO demasiado corto: ${prompt.length}`)
  const fallas: string[] = []
  for (const [nombre, re] of PROHIBIDOS) {
    const hits = lineasQueMatchean(prompt, re)
    if (hits.length) fallas.push(`${nombre}:\n    ${hits.join("\n    ")}`)
  }
  assert.equal(fallas.length, 0, `Restos de otro país en el render CO:\n${fallas.join("\n")}`)
  assert.match(prompt, /\bNIT\b/)
  assert.match(prompt, /equipo biométrico/)
  assert.match(prompt, /reloj_co/)
  assert.match(prompt, /Ministerio del Trabajo/)
})

test("el catálogo CO del prompt no enuncia montos", () => {
  const cat = formatCatalogoParaPromptCO()
  assert.doesNotMatch(cat, /\$\s?\d/)
  assert.doesNotMatch(cat, /\bUF\b/)
  assert.match(cat, /reloj_co/)
})

test("toda tool que el núcleo nombra existe en el set único de Colombia", () => {
  const texto = textoNucleo(FICHA_CO, "")
  const nombres = new Set(TOOL_SCHEMAS_CO_UNIFICADAS.map((t) => t.name))
  const mencionadas = new Set(
    (texto.match(/\b[a-z]+(?:_[a-z]+){1,4}\b/g) || []).filter((n) =>
      /^(cotizar|consultar|generar|derivar|agendar|reagendar|registrar|enviar|marcar|programar|reenviar|aplicar|actualizar|anualizar)_/.test(n),
    ),
  )
  assert.ok(mencionadas.size >= 12)
  const faltan = [...mencionadas].filter((n) => !nombres.has(n))
  assert.deepEqual(faltan, [], `tools nombradas sin schema en CO: ${faltan.join(", ")}`)
  assert.equal(nombres.size, TOOL_SCHEMAS_CO_UNIFICADAS.length)
})

test("forma chilena → motor colombiano: hardware y puntos solo en venta", () => {
  assert.deepEqual(relojDeHardwareCO([{ id: "reloj_co" }]), { modalidad: "arriendo", cantidad: 1 })
  assert.deepEqual(relojDeHardwareCO([{ id: "reloj_co", cantidad: 2, modalidad: "venta" }]), { modalidad: "venta", cantidad: 2 })
  // En alquiler los puntos no viajan (envío e instalación gratis, la base no los necesita).
  assert.deepEqual(aInputCotizarCO({ userCount: 15, hardware: [{ id: "reloj_co" }], puntosInstalacion: [{ ubicacion: "Bogotá" }] }), {
    userCount: 15,
    reloj: { modalidad: "arriendo", cantidad: 1 },
  })
  assert.deepEqual(
    aInputCotizarCO({ userCount: 15, hardware: [{ id: "reloj_co", modalidad: "venta" }], puntosInstalacion: [{ ubicacion: "Neiva" }] }),
    { userCount: 15, reloj: { modalidad: "venta", cantidad: 1 }, puntosInstalacion: [{ ubicacion: "Neiva", autoInstalada: true }] },
  )
  assert.deepEqual(aInputCotizarCO({ userCount: 8 }), { userCount: 8 })
})
