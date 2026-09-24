/**
 * FICHA DE MÉXICO sobre el núcleo (24-sep): el prompt que México recibe del
 * núcleo NO puede arrastrar Chile, Perú ni Colombia, y toda tool que el
 * núcleo nombra tiene que existir en el set único de México.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { promptBaseMXNucleo, formatCatalogoParaPromptMX } from "../lib/paises/mx/prompt-nucleo.ts"
import { textoNucleo } from "../lib/prompt-nucleo/texto.ts"
import { FICHA_MX } from "../lib/paises/mx/ficha.ts"
import { TOOL_SCHEMAS_MX_UNIFICADAS, aInputCotizarMX, relojDeHardwareMX } from "../lib/paises/mx/tools-unificadas.ts"

const PROHIBIDOS: Array<[string, RegExp]> = [
  ["UF (moneda chilena)", /\bUF\b/],
  ["CLP", /\bCLP\b/],
  ["COP / pesos colombianos", /\bCOP\b|pesos colombianos/],
  ["IGV / soles (Perú)", /\bIGV\b|\bsoles\b|\bS\/\s?\d/],
  ["RUT (documento chileno)", /\bRUT\b/],
  ["RUC (Perú)", /\bRUC\b/],
  ["NIT (Colombia)", /\bNIT\b/],
  ["SII", /\bSII\b/],
  ["comuna", /\bcomunas?\b/i],
  ["Región Metropolitana / RM", /\bRegi[oó]n Metropolitana\b|\bRM\b/],
  ["chileno/a (salvo el hecho \"empresa chilena\")", /(?<!empresa )chilen[oa]s?\b/i],
  ["Dirección del Trabajo / DT", /Direcci[oó]n del Trabajo|\bDT\b/],
  ["Resolución Exenta N°38", /Resoluci[oó]n Exenta/i],
  ["SUNAFIL / Ministerio del Trabajo", /SUNAFIL|Ministerio del Trabajo/],
  ["ids de hardware de otros países", /senseface_2a|uru4500|kit_qr|tarjeta_id|impresora_termica|reloj_pe|reloj_co/],
  ["Cal.com", /Cal\.com/i],
  ["Los Leones (bodega CL)", /Los Leones/],
  ["reloj control (chilenismo; salvo la lista negra)", /(?<!JAMÁS ")reloj control\b/i],
]

function lineasQueMatchean(texto: string, re: RegExp): string[] {
  return texto.split("\n").filter((l) => re.test(l)).slice(0, 3).map((l) => l.trim().slice(0, 140))
}

test("el prompt de México armado desde el núcleo no arrastra otros países", () => {
  const prompt = promptBaseMXNucleo()
  assert.ok(prompt.length > 100_000, `prompt MX demasiado corto: ${prompt.length}`)
  const fallas: string[] = []
  for (const [nombre, re] of PROHIBIDOS) {
    const hits = lineasQueMatchean(prompt, re)
    if (hits.length) fallas.push(`${nombre}:\n    ${hits.join("\n    ")}`)
  }
  assert.equal(fallas.length, 0, `Restos de otro país en el render MX:\n${fallas.join("\n")}`)
  assert.match(prompt, /\bRFC\b/)
  assert.match(prompt, /reloj checador/)
  assert.match(prompt, /reloj_mx/)
  assert.match(prompt, /STPS/)
})

test("el catálogo MX del prompt no enuncia montos", () => {
  const cat = formatCatalogoParaPromptMX()
  assert.doesNotMatch(cat, /\$\s?\d/)
  assert.match(cat, /reloj_mx/)
  assert.match(cat, /hasta 15 personas/)
})

test("toda tool que el núcleo nombra existe en el set único de México", () => {
  const texto = textoNucleo(FICHA_MX, "")
  const nombres = new Set(TOOL_SCHEMAS_MX_UNIFICADAS.map((t) => t.name))
  const mencionadas = new Set(
    (texto.match(/\b[a-z]+(?:_[a-z]+){1,4}\b/g) || []).filter((n) =>
      /^(cotizar|consultar|generar|derivar|agendar|reagendar|registrar|enviar|marcar|programar|reenviar|aplicar|actualizar|anualizar)_/.test(n),
    ),
  )
  assert.ok(mencionadas.size >= 12)
  const faltan = [...mencionadas].filter((n) => !nombres.has(n))
  assert.deepEqual(faltan, [], `tools nombradas sin schema en MX: ${faltan.join(", ")}`)
  assert.equal(nombres.size, TOOL_SCHEMAS_MX_UNIFICADAS.length)
})

test("forma chilena → motor mexicano: reloj y puntos (renta por defecto, auto-instalación)", () => {
  assert.deepEqual(relojDeHardwareMX([{ id: "reloj_mx" }]), { modalidad: "arriendo", cantidad: 1 })
  assert.deepEqual(aInputCotizarMX({ userCount: 12, hardware: [{ id: "reloj_mx" }], puntosInstalacion: [{ ubicacion: "Coyoacán" }] }), {
    userCount: 12,
    reloj: { modalidad: "arriendo", cantidad: 1 },
    puntosInstalacion: [{ ubicacion: "Coyoacán", autoInstalada: true }],
  })
  assert.deepEqual(aInputCotizarMX({ userCount: 8 }), { userCount: 8 })
})

test("descuento MX = Chile (Lalo 24-sep) y la formal exige razón social (sin padrón en México)", () => {
  const porNombre = new Map(TOOL_SCHEMAS_MX_UNIFICADAS.map((t) => [t.name, t]))
  for (const n of ["cotizar_referencial", "consultar_descuento_referencial", "consultar_siguiente_descuento", "aplicar_siguiente_descuento", "generar_link_cotizadora"]) {
    const t = porNombre.get(n)
    assert.ok(t, n)
    assert.doesNotMatch(t!.description, /NO hay (escalera de )?descuento|No existe descuento/i, n)
  }
  const link = porNombre.get("generar_link_cotizadora")!.input_schema as { required: string[]; properties: Record<string, unknown> }
  assert.ok(link.required.includes("empresa"))
  assert.ok(!link.required.includes("contactoEmail"))
  assert.ok("escalonDescuento" in link.properties)
  const texto = textoNucleo(FICHA_MX, "")
  assert.match(texto, /10 % → 20 %/)
  assert.match(texto, /RFC \+ razón social \+ email/)
})

test("MX: la tool cotizar_referencial declara el umbral vivo, no 50", async () => {
  const { armarPromptBase } = await import("../lib/prompt-nucleo/armar.ts")
  const t20 = armarPromptBase(FICHA_MX, "(catalogo)", 20)
  assert.match(t20, /Solo funciona para 1-20 trabajadores/)
  assert.doesNotMatch(t20, /1-50 personas/)
})
