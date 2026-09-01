import { test } from "node:test"
import assert from "node:assert/strict"
import { etiquetaOpcionDescuento } from "../lib/tools/etiqueta-opcion.ts"

// ETIQUETA DE OPCIÓN EN EL DESCUENTO (31-ago, prueba de Rodrigo): el 10% se
// calculó sobre reloj+app cuando el cliente eligió solo app, y el mensaje no
// decía sobre qué opción era. Réplica de las DOS llamadas de esa conversación
// con la misma lógica que hoy pega la etiqueta al mensajeParaProspecto.

const nombreDe = (id: string) => (id === "senseface_2a" ? "Reloj control físico" : null)

test("solo app (la opción que el cliente eligió): la etiqueta lo dice y no menciona reloj", () => {
  const { etiqueta } = etiquetaOpcionDescuento(18, [], nombreDe)
  assert.equal(etiqueta, "(Este valor es para la opción: App móvil para 18 personas.)")
  assert.doesNotMatch(etiqueta, /Reloj/)
})

test("reloj+app (la opción que el modelo pasó por error): la etiqueta delata el reloj", () => {
  const { etiqueta } = etiquetaOpcionDescuento(
    18,
    [{ id: "senseface_2a", cantidad: 1, modalidad: "arriendo" }],
    nombreDe,
  )
  assert.equal(
    etiqueta,
    "(Este valor es para la opción: App móvil para 18 personas + Reloj control físico en arriendo.)",
  )
})

test("compra y cantidades también se nombran", () => {
  const { etiqueta } = etiquetaOpcionDescuento(12, [{ id: "senseface_2a", cantidad: 2, modalidad: "venta" }], nombreDe)
  assert.match(etiqueta, /Reloj control físico en compra ×2/)
})

test("hardware desconocido cae al id, jamás revienta", () => {
  const { opcion } = etiquetaOpcionDescuento(5, [{ id: "raro_x" }], nombreDe)
  assert.match(opcion, /raro_x en arriendo/)
})
