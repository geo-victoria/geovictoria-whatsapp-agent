import { test } from "node:test"
import assert from "node:assert/strict"
import { armarPlanillaIngreso, rutSinFormato, rubroDeLista, nombreArchivoPlanilla, telefonoPlanilla } from "../lib/planilla-ingreso.ts"
import { descomprimirZip } from "../lib/leer-excel.ts"
import { PLANTILLA_INGRESO_XLSX_BASE64 } from "../lib/planilla-ingreso-base.ts"

test("formatos de la planilla manual: RUT sin puntos ni guión, teléfono a 9 dígitos, rubro de la lista", () => {
  assert.equal(rutSinFormato("15.123.456-k"), "15123456K")
  assert.equal(rutSinFormato("17.739.019-4"), "177390194")
  assert.equal(telefonoPlanilla("56920363400"), "920363400")
  assert.equal(rubroDeLista("Construcción"), "3. Construcción")
  assert.equal(rubroDeLista("salud"), "19. Salud")
  assert.equal(rubroDeLista("algo raro"), "")
  assert.equal(nombreArchivoPlanilla("Empresa / SpA", 2), "Planilla sin planificacion Empresa SpA (2 usuarios).xlsx")
})

test("rellena empresa, administrador y trabajadores en las celdas de la plantilla", () => {
  const r = armarPlanillaIngreso({
    razonSocial: "ACME SPA", rut: "76.123.456-0", giro: "SERVICIOS", direccion: "CALLE 1", comuna: "SANTIAGO",
    admins: [{ nombre: "Ana", apellido: "Pérez", rut: "15.123.456-K", telefono: "56911111111", correo: "ana@acme.cl" }],
    trabajadores: [
      { rut: "15.123.456-K", correo: "ana.p@gmail.com", nombres: "Ana", apellidos: "Pérez", grupo: "Oficina" },
      { rut: "17.739.019-4", correo: "karla@gmail.com", nombres: "Karla", apellidos: "Caballero", grupo: "Terreno" },
    ],
  })
  assert.equal(r.usuarios, 2)
  assert.equal(r.filename, "Planilla sin planificacion ACME SPA (2 usuarios).xlsx")
  const xml = descomprimirZip(r.buffer).get("xl/worksheets/sheet1.xml")!.toString("utf8")
  assert.match(xml, /<c r="C14"[^>]*t="inlineStr"><is><t xml:space="preserve">ACME SPA<\/t>/)
  assert.match(xml, /<c r="C16"[^>]*><v>761234560<\/v>/)
  assert.match(xml, /<c r="E29"[^>]*t="inlineStr"><is><t xml:space="preserve">15123456K</)
  assert.match(xml, /<c r="B40" s="36" t="inlineStr"><is><t xml:space="preserve">Administrador</)
  assert.match(xml, /<c r="C41" s="32"><v>177390194<\/v>/)
})

test("la plantilla base no trae datos de ningún cliente", () => {
  const partes = descomprimirZip(Buffer.from(PLANTILLA_INGRESO_XLSX_BASE64, "base64"))
  const todo = [...partes.values()].map((b) => b.toString("utf8")).join("")
  for (const x of ["Dolce", "Mattarello", "lafuentereina", "78259205", "Roa Romero"]) assert.ok(!todo.includes(x), x)
  assert.ok(partes.has("xl/media/image1.png"))
})
