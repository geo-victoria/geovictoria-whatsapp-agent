/**
 * REGLA DE PRECIO (Lalo, 05-ago): Vacaciones y Permisos vale EXACTAMENTE el
 * 50% de Control de Asistencia, tramo por tramo y con la misma modalidad.
 *
 * CICATRIZ (03-sep): el 16-ago asistencia 21-30 bajó de 0,065 a 0,055 para que
 * la escalera dejara de subir entre 20 y 21 usuarios — pero el tier espejo de
 * Vacaciones no se movió con ella y quedó en 0,0325, un 18% caro justo en ese
 * tramo. No lo vio nadie porque Vicky no cotiza sobre 20 ni ofrece Vacaciones
 * proactivamente; salía impreso en la NOTA DE VENTA, que muestra la escalera
 * completa. Este test hace imposible repetirlo: cambiar asistencia sin mover
 * vacaciones rompe la suite.
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { CATALOGO_MODULOS } from "../lib/catalogo/modulos.ts"

const porId = (id: string) => {
  const m = CATALOGO_MODULOS.find((x) => x.id === id)
  assert.ok(m, `falta el módulo ${id}`)
  return m!
}

describe("Vacaciones es el espejo exacto al 50% de Asistencia", () => {
  const asistencia = porId("asistencia")
  const vacaciones = porId("vacaciones")

  test("cada tramo de vacaciones vale la mitad del de asistencia", () => {
    for (const v of vacaciones.tiers) {
      const a = asistencia.tiers.find(
        (x) => x.minUsuarios === v.minUsuarios && x.maxUsuarios === v.maxUsuarios,
      )
      assert.ok(a, `asistencia no tiene el tramo ${v.minUsuarios}-${v.maxUsuarios}`)
      assert.equal(
        Number(v.precioUF.toFixed(6)),
        Number((a!.precioUF / 2).toFixed(6)),
        `tramo ${v.minUsuarios}-${v.maxUsuarios}: vacaciones ${v.precioUF} debería ser ${a!.precioUF / 2}`,
      )
      assert.equal(v.modalidad, a!.modalidad, `tramo ${v.minUsuarios}-${v.maxUsuarios}: modalidad distinta`)
    }
  })

  test("la escalera SMB (hasta 50) nunca sube al crecer de tramo", () => {
    // Lo que motivó el ajuste del 16-ago: pasar de 20 a 21 usuarios no puede
    // encarecer el precio unitario.
    //
    // El chequeo llega hasta 50 A PROPÓSITO. En 51 la escalera SÍ sube (0,055
    // → 0,065) porque ahí se pegan DOS LISTAS distintas: 1-50 son los precios
    // SMB de Vicky y 51+ son los de la calculadora de Nacho (parche interino
    // del 10-ago). No es un descuido de este catálogo y corregirlo es decisión
    // comercial, no técnica: se resuelve cuando la Cotizadora de Ejecutivos
    // tenga su motor propio con la lista de Nacho completa.
    const porUsuario = asistencia.tiers.filter((t) => t.modalidad === "por_usuario" && t.maxUsuarios <= 50)
    for (let i = 1; i < porUsuario.length; i++) {
      const prev = porUsuario[i - 1]
      const act = porUsuario[i]
      assert.ok(
        act.precioUF <= prev.precioUF,
        `tramo ${act.minUsuarios}-${act.maxUsuarios} (${act.precioUF}) es MÁS CARO que el anterior (${prev.precioUF})`,
      )
    }
  })
})
