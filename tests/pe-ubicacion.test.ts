import test from "node:test"
import assert from "node:assert/strict"
import { clasificarUbicacionPE } from "../lib/paises/pe/catalogo.ts"
import { errorUbicacionPE } from "../lib/paises/pe/tools-unificadas.ts"

// Caso real (Rodrigo, 22-sep): "reloj para casa matriz" → el adaptador
// deducía "provincias" y cotizaba sin preguntar dónde. Chile se niega con el
// mismo texto; Perú tiene que hacer lo mismo.
test("casa matriz / oficina / sede NO son ubicaciones: la tool se niega y pide la ciudad", () => {
  for (const u of ["casa matriz", "la oficina central", "sucursal", "nuestra sede", "planta"]) {
    assert.equal(clasificarUbicacionPE(u).tipo, "no_clasificable", u)
    assert.equal(clasificarUbicacionPE(u, "provincias").tipo, "no_clasificable", `${u} con zona explícita`)
  }
  const err = errorUbicacionPE([{ id: "reloj_pe", modalidad: "arriendo", cantidad: 1 }], [{ ubicacion: "casa matriz" }])
  assert.ok(err && /distrito|ciudad/.test(err), err || "sin error")
})

test("Lima, Callao y sus distritos → lima; departamentos y ciudades → provincias", () => {
  assert.equal(clasificarUbicacionPE("Lima").tipo, "lima")
  assert.equal(clasificarUbicacionPE("Callao").tipo, "lima")
  assert.equal(clasificarUbicacionPE("Breña").tipo, "lima")
  assert.equal(clasificarUbicacionPE("San Isidro, Lima").tipo, "lima")
  assert.equal(clasificarUbicacionPE("Piura").tipo, "provincias")
  assert.equal(clasificarUbicacionPE("Cusco").tipo, "provincias")
  assert.equal(clasificarUbicacionPE("Trujillo, La Libertad").tipo, "provincias")
  assert.equal(clasificarUbicacionPE("Arequipa").tipo, "provincias")
})

test("ciudad chica fuera del catálogo pasa SOLO con zona explícita del modelo", () => {
  assert.equal(clasificarUbicacionPE("Chulucanas").tipo, "no_clasificable")
  assert.equal(clasificarUbicacionPE("Chulucanas", "provincias").tipo, "provincias")
})

test("sin reloj no hay guarda; con reloj y sin puntos se niega", () => {
  assert.equal(errorUbicacionPE(undefined, undefined), null)
  assert.equal(errorUbicacionPE([], [{ ubicacion: "casa matriz" }]), null)
  assert.ok(errorUbicacionPE([{ id: "reloj_pe", modalidad: "arriendo", cantidad: 1 }], []))
  assert.equal(errorUbicacionPE([{ id: "reloj_pe", modalidad: "arriendo", cantidad: 1 }], [{ ubicacion: "Piura" }]), null)
})
