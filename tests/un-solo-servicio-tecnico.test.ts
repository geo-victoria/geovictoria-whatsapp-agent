import { test } from "node:test"
import assert from "node:assert/strict"
import { omitirEnvioPorInstalacionTecnica, esInstalacionBonificada } from "../lib/catalogo/servicios.ts"

// CASO FRANCISCA (COT1443, 14-sep): reloj en arriendo en Las Condes con visita
// técnica. La cotización le mostraba "Envío de reloj" Y "Instalación de reloj",
// las dos en $0. Regla SSTT: el técnico lleva el equipo → el envío no va.
test("con visita técnica se omite el envío", () => {
  assert.equal(
    omitirEnvioPorInstalacionTecnica({
      autoInstalada: false,
      soloHardwareSinInstalacion: false,
      serviciosDelPunto: ["envio_reloj", "instalacion_reloj"],
    }),
    true,
  )
})

test("con auto-instalación el envío SÍ va: es el único servicio que ocurre", () => {
  assert.equal(
    omitirEnvioPorInstalacionTecnica({
      autoInstalada: true,
      soloHardwareSinInstalacion: false,
      serviciosDelPunto: ["envio_reloj", "instalacion_reloj"],
    }),
    false,
  )
})

test("hardware plug-and-play (huellero USB) conserva su envío", () => {
  assert.equal(
    omitirEnvioPorInstalacionTecnica({
      autoInstalada: false,
      soloHardwareSinInstalacion: true,
      serviciosDelPunto: ["envio_reloj", "instalacion_reloj"],
    }),
    false,
  )
})

test("sin instalación en el punto no hay nada que omitir", () => {
  assert.equal(
    omitirEnvioPorInstalacionTecnica({
      autoInstalada: false,
      soloHardwareSinInstalacion: false,
      serviciosDelPunto: ["envio_reloj"],
    }),
    false,
  )
})

test("la instalación bonificada de arriendo RM sigue intacta", () => {
  assert.equal(esInstalacionBonificada("arriendo", "RM"), true)
  assert.equal(esInstalacionBonificada("venta", "RM"), false)
})
