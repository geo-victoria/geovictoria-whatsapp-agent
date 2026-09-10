import test from "node:test"
import assert from "node:assert/strict"
import { afirmaPagoConfirmado, clienteDeclaraPago, pareceInstruccionDeAcceso } from "../lib/pago-declarado.ts"

test("clienteDeclaraPago: las formas reales del chat", () => {
  for (const t of ["Ya esta pagado", "Y hice el pago\nAhora que sigue", "ya pagué", "Listo, ya transferí", "El pago está listo", "pagué con tarjeta recién"]) {
    assert.equal(clienteDeclaraPago(t), true, t)
  }
  for (const t of ["¿cómo pago?", "me das los datos para pagar", "cuánto es el pago mensual", "voy a pagar mañana"]) {
    assert.equal(clienteDeclaraPago(t), false, t)
  }
})

test("afirmaPagoConfirmado: el teatro del caso Eduardo", () => {
  assert.equal(afirmaPagoConfirmado("Perfecto, Eduardo! Ya veo que el pago está procesado 😊"), true)
  assert.equal(afirmaPagoConfirmado("Tu cuenta ya está activa, entra cuando quieras"), true)
  assert.equal(afirmaPagoConfirmado("Gracias por avisarme, déjame verificar el pago antes de seguir"), false)
  assert.equal(afirmaPagoConfirmado("Me mandas el comprobante y lo dejo registrado"), false)
})

test("pareceInstruccionDeAcceso: descarga la app / credenciales / contraseña", () => {
  const malo =
    "Primero necesito que ingreses a tu cuenta:\n📱 Descarga la app GeoVictoria\nO si prefieres: https://app.geovictoria.com\nTus credenciales de acceso son:\n- Contraseña: salió por correo"
  assert.equal(pareceInstruccionDeAcceso(malo), true)
  assert.equal(pareceInstruccionDeAcceso("Sin problema, Eduardo! Déjame un momento que te la reenvío al correo (la contraseña)"), true)
  assert.equal(pareceInstruccionDeAcceso("Te dejé la cotización en el link, ahí eliges tarjeta o transferencia"), false)
  assert.equal(pareceInstruccionDeAcceso("La app móvil marca con biometría facial y viene incluida en el plan"), false)
})
