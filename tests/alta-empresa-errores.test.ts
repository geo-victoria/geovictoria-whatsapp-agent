/**
 * Contrato de la API de alta (Nicolás 02-oct): 200 = empresa creada aunque el
 * usuario haya fallado (errors[] + user null); no-200 = nada creado, motivo en
 * `code` (problem+json). Se decide SIEMPRE por `code`.
 */
import { test } from "node:test"
import assert from "node:assert/strict"

process.env.VICKY_ALTA_API_HOST = "https://api.prueba"
process.env.VICKY_ALTA_API_KEY = "k"
const { crearEmpresaConAdmin, agregarUsuarioAlta, codigoProblema } = await import("../lib/alta-empresa.ts")

const input = {
  pais: "cl" as const,
  empresa: { nombre: "Mi Empresa", identificador: "76.543.210-9" },
  sesion: "56900000001",
  admin: { nombre: "Ana", apellido: "Pérez", identificador: "12.345.678-9", email: "ana@miempresa.cl" },
}
let ultimoBody: unknown = null
function mock(status: number, body: unknown) {
  globalThis.fetch = (async (_u: string, init?: { body?: string }) => {
    ultimoBody = init?.body ? JSON.parse(init.body) : null
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
  }) as typeof fetch
}

test("200 sin errores: empresa y usuario creados; viaja vickyAppSession", async () => {
  mock(200, { sessionId: "s1", expiresAtUtc: "2026-10-02T18:00:00Z", company: { companyId: 4242 }, user: { workEmail: "ana@miempresa.cl" }, usersCreated: 1, errors: [] })
  const r = await crearEmpresaConAdmin(input)
  assert.equal(r.ok, true)
  assert.equal((r as { usuarioCreado?: boolean }).usuarioCreado, true)
  assert.equal((ultimoBody as { vickyAppSession?: string }).vickyAppSession, "56900000001")
})

test("200 con errors: la empresa existe, el usuario NO, y trae la sesión para reintentar", async () => {
  mock(200, { sessionId: "s2", expiresAtUtc: "2026-10-02T18:00:00Z", company: { companyId: 4243 }, user: null, usersCreated: 0, errors: [{ code: "user_already_exists", step: "create_user", detail: "x" }] })
  const r = await crearEmpresaConAdmin(input) as { ok: boolean; usuarioCreado?: boolean; errorUsuario?: { code: string }; sesionAlta?: { sessionId: string } }
  assert.equal(r.ok, true)
  assert.equal(r.usuarioCreado, false)
  assert.equal(r.errorUsuario?.code, "user_already_exists")
  assert.equal(r.sesionAlta?.sessionId, "s2")
})

test("409 company_already_exists (problem+json): nada creado, yaExiste", async () => {
  mock(409, { code: "company_already_exists", status: 409, detail: "..." })
  const r = await crearEmpresaConAdmin(input) as { ok: boolean; yaExiste?: boolean; code?: string }
  assert.equal(r.ok, false)
  assert.equal(r.yaExiste, true)
  assert.equal(r.code, "company_already_exists")
})

test("agregar usuario: éxito, error en errors[] y sesión vencida", async () => {
  mock(200, { sessionId: "s2", companyId: 4243, user: { workEmail: "otro@x.cl" }, usersCreated: 1, errors: [] })
  assert.deepEqual(await agregarUsuarioAlta("s2", input.admin), { ok: true, workEmail: "otro@x.cl", usersCreated: 1 })
  mock(200, { sessionId: "s2", user: null, errors: [{ code: "session_expired" }] })
  const r = await agregarUsuarioAlta("s2", input.admin)
  assert.equal(r.ok, false)
  assert.equal((r as { code: string }).code, "session_expired")
})

test("codigoProblema lee el code de un problem+json", () => {
  assert.equal(codigoProblema('{"code":"country_not_found","status":400}'), "country_not_found")
  assert.equal(codigoProblema("no json"), "")
})
