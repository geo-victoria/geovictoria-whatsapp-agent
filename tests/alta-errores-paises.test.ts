/**
 * Manejo de errores de la API de alta en los 4 países (contrato de Nicolás,
 * 02-oct). Mismo mecanismo para todos; lo que cambia por país es el
 * countryCode, el documento de empresa/admin y el texto al cliente.
 * Sin red: fetch simulado.
 */
import { test } from "node:test"
import assert from "node:assert/strict"

process.env.VICKY_ALTA_API_HOST = "https://api.prueba"
process.env.VICKY_ALTA_API_KEY = "k"
const { crearEmpresaConAdmin, agregarUsuarioAlta, existeEmpresa } = await import("../lib/alta-empresa.ts")
const { accionUsuarioFallido, textoPedirDatosAdmin, textoPedirOtroCorreo } = await import("../lib/alta-decision.ts")

const PAISES = [
  { pais: "cl", cc: "CL", empresa: "76.543.210-3", empresaEsperada: "765432103", admin: "12.345.678-5", doc: "RUT" },
  { pais: "pe", cc: "PE", empresa: "20605842055", empresaEsperada: "20605842055", admin: "12345678", doc: "DNI" },
  { pais: "co", cc: "CO", empresa: "900.123.456-8", empresaEsperada: "9001234568", admin: "1020304050", doc: "Cédula" },
  { pais: "mx", cc: "MX", empresa: "ABC-010101-AB1", empresaEsperada: "ABC010101AB1", admin: "GODE561231HDFRRN09", doc: "CURP" },
] as const

const llamadas: Array<{ url: string; body: Record<string, unknown> | null }> = []
function mock(respuestas: Array<{ status: number; body: unknown }>) {
  let i = 0
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    llamadas.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null })
    const r = respuestas[Math.min(i++, respuestas.length - 1)]
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } })
  }) as typeof fetch
}
const ok200 = (extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: { sessionId: "s1", expiresAtUtc: "2099-01-01T00:00:00Z", company: { companyId: 900, countryId: 7 }, user: { workEmail: "a@x.com" }, usersCreated: 1, errors: [], ...extra },
})
const input = (p: (typeof PAISES)[number]) => ({
  pais: p.pais,
  empresa: { nombre: "Empresa Prueba", identificador: p.empresa },
  sesion: "000",
  admin: { nombre: "Ana", apellido: "Pérez", identificador: p.admin, email: "a@x.com" },
})

for (const p of PAISES) {
  test(`${p.cc}: el alta viaja con su countryCode, el documento sin separadores y vickyAppSession`, async () => {
    llamadas.length = 0
    mock([ok200()])
    const r = await crearEmpresaConAdmin(input(p)) as { ok: boolean; usuarioCreado?: boolean; countryCodeEnviado?: string }
    assert.equal(r.ok, true)
    assert.equal(r.usuarioCreado, true)
    assert.equal(r.countryCodeEnviado, p.cc)
    const body = llamadas[0].body as { company: { countryCode: string; identifier: string }; vickyAppSession: string }
    assert.match(llamadas[0].url, /\/api\/vicky\/company$/)
    assert.equal(body.company.countryCode, p.cc)
    assert.equal(body.company.identifier, p.empresaEsperada)
    assert.equal(body.vickyAppSession, "000")
  })

  test(`${p.cc}: exists consulta con el countryCode del país`, async () => {
    llamadas.length = 0
    mock([{ status: 200, body: { exists: false } }])
    await existeEmpresa(p.empresa, p.pais)
    assert.equal((llamadas[0].body as { countryCode: string }).countryCode, p.cc)
  })

  for (const code of ["internal_error", "user_already_exists", "invalid_request", "algo_nuevo"]) {
    test(`${p.cc}: 200 con errors[${code}] → empresa creada, usuario no, sesión para reintentar`, async () => {
      mock([ok200({ user: null, usersCreated: 0, errors: [{ code, step: "create_user" }] })])
      const r = await crearEmpresaConAdmin(input(p)) as { ok: boolean; usuarioCreado?: boolean; errorUsuario?: { code: string }; sesionAlta?: { sessionId: string } }
      assert.equal(r.ok, true)
      assert.equal(r.usuarioCreado, false)
      assert.equal(r.errorUsuario?.code, code)
      assert.equal(r.sesionAlta?.sessionId, "s1")
    })
  }

  for (const [status, code] of [[409, "company_already_exists"], [400, "invalid_request"], [400, "country_not_found"], [500, "internal_error"]] as const) {
    test(`${p.cc}: ${status} ${code} → nada creado, el code llega al caller`, async () => {
      mock([{ status, body: { code, status, detail: "x" } }])
      const r = await crearEmpresaConAdmin(input(p)) as { ok: boolean; code?: string }
      assert.equal(r.ok, false)
      assert.equal(r.code, code)
    })
  }

  test(`${p.cc}: reintento del usuario por company/user (éxito y sesión vencida)`, async () => {
    llamadas.length = 0
    mock([{ status: 200, body: { sessionId: "s1", user: { workEmail: "b@x.com" }, usersCreated: 1, errors: [] } }])
    const a = await agregarUsuarioAlta("s1", input(p).admin)
    assert.deepEqual(a, { ok: true, workEmail: "b@x.com", usersCreated: 1 })
    assert.match(llamadas[0].url, /\/api\/vicky\/company\/user$/)
    mock([{ status: 200, body: { sessionId: "s1", user: null, errors: [{ code: "session_expired" }] } }])
    const b = await agregarUsuarioAlta("s1", input(p).admin) as { ok: boolean; code?: string }
    assert.equal(b.ok, false)
    assert.equal(b.code, "session_expired")
  })

  test(`${p.cc}: el texto que pide los datos del admin nombra el ${p.doc}, no otro documento`, () => {
    const t = textoPedirDatosAdmin(p.pais)
    assert.ok(t.includes(p.doc), t)
    for (const otro of ["RUT", "DNI", "Cédula", "CURP"].filter((d) => d !== p.doc)) assert.ok(!t.includes(otro), `${p.cc} menciona ${otro}`)
    assert.ok(!/al tiro/.test(t) && !/al tiro/.test(textoPedirOtroCorreo("a@x.com")))
  })
}

test("decisión por code (igual en los 4 países)", () => {
  assert.equal(accionUsuarioFallido("internal_error", true), "reintentar")
  assert.equal(accionUsuarioFallido("internal_error", true, true), "empresa_sin_admin")
  assert.equal(accionUsuarioFallido("user_already_exists", true), "pedir_otro_correo")
  assert.equal(accionUsuarioFallido("invalid_request", true), "pedir_datos_admin")
  assert.equal(accionUsuarioFallido("session_expired", true), "empresa_sin_admin")
  assert.equal(accionUsuarioFallido("user_already_exists", false), "empresa_sin_admin")
})
