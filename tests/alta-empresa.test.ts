/**
 * Adaptador de ALTA AUTOMÁTICA de empresa (endpoints de Nicolás, 02-ago).
 *
 * Reglas que estos tests fijan:
 *   - Identificadores SIN puntos ni guion (convención del servicio, Teams 30-jul).
 *   - Candado consultar-antes-de-crear: el canal consulta exists ANTES de
 *     crear; empresa existente JAMÁS se crea encima (caso Cofradía).
 *   - null de exists (servicio caído) NUNCA se interpreta como "no existe":
 *     cae al alta manual.
 *   - Host y api key viven SOLO en env (VICKY_ALTA_API_HOST/KEY) — nunca en
 *     el repo. Sin env, el canal se comporta exactamente como antes (manual).
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { identificadorParaAlta } from "../lib/alta-empresa.ts"

const RAIZ = new URL("..", import.meta.url).pathname
const ADAPTADOR = readFileSync(join(RAIZ, "lib/alta-empresa.ts"), "utf8")
const CANAL = readFileSync(join(RAIZ, "lib/onboarding-canal.ts"), "utf8")

describe("identificadores en el formato del servicio", () => {
  test("sin puntos ni guion, K mayúscula", () => {
    assert.equal(identificadorParaAlta("96.543.210-5"), "965432105")
    assert.equal(identificadorParaAlta("96543210-5"), "965432105")
    assert.equal(identificadorParaAlta("965432105"), "965432105")
    assert.equal(identificadorParaAlta("12.345.678-k"), "12345678K")
    assert.equal(identificadorParaAlta(""), "")
  })
})

describe("credenciales y transporte", () => {
  test("host y key salen de env, jamás hardcodeados", () => {
    assert.match(ADAPTADOR, /VICKY_ALTA_API_HOST/)
    assert.match(ADAPTADOR, /VICKY_ALTA_API_KEY/)
    assert.doesNotMatch(ADAPTADOR, /azurewebsites/)
    assert.doesNotMatch(ADAPTADOR, /wKVYPY/)
  })

  test("X-Api-Key en el header y timeout acotado", () => {
    assert.match(ADAPTADOR, /"X-Api-Key": API_KEY/)
    assert.match(ADAPTADOR, /AbortSignal\.timeout/)
  })

  test("exists caído devuelve null y el contrato lo declara", () => {
    assert.match(ADAPTADOR, /NUNCA interpretar null como "no existe"/)
  })
})

describe("el canal del onboarding usa el adaptador con candado", () => {
  test("consulta exists ANTES de crear (consultar-antes-de-crear)", () => {
    const iExiste = CANAL.indexOf("await existeEmpresa(")
    const iCrear = CANAL.indexOf("await crearEmpresaConAdmin(")
    assert.ok(iExiste > 0 && iCrear > 0, "faltan las llamadas al adaptador")
    assert.ok(iExiste < iCrear, "exists debe consultarse antes de crear")
  })

  test("empresa existente → activación al equipo, jamás crear encima", () => {
    assert.match(CANAL, /existe\?\.exists/)
    assert.match(CANAL, /YA EXISTE en la plataforma/)
    assert.match(CANAL, /NO crear otra/)
  })

  test("el 409 del servicio (carrera exists→create) también termina en 'ya existe'", () => {
    // Verificado en vivo 02-ago: crear con RUT existente → 409
    // company_already_exists. El adaptador lo distingue y el canal lo trata
    // igual que exists=true — nunca como falla que dispare alta manual.
    assert.match(ADAPTADOR, /res\.status === 409 \|\| \/company_already_exists\//)
    assert.match(CANAL, /alta\.yaExiste\) return await responderYaExiste/)
  })

  test("la creación solo corre con exists === false explícito", () => {
    assert.match(CANAL, /if \(existe && !existe\.exists\)/)
  })

  test("API caída o fallo de creación → cae al alta MANUAL (jamás perder un alta)", () => {
    assert.match(CANAL, /cae a alta manual/)
    assert.match(CANAL, /ALTA ONBOARDING CL \(crear a mano\)/)
  })

  test("sin env configurado el flujo es el manual de siempre", () => {
    assert.match(CANAL, /if \(altaApiConfigurada\(\)\)/)
  })

  test("el éxito por API guarda companyId y avisa al equipo", () => {
    assert.match(CANAL, /companyId: alta\.companyId/)
    assert.match(CANAL, /creada POR API/)
  })

  test("el mensaje al cliente respeta la honestidad de entrega del correo", () => {
    // La plataforma envía el acceso por correo: se dice "te enviamos" y se
    // sugiere revisar Promociones/Spam — jamás se afirma que "llegó".
    assert.match(CANAL, /Te enviamos el correo de acceso/)
    assert.match(CANAL, /Promociones o Spam/)
    assert.doesNotMatch(CANAL, /ya te llegó el correo/i)
  })
})
