/**
 * Bloque de prompt con los datos EXACTOS del ejecutivo asignado al contacto.
 *
 * Caso Carlos/RCT (25-ago): el cliente preguntó "¿Tamara está disponible?"
 * y el modelo, sin los datos del ejecutivo a mano, le dio el número de la
 * MESA DE AYUDA como si fuera el WhatsApp de Tamara (el único teléfono que
 * veía era el del bloque de soporte del prompt). La presentación del traspaso
 * quedó en el historial, pero el historial se recorta y el modelo improvisa.
 *
 * Regla: si el contacto tiene un traspaso ACTIVO (vic_ptv) o un ejecutivo
 * sorteado por derivación sobre-umbral (kv ejec_sobre_umbral_), el prompt
 * recibe nombre, teléfono y correo verdaderos + la prohibición de dar
 * cualquier otro número. El teléfono sale de la MISMA fuente que usa la
 * presentación: env VICKY_TM_TELEFONOS ("email:+56...") y de fallback la
 * ficha de usuario en Zoho (cacheada 7 días en vic_kv para no meter a Zoho
 * en el camino del webhook).
 *
 * Best-effort: cualquier falla devuelve "" y la conversación sigue igual.
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

function telefonoPorEnv(email: string): string {
  const raw = (process.env.VICKY_TM_TELEFONOS || "").trim()
  for (const par of raw.split(",")) {
    const [e, tel] = par.split(":").map((x) => (x || "").trim())
    if (e && tel && e.toLowerCase() === email.toLowerCase()) return tel
  }
  return ""
}

async function telefonoPorFicha(zohoId: string, email: string): Promise<string> {
  const { getKvValue, setKvValue } = await import("./supabase-persistence-v3")
  const cacheKey = `ejec_tel_${(email || zohoId).toLowerCase()}`
  // Cache con marca de tiempo (setKvValue no maneja TTL): >7 días = vencido.
  const cacheado = await getKvValue(cacheKey).catch(() => null)
  if (cacheado) {
    try {
      const j = JSON.parse(cacheado) as { tel?: string; at?: number }
      if (j?.at && Date.now() - j.at < 7 * 86400e3) return String(j.tel || "")
    } catch {
      /* formato viejo → reconsultar */
    }
  }
  let tel = ""
  try {
    if (zohoId) {
      const { getZohoAccessToken } = await import("./zoho-token")
      const token = await getZohoAccessToken()
      const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
      const r = await fetch(`${api}/crm/v3/users/${zohoId}`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        cache: "no-store",
      })
      if (r.ok) {
        const u = ((await r.json().catch(() => ({}))) as {
          users?: Array<{ phone?: string; mobile?: string }>
        }).users?.[0]
        tel = String(u?.phone || u?.mobile || "").trim()
      }
    }
  } catch {
    /* best-effort */
  }
  // Se cachea también el "sin teléfono" para no re-consultar Zoho cada turno.
  await setKvValue(cacheKey, JSON.stringify({ tel, at: Date.now() })).catch(() => {})
  return tel
}

/**
 * Bloque para el system prompt (o "" si el contacto no tiene ejecutivo
 * asignado). Va al inicio del contexto, junto a los demás bloques.
 */
export async function contextoEjecutivoAsignado(contact: string): Promise<string> {
  const clean = contact.replace(/\D/g, "")
  if (!clean || !SUPABASE_URL || !SUPABASE_KEY) return ""
  try {
    let nombre = ""
    let email = ""
    let zohoId = ""
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_ptv?contact=eq.${encodeURIComponent(clean)}&estado=eq.activo&select=vendedor_nombre,vendedor_email,vendedor_zoho_id&order=traspasado_at.desc&limit=1`,
      {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
        cache: "no-store",
      },
    ).catch(() => null)
    const fila = r?.ok
      ? (((await r.json().catch(() => [])) as Array<{
          vendedor_nombre?: string
          vendedor_email?: string
          vendedor_zoho_id?: string
        }>) || [])[0]
      : undefined
    if (fila?.vendedor_nombre || fila?.vendedor_email) {
      nombre = String(fila.vendedor_nombre || "").trim()
      email = String(fila.vendedor_email || "").trim()
      zohoId = String(fila.vendedor_zoho_id || "").trim()
    } else {
      // Derivación sobre-umbral: el sorteado quedó en kv (crm-hitos 14-ago).
      const { leerEjecutivoAsignado } = await import("./crm-hitos")
      const ejec = await leerEjecutivoAsignado(clean).catch(() => null)
      if (!ejec) return ""
      nombre = String(ejec.nombre || "").trim()
      email = String(ejec.email || "").trim()
      zohoId = String(ejec.id || "").trim()
      if (ejec.telefono) {
        return bloque(nombre, String(ejec.telefono).trim(), email)
      }
    }
    if (!nombre && !email) return ""
    const tel = telefonoPorEnv(email) || (await telefonoPorFicha(zohoId, email))
    return bloque(nombre, tel, email)
  } catch {
    return ""
  }
}

function bloque(nombre: string, tel: string, email: string): string {
  const datos = [nombre || "nuestro ejecutivo", tel ? `WhatsApp ${tel}` : "", email]
    .filter(Boolean)
    .join(" · ")
  return (
    `\n\n[EJECUTIVO ASIGNADO DE ESTE CLIENTE — datos EXACTOS, única fuente válida]\n` +
    `${datos}\n` +
    `Si el cliente pregunta por su ejecutivo, pide hablar con él/ella o pide sus datos de contacto, entrega EXACTAMENTE estos datos y NINGÚN otro. ` +
    `PROHIBIDO darle el teléfono de la Mesa de Ayuda, el de soporte o cualquier otro número como si fuera el del ejecutivo. ` +
    `${tel ? "" : "No conoces su teléfono: da solo nombre y correo, sin inventar números. "}` +
    `La Mesa de Ayuda es SOLO para soporte técnico de clientes existentes.`
  )
}
