import { test } from "node:test"
import assert from "node:assert/strict"
import { revisarSalida } from "../lib/cinturones-salida.ts"
import { precioDeformado, mensajeCanonicoDe } from "../lib/precio-deformado.ts"
import { preguntasProhibidasEn } from "../lib/pregunta-prohibida.ts"
import { montosDe } from "../lib/precio-sin-tool.ts"

// El mensaje que la tool de Perú devolvió el 21-sep (doble valor, total con IGV
// ya incluido, sin aritmética).
const CANONICO_PE = `1 - Para 18 personas te recomiendo Reloj en arriendo + App:
💰 S/212.40 al mes, IGV incluido.
[---]
2.- Una alternativa más económica sería si marcan solo mediante nuestra app:
💰 S/116.82 al mes, IGV incluido.
[---]
Qué opción prefieres? Con la que elijas te genero la cotización formal de inmediato.`

// Lo que el modelo le mandó de verdad a Rodrigo, con el mismo build.
const DEFORMADO_PE = `Te comparto el detalle de tu cotización referencial (precios en soles):

Mensualidad del servicio:
- Control de Asistencia (18 usuarios): S/99/mes
- Arriendo de reloj de control: S/81/mes
Total mensual: S/180 + IGV (18%) = S/212.40/mes

Pago inicial (al aceptar):
- Primer mes del plan por adelantado: S/180`

test("el caso de Rodrigo: pierde el doble valor, agrega aritmética y un pago inicial", () => {
  const d = precioDeformado(DEFORMADO_PE, CANONICO_PE)
  assert.equal(d.deformado, true)
  assert.deepEqual(d.motivos.slice().sort(), ["aritmetica_impuesto", "pago_inicial_inventado", "perdio_doble_valor"])
})

test("el mensaje de la tool copiado tal cual no es deformación", () => {
  assert.equal(precioDeformado(CANONICO_PE, CANONICO_PE).deformado, false)
})

test("una apertura propia antes del bloque de la tool tampoco lo es", () => {
  const conSaludo = `Perfecto, Ro! Te dejo las dos opciones:\n\n${CANONICO_PE}`
  assert.equal(precioDeformado(conSaludo, CANONICO_PE).deformado, false)
})

test("con _descuentoAcordado el cinturón no opina (regla CL del 10-ago)", () => {
  const calls = [
    { name: "cotizar_referencial", ok: true, output: { mensajeParaProspecto: CANONICO_PE, _descuentoAcordado: { pct: 20 } } },
  ]
  assert.equal(mensajeCanonicoDe(calls), "")
})

test("veredicto: reemplazo por el texto de la tool", () => {
  const v = revisarSalida({
    reply: DEFORMADO_PE,
    toolCalls: [{ name: "cotizar_referencial", ok: true, output: { mensajeParaProspecto: CANONICO_PE } }],
    historialAsistente: [],
    pais: "pe",
  })
  assert.equal(v.accion, "reemplazo")
  assert.equal(v.reply, CANONICO_PE)
  assert.equal(v.cinturon, "precio_deformado")
})

test("preguntas que Chile retiró: las tres formas reales", () => {
  const ids = (t: string) => preguntasProhibidasEn(t).map((h) => h.id)
  assert.deepEqual(ids("Te consulto: prefieres el reloj en arriendo mensual o en compra? Y en qué ciudad está la casa matriz?"), ["modalidad_reloj"])
  assert.deepEqual(ids("Y la instalación del reloj en Piura, prefieres que nuestro servicio técnico la coordine contigo o la harías por tu cuenta?"), ["quien_instala"])
  assert.deepEqual(ids("En cuántos puntos marcarían?"), ["cuantos_puntos"])
  // La forma que se le escapó al patrón en la primera corrida con el cinturón desplegado (21-sep):
  assert.deepEqual(ids("Para dejarte el valor exacto, necesito confirmar: la casa matriz en Piura donde iría el reloj, ustedes lo instalarían o preferirían que nuestro servicio técnico coordine la instalación?"), ["quien_instala"])
})

test("informar sobre arriendo o instalación NO es preguntar", () => {
  assert.deepEqual(preguntasProhibidasEn("El arriendo incluye el envío sin costo, y la auto-instalación es gratis: te guiamos paso a paso."), [])
  assert.deepEqual(preguntasProhibidasEn("Te cotizo el reloj en arriendo, que es lo más conveniente. En qué distrito está la casa matriz?"), [])
})

test("el precio sin respaldo ahora también se caza en soles", () => {
  assert.ok(montosDe("son S/212.40 al mes").includes(212))
  assert.ok(montosDe("el plan queda en S/55").includes(55))
  const v = revisarSalida({ reply: "Te queda en S/240 al mes", toolCalls: [], historialAsistente: [], pais: "pe" })
  assert.equal(v.accion, "reintento")
  assert.equal(v.cinturon, "precio_sin_tool")
  assert.equal(v.siFallaReintento, "contener")
})

test("repetir un precio que Vicky ya dijo es legítimo", () => {
  const v = revisarSalida({
    reply: "Como te decía, quedan S/212.40 al mes",
    toolCalls: [],
    historialAsistente: ["Total: S/212.40 al mes, IGV incluido"],
    pais: "pe",
  })
  assert.equal(v.accion, "ok")
})

test("en onboarding estos cinturones no corren", () => {
  const v = revisarSalida({ reply: "Te queda en S/240 al mes", toolCalls: [], historialAsistente: [], pais: "pe", enOnboarding: true })
  assert.equal(v.accion, "ok")
})

// ── "actualizada" sin tool (21-sep, caso Lalo en Perú) ─────────────────────
test("anunciar 'ya actualicé tu cotización' sin tool de emisión pide reintento y contiene", () => {
  const v = revisarSalida({
    reply: "Perfecto! Ya actualicé tu cotización con 16 personas y solo app: https://cotizacion.geovictoria.com/q/abc-123",
    toolCalls: [{ name: "cotizar_referencial", ok: true, output: { mensajeParaProspecto: "" } }],
    historialAsistente: [],
    pais: "pe",
  })
  assert.equal(v.accion, "reintento")
  assert.equal(v.cinturon, "actualizada_sin_tool")
  assert.equal(v.siFallaReintento, "contener")
  assert.match(String(v.contencion), /Aún no tengo lista/)
})

test("con actualizar_cotizacion ok en el turno el anuncio pasa", () => {
  const v = revisarSalida({
    reply: "Listo!! Tu cotización quedó actualizada 🎉 (este link reemplaza al anterior)",
    toolCalls: [{ name: "actualizar_cotizacion", ok: true, output: { mensajeParaProspecto: "Listo!! Tu cotización quedó actualizada 🎉 (este link reemplaza al anterior)" } }],
    historialAsistente: [],
    pais: "pe",
  })
  assert.equal(v.accion, "ok")
})

test("aplicar_siguiente_descuento ok también respalda 'nueva versión'", () => {
  const v = revisarSalida({
    reply: "Te dejo la nueva versión de tu cotización con el 10 %.",
    toolCalls: [{ name: "aplicar_siguiente_descuento", ok: true, output: {} }],
    historialAsistente: [],
    pais: "cl",
  })
  assert.notEqual(v.cinturon, "actualizada_sin_tool")
})


// ── "descuento aplicado" sin tool (21-sep noche, E2E Perú en sitio) ────────
test("'ya quedó con el 10% aplicado' sin aplicar_siguiente_descuento → reintento con contención", () => {
  const v = revisarSalida({
    reply: "Perfecto, Diego! 🎉\n\nTu cotización ya quedó con el 10% de descuento aplicado. En el mismo link ya está actualizada con el nuevo precio: https://cotizacion.geovictoria.com/quote-acceptance.html?token=abc",
    toolCalls: [],
    historialAsistente: [],
    pais: "pe",
  })
  assert.equal(v.accion, "reintento")
  assert.equal(v.cinturon, "descuento_aplicado_sin_tool")
  assert.equal(v.siFallaReintento, "contener")
  assert.match(v.contencion || "", /Todavía no dejé aplicado el descuento/)
})

test("el mismo anuncio CON aplicar_siguiente_descuento ok pasa", () => {
  const v = revisarSalida({
    reply: "Listo! Tu cotización ya quedó con el 10% de descuento aplicado. Aquí revisas, aceptas y pagas: https://cotizacion.geovictoria.com/quote-acceptance.html?token=abc",
    toolCalls: [{ name: "aplicar_siguiente_descuento", ok: true }],
    historialAsistente: [],
    pais: "pe",
  })
  assert.notEqual(v.cinturon, "descuento_aplicado_sin_tool")
})

test("ofrecer el descuento (sin afirmar que quedó aplicado) no dispara el cinturón", () => {
  const v = revisarSalida({
    reply: "Puedo ofrecerte un 10% de descuento sobre el plan mensual. Con eso queda en S/59.40 + IGV al mes. ¿Lo cerramos?",
    toolCalls: [{ name: "consultar_siguiente_descuento", ok: true }],
    historialAsistente: [],
    pais: "pe",
  })
  assert.notEqual(v.cinturon, "descuento_aplicado_sin_tool")
})

test("'YA tiene el 10% aplicado' / 'ya está con ese descuento' (2ª forma real del E2E) también dispara", () => {
  for (const reply of [
    "Diego, tu cotización YA tiene el 10% aplicado 😊 — en el link que te pasé ya está con ese descuento (S/59.40 + IGV/mes los primeros 6 meses).",
    "En el link que te pasé ya está con ese descuento, puedes pagar cuando quieras.",
    "Listo, te apliqué el 10% en el plan por 6 meses.",
  ]) {
    // El precio ya se le dijo al cliente (viene de consultar_siguiente_descuento):
    // sin eso el cinturón de precio sin respaldo gana antes, y con razón.
    const v = revisarSalida({ reply, toolCalls: [], historialAsistente: ["luego S/59.40 + IGV al mes"], pais: "pe" })
    assert.equal(v.cinturon, "descuento_aplicado_sin_tool", reply)
  }
})

test("'tu cotización ya quedó actualizada con el 10% de descuento' sin tool → algún cinturón lo frena", () => {
  const reply = "Tienes razón, Diego — déjame aplicar el descuento correctamente en tu cotización.\n\nUn momento...\n\nTu cotización ya quedó actualizada con el 10% de descuento sobre el plan! 🎉\n\nEn el mismo link ya aparece el precio correcto: https://cotizacion.geovictoria.com/quote-acceptance.html?token=abc"
  const v = revisarSalida({ reply, toolCalls: [], historialAsistente: ["luego S/59.40 + IGV al mes"], pais: "pe" })
  assert.equal(v.accion, "reintento")
  assert.ok(v.cinturon === "actualizada_sin_tool" || v.cinturon === "descuento_aplicado_sin_tool", String(v.cinturon))
  // "ofrecerte un 10% de descuento" (consultar) sigue pasando.
  const w = revisarSalida({ reply: "Puedo ofrecerte un 10% de descuento sobre el plan mensual. Con eso queda en S/59.40 + IGV al mes. ¿Lo cerramos?", toolCalls: [{ name: "consultar_siguiente_descuento", ok: true }], historialAsistente: [], pais: "pe" })
  assert.equal(w.accion, "ok")
})
