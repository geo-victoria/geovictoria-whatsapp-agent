import { test } from "node:test"
import assert from "node:assert/strict"
import { nombreEquipoMX } from "../lib/paises/mx/nombre-equipo.ts"

test("México: 'reloj' a secas nunca sale (caso Rodrigo 24-sep)", () => {
  assert.equal(
    nombreEquipoMX("Perfecto, con app y reloj entonces. En qué ciudad estará el reloj?"),
    "Perfecto, con app y checador entonces. En qué ciudad estará el checador?",
  )
  assert.equal(
    nombreEquipoMX("El envío del reloj va incluido. El reloj es autoinstalable."),
    "El envío del checador va incluido. El checador es autoinstalable.",
  )
  assert.equal(nombreEquipoMX("Reloj checador en renta + App"), "Reloj checador en renta + App")
  assert.equal(nombreEquipoMX("Relojes para tus sucursales"), "Checadores para tus sucursales")
  assert.equal(nombreEquipoMX("un reloj control físico"), "un reloj checador")
  assert.equal(nombreEquipoMX("el reloj de control"), "el reloj checador")
})

test("no toca links ni ids", () => {
  const url = "https://cotizacion.geovictoria.com/pdf/assets/ficha-reloj-senseface.pdf"
  assert.equal(nombreEquipoMX(`Ficha del reloj: ${url}`), `Ficha del checador: ${url}`)
  assert.equal(nombreEquipoMX("id reloj_mx"), "id reloj_mx")
})
