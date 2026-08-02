/**
 * Adaptador contra los ENDPOINTS DE ALTA de la plataforma (Nicolás, 28-jul):
 *
 *   GET  /api/vicky/alive                → health
 *   POST /api/vicky/company/exists      → { exists, name } por identificador+país
 *   POST /api/vicky/company             → crea empresa + primer admin
 *                                          { company:{companyId,...}, user:{..., loginUserCreated} }
 *
 * Convenciones del servicio (Teams, 29/30-jul):
 *   - X-Api-Key en el header; host y key viven SOLO en env de Vercel
 *     (VICKY_ALTA_API_HOST / VICKY_ALTA_API_KEY) — jamás en el repo.
 *   - Identificadores SIN puntos ni guion ("965432105", no "96.543.210-5").
 *   - La creación del usuario dispara un CORREO de acceso al workEmail si el
 *     mail existe (por eso el mensaje al cliente habla del correo enviado).
 *
 * Sin env configurado, todo devuelve null/no-disponible y el canal cae al
 * alta manual de siempre — un alta jamás se pierde por este adaptador.
 */

const HOST = (process.env.VICKY_ALTA_API_HOST || "").trim().replace(/\/+$/, "")
const API_KEY = (process.env.VICKY_ALTA_API_KEY || "").trim()

export function altaApiConfigurada(): boolean {
  return Boolean(HOST && API_KEY)
}

/** Identificador en el formato del servicio: solo dígitos y K, sin puntos ni guion. */
export function identificadorParaAlta(valor: string): string {
  return String(valor || "").replace(/[^0-9kK]/g, "").toUpperCase()
}

const CODIGO_PAIS: Record<string, string> = { cl: "CL", co: "CO", mx: "MX" }

async function llamar(path: string, body?: unknown): Promise<Response> {
  return fetch(`${HOST}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "X-Api-Key": API_KEY,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  })
}

/**
 * ¿Existe ya la empresa en la plataforma? null = servicio caído o error (el
 * caller decide el fallback; NUNCA interpretar null como "no existe").
 */
export async function existeEmpresa(
  identificador: string,
  pais: "cl" | "co" | "mx",
): Promise<{ exists: boolean; name: string | null } | null> {
  if (!altaApiConfigurada()) return null
  try {
    const res = await llamar("/api/vicky/company/exists", {
      identifier: identificadorParaAlta(identificador),
      countryCode: CODIGO_PAIS[pais],
    })
    if (!res.ok) {
      console.warn(`[alta-empresa] exists → ${res.status}`)
      return null
    }
    const data = (await res.json().catch(() => null)) as { exists?: boolean; name?: string | null } | null
    if (!data || typeof data.exists !== "boolean") return null
    return { exists: data.exists, name: data.name ?? null }
  } catch (e) {
    console.warn(`[alta-empresa] exists falló:`, e instanceof Error ? e.message : e)
    return null
  }
}

export type AltaEmpresaInput = {
  pais: "cl" | "co" | "mx"
  empresa: { nombre: string; identificador: string }
  admin: {
    nombre: string
    apellido: string
    identificador: string
    email: string
    /** Código interno del trabajador; si el cliente no lo dio, va su RUT. */
    idInterno?: string
  }
}

export type AltaEmpresaResultado =
  | {
      ok: true
      companyId: string
      loginUserCreated: boolean
      workEmail: string
    }
  | { ok: false; error: string; yaExiste?: boolean }

/** Crea la empresa + su primer administrador. NO consulta exists: ese candado
 * es responsabilidad del caller (consultar-antes-de-crear). */
export async function crearEmpresaConAdmin(input: AltaEmpresaInput): Promise<AltaEmpresaResultado> {
  if (!altaApiConfigurada()) return { ok: false, error: "API de alta no configurada" }
  try {
    const res = await llamar("/api/vicky/company", {
      company: {
        name: input.empresa.nombre,
        countryCode: CODIGO_PAIS[input.pais],
        identifier: identificadorParaAlta(input.empresa.identificador),
      },
      user: {
        nationalIdentifier: identificadorParaAlta(input.admin.identificador),
        employeeIdentifier:
          String(input.admin.idInterno || "").trim() || identificadorParaAlta(input.admin.identificador),
        firstName: input.admin.nombre,
        lastName: input.admin.apellido,
        workEmail: input.admin.email,
      },
    })
    const texto = await res.text().catch(() => "")
    if (!res.ok) {
      console.warn(`[alta-empresa] company → ${res.status}: ${texto.slice(0, 200)}`)
      // 409 company_already_exists: el servicio tiene su PROPIO candado
      // anti-duplicados (verificado 02-ago). Se distingue para que el canal
      // responda como "ya existe" (activación al equipo), no como falla.
      const yaExiste = res.status === 409 || /company_already_exists/.test(texto)
      return { ok: false, error: `El servicio de alta devolvió ${res.status}`, ...(yaExiste ? { yaExiste: true } : {}) }
    }
    const data = JSON.parse(texto || "{}") as {
      company?: { companyId?: string | number }
      user?: { loginUserCreated?: boolean; workEmail?: string }
    }
    const companyId = String(data?.company?.companyId ?? "")
    if (!companyId) return { ok: false, error: "El alta respondió sin companyId" }
    return {
      ok: true,
      companyId,
      loginUserCreated: data?.user?.loginUserCreated === true,
      workEmail: String(data?.user?.workEmail || input.admin.email),
    }
  } catch (e) {
    console.warn(`[alta-empresa] company falló:`, e instanceof Error ? e.message : e)
    return { ok: false, error: e instanceof Error ? e.message : "Error de red en el alta" }
  }
}
