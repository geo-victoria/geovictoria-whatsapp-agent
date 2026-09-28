/**
 * CERTIFICACIÓN DE PAÍS — espejo en producción del test tests/certificacion-pais
 * (paso 6 del orden del 21-sep). Responde, para cada país, las 15 dimensiones
 * que necesita para operar y qué le falta.
 *
 * SOLO LECTURA (Lalo 28-sep, "¿la certificación quemará turnos de la tómbola?"
 * → no): no escribe en vic_kv ni en Zoho, no dispara reglas de asignación, no
 * consume rotaciones. Con `&zoho=1` hace UNA lectura de los usuarios activos
 * de Zoho (GET) para completar el único dato que la ficha no siempre trae: el
 * teléfono con que se presenta a cada ejecutivo.
 *
 * GET ?key=<cron>[&pais=pe][&zoho=1]
 *
 * Lo que solo se mide con el fuente de los crons (matriz de plantillas del
 * loop, presentación del traspaso, toque 0) lo cubre la SUITE; acá sale como
 * "noMedible" y se dice — nunca como resuelto.
 */
import { NextResponse } from "next/server"
import { certificarPais, PAISES_CERT, type PaisCert, type Certificacion } from "@/lib/certificacion-pais"
import { rosterTelemarketingOperativo } from "@/lib/paises/ficha-operativa"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const maxDuration = 60

async function autorizado(req: Request): Promise<boolean> {
  const url = new URL(req.url)
  const key = (url.searchParams.get("key") || req.headers.get("x-cron-secret") || "").trim()
  if (!key) return false
  const env = (process.env.CRON_SECRET || process.env.FOLLOWUP_CRON_SECRET || "").trim()
  if (env && key === env) return true
  const kv = (await getFollowupCronSecret().catch(() => "")) || ""
  return Boolean(kv) && key === kv
}

/** Teléfonos de la ficha de usuario de Zoho, por correo (una sola lectura, GET). */
async function telefonosZoho(): Promise<Map<string, string>> {
  const { getZohoAccessToken } = await import("@/lib/zoho-token")
  const token = await getZohoAccessToken()
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  const out = new Map<string, string>()
  for (let page = 1; page <= 4; page++) {
    const r = await fetch(`${api}/crm/v3/users?type=ActiveUsers&page=${page}&per_page=200`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      cache: "no-store",
    })
    if (!r.ok || r.status === 204) break
    const j = (await r.json().catch(() => ({}))) as {
      users?: Array<{ email?: string; phone?: string; mobile?: string }>
      info?: { more_records?: boolean }
    }
    for (const u of j.users || []) {
      const e = String(u.email || "").trim().toLowerCase()
      const tel = String(u.mobile || u.phone || "").replace(/\D/g, "")
      if (e && tel) out.set(e, tel)
    }
    if (!j.info?.more_records) break
  }
  return out
}

/** Completa la dimensión 13 con lo que Zoho sabe del teléfono de cada ejecutivo. */
function completarTelefonos(c: Certificacion, tels: Map<string, string>): void {
  const d = c.dimensiones.find((x) => x.id === "personas")
  if (!d) return
  const sin = rosterTelemarketingOperativo(c.pais).filter((p) => !p.telefono && !tels.get(p.email)).map((p) => p.nombre)
  const con = rosterTelemarketingOperativo(c.pais).filter((p) => p.telefono || tels.get(p.email)).length
  d.noMedible = d.noMedible.filter((t) => !t.startsWith("teléfono en Zoho"))
  d.detalle.push(`teléfono para presentar: ${con} con dato (ficha o Zoho)`)
  if (sin.length) {
    d.faltas.push(`telemarketing sin teléfono en la ficha ni en Zoho (no se le puede presentar al cliente): ${sin.join(", ")}`)
    d.ok = false
  }
  c.resueltas = c.dimensiones.filter((x) => x.ok).length
  c.ok = c.resueltas === c.de
}

export async function GET(req: Request) {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  const url = new URL(req.url)
  const soloPais = (url.searchParams.get("pais") || "").trim().toLowerCase()
  const conZoho = url.searchParams.get("zoho") === "1"
  const paises = (soloPais ? [soloPais] : [...PAISES_CERT]).filter((p): p is PaisCert => (PAISES_CERT as readonly string[]).includes(p))
  if (!paises.length) return NextResponse.json({ ok: false, error: "pais inválido (cl|pe|co|mx)" }, { status: 400 })

  // Tools de Chile: el set real del agente (los demás países salen de sus sets únicos en el módulo).
  let toolsCL: string[] = []
  try {
    const mod = await import("@/lib/tools")
    toolsCL = (mod.TOOL_SCHEMAS as unknown as ReadonlyArray<{ name: string }>).map((t) => t.name)
  } catch {
    /* sin el set: la dimensión 2 de Chile lo declara como no medible */
  }

  const fallos: string[] = []
  let tels: Map<string, string> | null = null
  if (conZoho) {
    try {
      tels = await telefonosZoho()
    } catch (e) {
      fallos.push(`Zoho users: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const porPais: Record<string, Certificacion> = {}
  for (const p of paises) {
    try {
      const c = certificarPais(p, { toolsCL })
      if (tels) completarTelefonos(c, tels)
      porPais[p] = c
    } catch (e) {
      // La ausencia de datos no es un hallazgo negativo (regla del 13-sep): se dice.
      fallos.push(`${p}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const resumen = Object.fromEntries(
    Object.values(porPais).map((c) => [
      c.pais,
      {
        ok: c.ok,
        resueltas: `${c.resueltas}/${c.de}`,
        faltan: c.dimensiones.filter((d) => !d.ok).map((d) => `${d.n}. ${d.id}: ${d.faltas.join(" · ")}`),
        noMedibleAqui: c.dimensiones.flatMap((d) => d.noMedible.map((t) => `${d.n}. ${t}`)),
        pendientesDeclarados: c.pendientesDeclarados,
      },
    ]),
  )

  return NextResponse.json({
    ok: fallos.length === 0 && Object.values(porPais).every((c) => c.ok),
    soloLectura: true,
    nota: "Cero escrituras: no toca vic_kv ni Zoho, no dispara reglas de asignación ni consume turnos de tómbola. Lo 'noMedibleAqui' lo mide la suite (tests/certificacion-pais) con el fuente de los crons.",
    zohoConsultado: Boolean(tels),
    resumen,
    detalle: porPais,
    fallos,
  })
}
