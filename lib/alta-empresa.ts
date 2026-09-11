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

// FALLBACK vic_kv (24-ago): Nicolás entregó host+key por Teams el 29-jul y
// quedaron en vic_kv `gva_customer_api_host` / `gva_customer_api_key` vía
// vic-admin-kv — así el alta puede encenderse/rotarse sin deploy ni tocar
// Vercel. El env, si está, sigue mandando. Cache 10 min.
let _kvCreds: { host: string; key: string; exp: number } | null = null
async function credenciales(): Promise<{ host: string; key: string }> {
  if (HOST && API_KEY) return { host: HOST, key: API_KEY }
  if (_kvCreds && _kvCreds.exp > Date.now()) return _kvCreds
  try {
    const { getKvValue } = await import("./supabase-persistence-v3")
    const [h, k] = await Promise.all([
      getKvValue("gva_customer_api_host").catch(() => null),
      getKvValue("gva_customer_api_key").catch(() => null),
    ])
    _kvCreds = {
      host: (HOST || String(h || "")).trim().replace(/\/+$/, ""),
      key: (API_KEY || String(k || "")).trim(),
      exp: Date.now() + 10 * 60_000,
    }
    return _kvCreds
  } catch {
    return { host: HOST, key: API_KEY }
  }
}

export function altaApiConfigurada(): boolean {
  // Con envs es un sí inmediato; sin envs puede estar en vic_kv — se
  // responde optimista y el fallo real (si no hay nada) lo atrapa `llamar`,
  // cuyo error cae al alta manual de siempre.
  return true
}

/** Identificador en el formato del servicio: solo dígitos y K, sin puntos ni guion. */
export function identificadorParaAlta(valor: string): string {
  return String(valor || "").replace(/[^0-9kK]/g, "").toUpperCase()
}

/**
 * Códigos que el servicio de Nicolás soporta (mensaje del 10-sep: CL AR PE CO
 * MX BR). El countryCode NO es cosmético: de él sale la ZONA HORARIA por
 * defecto de la empresa, y una empresa sin país nace en UTC 0 → todas las
 * marcaciones quedan corridas. Por eso `crearEmpresaConAdmin` se NIEGA a
 * crear sin código en vez de omitir la clave en el JSON (que era el modo
 * silencioso de producir el bug).
 */
const CODIGO_PAIS: Record<string, string> = {
  cl: "CL", ar: "AR", pe: "PE", co: "CO", mx: "MX", br: "BR",
}

async function llamar(path: string, body?: unknown): Promise<Response> {
  const { host, key } = await credenciales()
  if (!host || !key) throw new Error("API de alta sin host/key (ni env ni vic_kv)")
  return fetch(`${host}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "X-Api-Key": key,
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
  pais: "cl" | "ar" | "pe" | "co" | "mx" | "br"
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
      /** Código de país que se envió (de él sale la zona horaria). */
      countryCodeEnviado?: string
      /** `countryId` que devolvió el servicio: vacío = la empresa quedó sin país (UTC 0). */
      countryId?: string
    }
  | { ok: false; error: string; yaExiste?: boolean; correoOcupado?: boolean }

/** Crea la empresa + su primer administrador. NO consulta exists: ese candado
 * es responsabilidad del caller (consultar-antes-de-crear). */
export async function crearEmpresaConAdmin(input: AltaEmpresaInput): Promise<AltaEmpresaResultado> {
  if (!altaApiConfigurada()) return { ok: false, error: "API de alta no configurada" }
  const codigoPais = CODIGO_PAIS[input.pais]
  if (!codigoPais) {
    // Sin país no se crea: la empresa nacería en UTC 0 y las marcaciones
    // quedarían corridas para siempre.
    console.error(`[alta-empresa] país sin countryCode soportado: "${input.pais}" — alta abortada`)
    return { ok: false, error: `País "${input.pais}" sin countryCode soportado por el servicio de alta` }
  }
  try {
    const res = await llamar("/api/vicky/company", {
      company: {
        name: input.empresa.nombre,
        countryCode: codigoPais,
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
      // Los 409 del servicio son DOS casos distintos (28-ago, caso Lalo):
      // user_already_exists = el CORREO del admin ya tiene usuario en la
      // plataforma → se pide otro correo, el alta sigue abierta. El resto
      // (company_already_exists o 409 pelado) = la EMPRESA ya existe →
      // activación al equipo sobre la cuenta existente (caso Cofradía).
      const correoOcupado = /user_already_exists/.test(texto)
      const yaExiste = !correoOcupado && (res.status === 409 || /company_already_exists/.test(texto))
      return {
        ok: false,
        error: `El servicio de alta devolvió ${res.status}`,
        ...(yaExiste ? { yaExiste: true } : {}),
        ...(correoOcupado ? { correoOcupado: true } : {}),
      }
    }
    // El contrato devuelve company:{companyId,name,identifier,countryId} —
    // `countryId` es la PRUEBA de que el país llegó y la zona horaria quedó
    // bien. Antes solo se leía companyId, así que un countryId vacío pasaba
    // inadvertido y la empresa quedaba en UTC 0 (marcaciones corridas).
    const data = JSON.parse(texto || "{}") as {
      company?: { companyId?: string | number; name?: string; identifier?: string; countryId?: string | number | null }
      user?: { loginUserCreated?: boolean; workEmail?: string }
    }
    const companyId = String(data?.company?.companyId ?? "")
    if (!companyId) return { ok: false, error: "El alta respondió sin companyId" }
    const countryId = data?.company?.countryId
    const countryIdTexto = countryId === null || countryId === undefined ? "" : String(countryId)
    console.log(
      `[alta-empresa] empresa ${companyId} creada · countryCode enviado=${codigoPais} · countryId devuelto=${countryIdTexto || "(vacío)"}`,
    )
    return {
      ok: true,
      companyId,
      countryCodeEnviado: codigoPais,
      countryId: countryIdTexto,
      loginUserCreated: data?.user?.loginUserCreated === true,
      workEmail: String(data?.user?.workEmail || input.admin.email),
    }
  } catch (e) {
    console.warn(`[alta-empresa] company falló:`, e instanceof Error ? e.message : e)
    return { ok: false, error: e instanceof Error ? e.message : "Error de red en el alta" }
  }
}
