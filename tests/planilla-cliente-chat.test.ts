import { test } from "node:test"
import assert from "node:assert/strict"
import { planillaClienteEnTexto } from "../lib/planilla-cliente-chat.ts"

const PALCO = "[El cliente envió un DOCUMENTO (PDF) por WhatsApp. Contenido del documento]: Planilla Excel adjunta — contenido transcrito fila por fila (columnas separadas por tab):\n\t1. Datos de empresa (Obligatorio)\n\tDATOS DE INGRESO EMPRESA\r\nObligatorios\n\tRazón Social (debe ser igual a SII)\tPalco Alto SPA\n\tNombre de fantasia (Opcional)\tPalco Alto SPA\n\tRUT (ejemplo 729870459)\t785056132\n\tGiro\tCafetería\n\tDirección\tAvenida Andalué 1155\n\tComuna\tSan Pedro de la Paz\n\tRubro\t22. Turismo, Hotelería y Gastronomía\n\t2. Datos del Administrador (Obligatorio)\n\tDATOS ADMINISTRADOR SISTEMA\r\nObligatorios\n\tN°\tNombre\tApellido\tRUT\tTeléfono Contacto\tCorreo\n\t1\tJosé\tPavez\t141356399\t977699585\tcontactolietta@gmail.com\n\t2\tXimena\tPalacios\t153317593\t979595135\tcontactolietta@gmail.com\n\t3\n\t4\n\t2. Datos de los usuarios"

test("planilla de ingreso del cliente (caso Palco Alto 02-oct)", () => {
  const p = planillaClienteEnTexto(PALCO)!
  assert.equal(p.razonSocial, "Palco Alto SPA")
  assert.equal(p.rut, "785056132")
  assert.equal(p.giro, "Cafetería")
  assert.equal(p.direccion, "Avenida Andalué 1155")
  assert.equal(p.comuna, "San Pedro de la Paz")
  assert.equal(p.rubro, "22. Turismo, Hotelería y Gastronomía")
  assert.equal(p.admins.length, 2)
  assert.deepEqual(p.admins[1], { nombre: "Ximena", apellido: "Palacios", rut: "153317593", telefono: "979595135", correo: "contactolietta@gmail.com" })
})

test("un texto cualquiera no es planilla", () => {
  assert.equal(planillaClienteEnTexto("hola, somos 8 en una cafetería"), null)
})
