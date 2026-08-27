/**
 * FILTRO ESTÁNDAR de las campañas de re-encantamiento (Lalo 27-ago, caso
 * Hofmann/Ana: la primera ola se armó solo con señales del lado de Vicky y
 * le llegó a un cliente en plena negociación con su ejecutiva).
 *
 * REGLA: un contacto entra a una ola SOLO si nadie lo está trabajando.
 * Queda FUERA si en las últimas 48 HORAS HÁBILES (L-V 8-18 Chile, mismo
 * reloj de los traspasos v2) hubo cualquiera de estas señales:
 *   - actividad del CLIENTE con Vicky (last_user_at)
 *   - gestión de un EJECUTIVO: mensaje suyo por WhatsApp espejado (from_me),
 *     llamada espejada, o nota HUMANA en el deal (autor que no es robot)
 * Y también queda fuera si:
 *   - es cliente existente (algún deal suyo en "8. Facturando")
 *   - ya recibió 2 campañas (regla del doc: máximo 2 por cliente)
 *   - es contacto interno de prueba
 *
 * Este módulo es el ÚNICO lugar donde vive el criterio: toda ola futura arma
 * su padrón llamando a filtrarPadronCampana() — nunca más un filtro ad-hoc.
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const ZOHO_API = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()

/** Usuarios robot cuyas notas NO cuentan como gestión humana (mismo criterio
 * de hayGestionEnDeal del post-pago). */
const ROBOTS_NOTAS = new Set(["3525045000484500876", "3525045000000200013"])

const INTERNOS = new Set(["56944668823", "56978385048"])

export const VENTANA_CAMPANA_HORAS_HABILES = 48

/** Horas hábiles (L-V 8-18, hora de Chile) transcurridas desde `desdeIso`
 * hasta `ahora`. Camina hora a hora con tope: solo necesitamos saber si el
 * umbral se cruzó, no el número exacto en ventanas largas. */
export function horasHabilesDesde(desdeIso: string, ahora: Date = new Date(), topeHoras = 200): number {
  const desdeMs = Date.parse(desdeIso)
  if (!Number.isFinite(desdeMs) || desdeMs >= ahora.getTime()) return 0
  let habiles = 0
  const HORA_MS = 3_600_000
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Santiago",
    weekday: "short",
    hour: "numeric",
    hour12: false,
  })
  for (let t = desdeMs, pasos = 0; t < ahora.getTime() && pasos < topeHoras; t += HORA_MS, pasos++) {
    const partes = fmt.formatToParts(new Date(t))
    const dia = partes.find((p) => p.type === "weekday")?.value || ""
    const hora = Number(partes.find((p) => p.type === "hour")?.value || "0")
    if (dia !== "Sat" && dia !== "Sun" && hora >= 8 && hora < 18) habiles++
  }
  return habiles
}

export type ExclusionCampana = { contact: string; motivo: string; detalle?: string }

async function sbGet<T>(ruta: string): Promise<T[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${ruta}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    cache: "no-store",
  })
  if (!r.ok) return []
  return ((await r.json().catch(() => [])) as T[]) || []
}

/** Aplica el filtro estándar a una lista de candidatos (teléfonos solo
 * dígitos). Devuelve aptos + excluidos con motivo, para que el reporte de
 * cada ola muestre POR QUÉ alguien quedó fuera (auditable por el equipo). */
export async function filtrarPadronCampana(
  candidatos: string[],
  opts: { ahora?: Date } = {},
): Promise<{ aptos: string[]; excluidos: ExclusionCampana[] }> {
  const ahora = opts.ahora || new Date()
  const excluidos: ExclusionCampana[] = []
  const dentroDeVentana = (iso: string | null | undefined): boolean =>
    Boolean(iso) && horasHabilesDesde(String(iso), ahora) < VENTANA_CAMPANA_HORAS_HABILES

  const unicos = [...new Set(candidatos.map((c) => c.replace(/\D/g, "")).filter(Boolean))]
  const vivos = new Set(unicos.filter((c) => !INTERNOS.has(c)))
  for (const c of unicos) if (!vivos.has(c)) excluidos.push({ contact: c, motivo: "interno" })

  // 1. Máximo 2 campañas por cliente (regla del doc).
  const filasCamp = await sbGet<{ contact: string; campana: string }>(
    `vic_campanas?select=contact,campana&evento=eq.enviado&limit=20000`,
  )
  const campanasDe = new Map<string, Set<string>>()
  for (const f of filasCamp) {
    const tel = f.contact.replace(/\D/g, "")
    if (!vivos.has(tel)) continue
    const s = campanasDe.get(tel) || new Set<string>()
    s.add(f.campana)
    campanasDe.set(tel, s)
  }
  for (const [tel, s] of campanasDe) {
    if (s.size >= 2) {
      vivos.delete(tel)
      excluidos.push({ contact: tel, motivo: "tope_2_campanas", detalle: [...s].join(", ") })
    }
  }

  // 2. Actividad del CLIENTE con Vicky en la ventana.
  const convs = await sbGet<{ contact: string; last_user_at?: string }>(
    `vic_v3_conversations?select=contact,last_user_at&limit=20000`,
  )
  for (const cv of convs) {
    const tel = cv.contact.replace(/\D/g, "")
    if (vivos.has(tel) && dentroDeVentana(cv.last_user_at)) {
      vivos.delete(tel)
      excluidos.push({ contact: tel, motivo: "cliente_activo_con_vicky", detalle: cv.last_user_at })
    }
  }

  // 3. Gestión del EJECUTIVO por el espejo: su mensaje (from_me) o llamada.
  for (const tel of [...vivos]) {
    const nueve = tel.slice(-9)
    const [msgs, llamadas] = await Promise.all([
      sbGet<{ enviado_at: string }>(
        `vic_wa_espejo_mensajes?select=enviado_at&telefono_chat=like.*${nueve}&from_me=eq.true&es_grupo=eq.false&order=enviado_at.desc&limit=1`,
      ),
      sbGet<{ at: string }>(`vic_wa_espejo_llamadas?select=at&telefono=like.*${nueve}&order=at.desc&limit=1`),
    ])
    const ultMsg = msgs[0]?.enviado_at
    const ultLlamada = llamadas[0]?.at
    if (dentroDeVentana(ultMsg) || dentroDeVentana(ultLlamada)) {
      vivos.delete(tel)
      excluidos.push({ contact: tel, motivo: "gestion_ejecutivo_espejo", detalle: ultMsg || ultLlamada })
    }
  }

  // 4. Zoho: cliente existente (deal Facturando) y notas HUMANAS recientes.
  // Fecha_ultima_Nota es la primera criba barata (granularidad de día, la
  // bombean también los robots); solo los deals con nota fresca pagan el GET
  // de sus notas para mirar autor y hora reales.
  try {
    const { getZohoAccessToken } = await import("./zoho-token")
    const token = await getZohoAccessToken()
    const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
    const lista = [...vivos]
    const corteNota = new Date(ahora.getTime() - 6 * 86_400_000).toISOString().slice(0, 10)
    for (let i = 0; i < lista.length; i += 20) {
      const grupo = lista.slice(i, i + 20)
      const valores = grupo.flatMap((t) => [`'${t}'`, `'+${t}'`]).join(",")
      const r = await fetch(`${ZOHO_API}/crm/v3/coql`, {
        method: "POST",
        headers: H,
        cache: "no-store",
        body: JSON.stringify({
          select_query: `select id, Contact_Phone, Stage, Fecha_ultima_Nota from Deals where Contact_Phone in (${valores}) limit 200`,
        }),
      })
      if (!r.ok) continue
      const deals = (((await r.json().catch(() => null)) as {
        data?: Array<{ id: string; Contact_Phone?: string; Stage?: string; Fecha_ultima_Nota?: string }>
      } | null)?.data || [])
      for (const d of deals) {
        const tel = String(d.Contact_Phone || "").replace(/\D/g, "")
        if (!vivos.has(tel)) continue
        // Cliente existente = deal Implementando O Facturando (caso
        // Ingredientes Alimenticios 27-ago: pagó por transferencia gestionada
        // a mano, el deal estaba en "7. Implementando" con primera factura y
        // la cotización seguía "Aceptada" — casi le ofrecemos un 10% siendo
        // ya cliente. Implementando también es post-pago.)
        const stage = String(d.Stage || "")
        if (stage === "8. Facturando" || stage === "7. Implementando") {
          vivos.delete(tel)
          excluidos.push({ contact: tel, motivo: "cliente_existente", detalle: `${d.id} · ${stage}` })
          continue
        }
        if (!d.Fecha_ultima_Nota || d.Fecha_ultima_Nota < corteNota) continue
        const rn = await fetch(
          `${ZOHO_API}/crm/v3/Deals/${d.id}/Notes?fields=Created_By,Created_Time&per_page=100`,
          { headers: H, cache: "no-store" },
        )
        if (!rn.ok || rn.status === 204) continue
        const notas = (((await rn.json().catch(() => null)) as {
          data?: Array<{ Created_By?: { id?: string } | null; Created_Time?: string }>
        } | null)?.data || [])
        const humanaReciente = notas.find(
          (n) => !ROBOTS_NOTAS.has(String(n.Created_By?.id || "")) && dentroDeVentana(n.Created_Time),
        )
        if (humanaReciente) {
          vivos.delete(tel)
          excluidos.push({ contact: tel, motivo: "nota_humana_en_deal", detalle: humanaReciente.Created_Time })
        }
      }
    }
  } catch {
    // Zoho caído: el filtro sigue con lo que ya excluyó (espejo + cliente).
    // Preferimos una ola algo más ancha a no poder armarla — el espejo cubre
    // la señal principal de gestión.
  }

  return { aptos: [...vivos], excluidos }
}
