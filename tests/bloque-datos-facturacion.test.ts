import { test } from "node:test"
import assert from "node:assert/strict"
import { bloqueDatosFacturacion } from "../lib/solicitud-facturacion-payload.ts"

test("bloque completo en la forma que administración acepta (calle + comuna + correo)", () => {
  const { texto, faltantes } = bloqueDatosFacturacion({
    razonSocial: "PANADERÍA Y PASTELERÍA OMAR HERNANDEZ SOTOMAYOR E.I.R.L.",
    documento: "78049852-8",
    giro: "ELABORACION DE PRODUCTOS DE PANADERIA Y PASTELERIA",
    direccion: "A NIELSEN 2031 PLAYA BRAVA",
    comuna: "IQUIQUE",
    correo: "lucieateliercontacto@gmail.com",
    telefono: "+56953340176",
  })
  assert.deepEqual(faltantes, [])
  assert.match(texto, /^DATOS DE FACTURACIÓN/)
  assert.match(texto, /Dirección: A NIELSEN 2031 PLAYA BRAVA/)
  assert.match(texto, /Correo DTE: lucieateliercontacto@gmail.com/)
})

test("lo que falta sale 'por confirmar' y se nombra (caso Food Flow sin calle)", () => {
  const { texto, faltantes } = bloqueDatosFacturacion({ razonSocial: "FOOD FLOW SPA", documento: "78133807-9", comuna: "Ñuñoa" })
  assert.ok(faltantes.includes("dirección (calle y número)"))
  assert.ok(faltantes.includes("correo DTE"))
  assert.match(texto, /Dirección: por confirmar/)
})
