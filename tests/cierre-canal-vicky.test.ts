/**
 * EL CIERRE DE VICKY CUENTA SOLO LAS VENTAS DE VICKY (04-sep).
 *
 * `venta_dash_v3_` es la Caja del dash y ahí caen los DOS canales. El 03-sep
 * hubo 7 pagos y solo UNO era de Vicky (los otros seis los cerraron Grey,
 * Anderson y Ana López desde la cotizadora). El correo se llama "cierre de
 * Vicky" y reportaba los 7 — sobre esa foto contaminada se discutió media
 * mañana si la caída de ventas era real. El discriminador oficial es
 * `Intervenci_n_Humana`, el mismo que usa el correo de PAGADA del cotizador.
 *
 * Inspección: el endpoint arrastra Supabase y Zoho.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const FUENTE = readFileSync("app/api/vic-cierre-diario/route.ts", "utf8")

test("la foto separa canal Vicky de canal ejecutivo", () => {
  assert.ok(FUENTE.includes("ventasEjecutivo"), "el canal ejecutivo se cuenta aparte")
  assert.ok(FUENTE.includes("montoVentasEjecutivo"), "y su monto también")
  assert.ok(
    /const esVicky = .*startsWith\("100%"\)/.test(FUENTE),
    "el discriminador es Intervenci_n_Humana ('100% Vicky')",
  )
})

test("el KPI principal usa SOLO las ventas de Vicky", () => {
  assert.ok(
    /ventas: deVicky\.map/.test(FUENTE),
    "el arreglo `ventas` de la foto debe traer solo las de Vicky",
  )
  assert.ok(
    /montoVentas: deVicky\.reduce/.test(FUENTE),
    "el monto principal debe sumar solo las de Vicky",
  )
})

test("una venta sin clasificar nunca se atribuye a Vicky", () => {
  assert.ok(FUENTE.includes("ventasSinClasificar"), "se cuentan aparte")
  assert.ok(
    /clasificadas = ventas\.filter\(\(v\) => String\(v\.canal \|\| ""\)\.trim\(\) !== ""\)/.test(FUENTE),
    "sin canal conocido, la venta queda fuera de ambos grupos",
  )
  assert.ok(
    /sin clasificar por canal/.test(FUENTE),
    "y el correo lo declara en vez de callarlo",
  )
})

test("la consulta a Zoho pide el campo del canal", () => {
  assert.ok(
    /select Numero_Cotizacion, Owner\.first_name, Owner\.last_name, Intervenci_n_Humana/.test(FUENTE),
    "sin el campo en el select no hay clasificación posible",
  )
})
