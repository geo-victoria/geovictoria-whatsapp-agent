/**
 * Ningún link inventado sale del sistema (04-sep, casos Andrea y Andrés).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { juzgarCodigoCorto, linksInvalidos, auditarLinksDeCotizacion } from "../lib/link-cotizacion.ts"

const SECRETO = "secreto-de-prueba"
const QUOTE = "3525045000658246794"
const FIRMA = createHmac("sha256", SECRETO).update(QUOTE).digest("hex").slice(0, 10)

test("los dos links reales de ayer se rechazan por FORMA, incluso sin secreto", () => {
  delete process.env.VICKY_COTIZADORA_SECRET
  assert.equal(juzgarCodigoCorto("COT-310"), "forma_invalida")
  assert.equal(juzgarCodigoCorto("COT000394"), "forma_invalida")
  assert.equal(juzgarCodigoCorto("COT491"), "forma_invalida")
  // El del cinturón roto: el id quedó cortado y con un teléfono dentro.
  assert.equal(juzgarCodigoCorto("3+56"), "forma_invalida")
})

test("un id con forma correcta pero firma falsa se caza con el secreto", () => {
  process.env.VICKY_COTIZADORA_SECRET = SECRETO
  assert.equal(juzgarCodigoCorto(`${QUOTE}-0000000000`), "firma_invalida")
  assert.equal(juzgarCodigoCorto(`${QUOTE}-${FIRMA}`), "valido")
  delete process.env.VICKY_COTIZADORA_SECRET
})

test("sin secreto NUNCA se rechaza un link bien formado", () => {
  delete process.env.VICKY_COTIZADORA_SECRET
  // No poder verificar no puede costar una venta: la forma es suficiente.
  assert.equal(juzgarCodigoCorto(`${QUOTE}-abcdef0123`), "valido")
})

test("linksInvalidos encuentra el link malo dentro del mensaje real", () => {
  delete process.env.VICKY_COTIZADORA_SECRET
  const malo =
    "Lista tu cotización, Andrea! 🎉 Revísala aquí: https://cotizacion.geovictoria.com/q/COT-310\nPaga aquí y..."
  assert.deepEqual(linksInvalidos(malo), ["https://cotizacion.geovictoria.com/q/COT-310"])
  const bueno = `Revísala aquí: https://cotizacion.geovictoria.com/q/${QUOTE}-abcdef0123 😊`
  assert.deepEqual(linksInvalidos(bueno), [])
})

test("la puntuación pegada al link no lo invalida", () => {
  delete process.env.VICKY_COTIZADORA_SECRET
  const t = `Acá: https://cotizacion.geovictoria.com/q/${QUOTE}-abcdef0123.`
  assert.equal(auditarLinksDeCotizacion(t)[0].veredicto, "valido")
})

test("un mensaje sin links no reporta nada", () => {
  assert.deepEqual(linksInvalidos("Hola Carlos, cómo estás?"), [])
})

// ── El filtro vive en el ÚNICO punto de salida ──────────────────────────────
// Si alguien lo mueve dentro de una rama, vuelve a abrirse la rendija por la
// que salieron los links de Andrea (el reintento anti-eco no re-verificaba).

import { readFileSync } from "node:fs"
const WEBHOOK = readFileSync("app/api/vic-botmaker-v3/route.ts", "utf8")

test("el chequeo corre después de TODOS los reintentos y antes de persistir", () => {
  const eco = WEBHOOK.indexOf("ECO_DETECTADO")
  const filtro = WEBHOOK.indexOf("LINK_INVENTADO_BLOQUEADO")
  const persiste = WEBHOOK.indexOf("// 3. Persistir turno en Supabase")
  assert.ok(eco > 0 && filtro > 0 && persiste > 0)
  assert.ok(filtro > eco, "debe correr después del reintento anti-eco, que era la rendija")
  assert.ok(filtro < persiste, "y antes de persistir/enviar")
})

test("con cotización real se sustituye por su link; sin ella no se promete uno", () => {
  const i = WEBHOOK.indexOf("LINK_INVENTADO_BLOQUEADO")
  const bloque = WEBHOOK.slice(i, i + 1400)
  assert.ok(bloque.includes("LINK_SUSTITUIDO_POR_PUNTERO"), "si hay puntero, se entrega el link real")
  assert.ok(
    bloque.includes("te dejo tu cotización lista"),
    "sin cotización emitida, jamás se manda un link — se contiene",
  )
})
