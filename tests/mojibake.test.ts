import { test } from "node:test"
import assert from "node:assert/strict"
import { repararMojibake, pareceMojibake, repararCampos } from "../lib/mojibake.ts"

// Cadenas REALES leídas de Zoho/Creator el 14-sep (padrón SII con la
// codificación rota). El U+008D es el carácter de control que colgó el
// generador de PDF de la NDV-31863.
const COTEL = "COOPERATIVA DE SERVICIOS DE TELECOMUNICACIONES Y TECNOLOGÃA LIMITADA"

test("la Í doblemente codificada vuelve a ser Í (caso COTEL)", () => {
  assert.equal(pareceMojibake(COTEL), true)
  assert.equal(repararMojibake(COTEL), "COOPERATIVA DE SERVICIOS DE TELECOMUNICACIONES Y TECNOLOGÍA LIMITADA")
})

test("Ó, Ñ, Á, É y Ú: las razones sociales del catastro del 14-sep", () => {
  const casos: Array<[string, string]> = [
    ["PANADERÃA Y PASTELERÃA OMAR HERNANDEZ", "PANADERÍA Y PASTELERÍA OMAR HERNANDEZ"],
    ["SOLDADURA Y FABRICACIÃN DE ESTRUCTURAS IVÃN", "SOLDADURA Y FABRICACIÓN DE ESTRUCTURAS IVÁN"],
    ["SERVICIOS VETERINARIOS PATIÃO JARAMILLO", "SERVICIOS VETERINARIOS PATIÑO JARAMILLO"],
    ["NEUMÃTICOS COFRÃ SPA", "NEUMÁTICOS COFRÉ SPA"],
    ["LEONARDO ZÃÃIGA MIQUELIN", "LEONARDO ZÚÑIGA MIQUELIN"],
    ["CGO ADMINISTRACIÃN SPA", "CGO ADMINISTRACIÓN SPA"],
  ]
  for (const [roto, bueno] of casos) assert.equal(repararMojibake(roto), bueno, roto)
})

test("un texto sano pasa intacto, tilde incluida", () => {
  for (const s of ["TECNOLOGÍA LIMITADA", "Montecosta Travel Spa", "Señor Ñuñoa Ó", "Panaderia y Pasteleria Omar Hernandez", ""]) {
    assert.equal(pareceMojibake(s), false, s)
    assert.equal(repararMojibake(s), s)
  }
})

test("la variante cp1252 (é → Ã©) también se repara", () => {
  assert.equal(repararMojibake("Navegación AÃ©rea"), "Navegación Aérea")
})

test("lo que no calza con la firma no se toca", () => {
  // Ã seguida de un espacio o de una letra no es una pareja rota.
  for (const s of ["X Ã Y", "ÃANGEL", "ÃREA"]) assert.equal(repararMojibake(s), s, s)
  // Â + U+0081 decodifica a un control C1: eso no es una reparación y se deja.
  const control = "AÂB"
  assert.equal(repararMojibake(control), control)
})

test("una cadena mezclada se repara solo en el tramo roto", () => {
  assert.equal(repararMojibake("Navegación AÃ©rea"), "Navegación Aérea")
  assert.equal(repararMojibake("Ñuñoa ÃUÑOA"), "Ñuñoa ÑUÑOA")
})

test("repararCampos toca solo los strings de una ficha", () => {
  const f = repararCampos({ rut: "65213303-7", razonSocial: COTEL, vigente: true, giro: "OTRAS ACTIVIDADES", n: 3 })
  assert.equal(f.razonSocial, "COOPERATIVA DE SERVICIOS DE TELECOMUNICACIONES Y TECNOLOGÍA LIMITADA")
  assert.equal(f.giro, "OTRAS ACTIVIDADES")
  assert.equal(f.vigente, true)
  assert.equal(f.n, 3)
})
