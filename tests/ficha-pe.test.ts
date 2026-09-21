/**
 * FICHA DE PERÚ sobre el núcleo (21-sep): el prompt que Perú recibe del
 * núcleo NO puede arrastrar Chile (documento, moneda, impuesto, geografía,
 * catálogo, normativa, agenda), y toda tool que el núcleo nombra tiene que
 * existir en el set único de Perú (con motor real o respuesta honesta).
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { promptBasePENucleo, formatCatalogoParaPromptPE } from "../lib/paises/pe/prompt-nucleo.ts"
import { textoNucleo } from "../lib/prompt-nucleo/texto.ts"
import { FICHA_PE } from "../lib/paises/pe/ficha.ts"
import {
  TOOL_SCHEMAS_PE_UNIFICADAS,
  aInputCotizarPE,
  zonaDeUbicacionPE,
  relojDeHardwarePE,
} from "../lib/paises/pe/tools-unificadas.ts"

const PROHIBIDOS: Array<[string, RegExp]> = [
  ["UF (moneda chilena)", /\bUF\b/],
  ["CLP", /\bCLP\b/],
  ["IVA", /\bIVA\b/],
  ["RUT (documento chileno)", /\bRUT\b/],
  ["SII", /\bSII\b/],
  ["comuna", /\bcomunas?\b/i],
  ["Región Metropolitana / RM", /\bRegi[oó]n Metropolitana\b|\bRM\b/],
  ["chileno/a (salvo el hecho \"empresa chilena\")", /(?<!empresa )chilen[oa]s?\b/i],
  ["Dirección del Trabajo / DT", /Direcci[oó]n del Trabajo|\bDT\b/],
  ["Resolución Exenta N°38", /Resoluci[oó]n Exenta/i],
  ["artículo 22 (Código del Trabajo CL)", /art(?:[ií]culo)?\.?\s*22\b/i],
  ["ids de hardware chileno", /senseface_2a|uru4500|kit_qr|tarjeta_id|impresora_termica/],
  ["Cal.com", /Cal\.com/i],
  ["Los Leones (bodega CL)", /Los Leones/],
  ["peso chileno $", /\$\s?\d{2,3}\.\d{3}/],
]

function lineasQueMatchean(texto: string, re: RegExp): string[] {
  return texto
    .split("\n")
    .filter((l) => re.test(l))
    .slice(0, 3)
    .map((l) => l.trim().slice(0, 140))
}

test("el prompt de Perú armado desde el núcleo no arrastra Chile", () => {
  const prompt = promptBasePENucleo()
  assert.ok(prompt.length > 100_000, `prompt PE demasiado corto: ${prompt.length}`)
  const fallas: string[] = []
  for (const [nombre, re] of PROHIBIDOS) {
    const hits = lineasQueMatchean(prompt, re)
    if (hits.length) fallas.push(`${nombre}:\n    ${hits.join("\n    ")}`)
  }
  assert.equal(fallas.length, 0, `Chilenismos en el render PE:\n${fallas.join("\n")}`)
  // Lo peruano SÍ está.
  assert.match(prompt, /\bRUC\b/)
  assert.match(prompt, /\bIGV\b/)
  assert.match(prompt, /\bdistrito\b/i)
  assert.match(prompt, /reloj_pe/)
})

test("el catálogo PE del prompt no enuncia montos (la tool es la única fuente)", () => {
  const cat = formatCatalogoParaPromptPE()
  assert.doesNotMatch(cat, /S\/\s?\d/)
  assert.doesNotMatch(cat, /\bUF\b/)
  assert.match(cat, /reloj_pe/)
  assert.match(cat, /asistencia/)
})

test("toda tool que el núcleo o la ficha PE nombran existe en el set único de Perú", () => {
  const texto = textoNucleo(FICHA_PE, "")
  const nombres = new Set(TOOL_SCHEMAS_PE_UNIFICADAS.map((t) => t.name))
  const mencionadas = new Set(
    (texto.match(/\b[a-z]+(?:_[a-z]+){1,4}\b/g) || []).filter((n) =>
      /^(cotizar|consultar|generar|derivar|agendar|reagendar|registrar|enviar|marcar|programar|reenviar|aplicar|actualizar|anualizar)_/.test(n),
    ),
  )
  assert.ok(mencionadas.size >= 12, `pocas tools detectadas en el núcleo: ${[...mencionadas].join(", ")}`)
  const faltan = [...mencionadas].filter((n) => !nombres.has(n))
  assert.deepEqual(faltan, [], `tools nombradas sin schema en PE: ${faltan.join(", ")}`)
  // Sin duplicados en el set.
  assert.equal(nombres.size, TOOL_SCHEMAS_PE_UNIFICADAS.length)
})

test("forma chilena → motor peruano: hardware, zona y autoinstalación", () => {
  assert.equal(zonaDeUbicacionPE("Miraflores"), "lima")
  assert.equal(zonaDeUbicacionPE("Callao"), "lima")
  assert.equal(zonaDeUbicacionPE("San Juan de Lurigancho"), "lima")
  assert.equal(zonaDeUbicacionPE("Piura"), "provincias")
  assert.equal(zonaDeUbicacionPE("Arequipa"), "provincias")
  assert.deepEqual(relojDeHardwarePE([{ id: "reloj_pe" }]), { modalidad: "arriendo", cantidad: 1 })
  assert.deepEqual(relojDeHardwarePE([{ id: "reloj_pe", cantidad: 2, modalidad: "venta" }]), { modalidad: "venta", cantidad: 2 })
  assert.equal(relojDeHardwarePE([]), undefined)
  const out = aInputCotizarPE({
    userCount: 15,
    hardware: [{ id: "reloj_pe", cantidad: 1 }],
    puntosInstalacion: [{ ubicacion: "Piura" }],
    escalonDescuento: 1,
  })
  assert.deepEqual(out, {
    userCount: 15,
    reloj: { modalidad: "arriendo", cantidad: 1 },
    puntosInstalacion: [{ ubicacion: "Piura", zona: "provincias", autoInstalada: true }],
    escalonDescuento: 1,
  })
  // Sin reloj ni puntos ni escalón: solo la dotación (nada inventado).
  assert.deepEqual(aInputCotizarPE({ userCount: 8 }), { userCount: 8 })
})
