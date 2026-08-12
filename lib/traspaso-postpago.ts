/**
 * Cierre de cadencia + TRASPASO post-pago, compartido por dos vías:
 *
 *   1. Webhook vic-quote-notify (tiempo real): el cotizador avisa al pagar.
 *   2. Barrido horario en vic-deal-stage-cron (red de seguridad): cubre el
 *      caso Constanza/COT233 (20-jul) — el cotizador registró el pago pero el
 *      request al agente nunca salió (faltan VICKY_AGENT_NOTIFY_URL /
 *      VICKY_AGENT_CRON_SECRET en su Vercel) y el cliente quedó sin traspaso
 *      y con la llamada agendada viva.
 *
 * Idempotente: el traspaso se envía UNA vez por cotización (candado kv
 * traspaso_postpago_<quoteId>), venga por la vía que venga.
 */

import {
  appendAssistantV3,
  closeFollowup,
  findContactByQuoteId,
  getKvValue,
  getQuotePointers,
  setKvValue,
} from "./supabase-persistence-v3"
import { sendBotmakerMessage } from "./botmaker-push-v3"
import { PERFIL_CO } from "./paises/co"
import { ownerDeCotizacion } from "./zoho-quote-owner"
import { obtenerLinkOnboarding } from "./tools/registrar-comprobante-transferencia"
import { pagoCierraLoop } from "./loop-v2"
import { onboardingEnabled, claveFase, claveBorrador } from "./onboarding/fase"
import { entregarKickoffOnboarding } from "./onboarding-envio"
import { parsearBorrador, sembrarBorrador, type Borrador } from "./onboarding/borrador"

export type ResultadoTraspaso = {
  contact?: string
  traspaso: "enviado" | "ya_enviado" | "push_fallo" | "omitido" | "sin_contacto"
}

/**
 * VENTA 100% VICKY (Lalo 31-jul, caso D'amore; destino actualizado 04-ago):
 * si el cliente PAGÓ sin que ningún humano interviniera en la venta (sin
 * traspaso PTV activo), TODOS los registros — cotización, deal, cuenta y
 * contacto — se asignan al dueño de ventas autónomas: hoy ALEYDIS ARAQUE,
 * configurable por vic_kv `owner_venta_autonoma` (gana sobre el env). El
 * mensaje post-pago ahora SÍ la presenta (decisión Lalo 04-ago — ella hace
 * la gestión post-venta). Best-effort: cualquier falla deja todo como estaba.
 */
const OWNER_VENTA_AUTONOMA_DEFAULT = "3525045000583802005" // Aleydis Araque

async function ownerVentaAutonoma(): Promise<string> {
  const kv = (await getKvValue("owner_venta_autonoma").catch(() => null)) || ""
  return kv.trim() || (process.env.VICKY_OWNER_VENTA_AUTONOMA || "").trim() || OWNER_VENTA_AUTONOMA_DEFAULT
}

export type EjecutivoAutonoma = { nombre: string; email: string; telefono: string }

/** Nombre/correo/teléfono del dueño de ventas autónomas desde su ficha de
 * usuario en Zoho — si cambia el dueño en vic_kv, la presentación se adapta
 * sola. Fallback: Aleydis con sus datos verificados (04-ago). */
async function datosOwnerAutonoma(
  ownerId: string,
  H: Record<string, string>,
  api: string,
): Promise<EjecutivoAutonoma> {
  const fallback: EjecutivoAutonoma = {
    nombre: "Aleydis Araque",
    email: "aaraque@geovictoria.com",
    telefono: "+56 9 8291 6868",
  }
  try {
    const r = await fetch(`${api}/crm/v3/users/${ownerId}`, { headers: H, cache: "no-store" })
    if (!r.ok) return fallback
    const u = ((await r.json().catch(() => ({}))) as {
      users?: Array<{ full_name?: string; email?: string; phone?: string; mobile?: string }>
    }).users?.[0]
    if (!u?.email) return fallback
    return {
      nombre: (u.full_name || "").trim() || u.email.split("@")[0],
      email: u.email,
      telefono: (u.phone || u.mobile || "").trim(),
    }
  } catch {
    return fallback
  }
}

async function asignarVentaAutonoma(
  contact: string,
  quoteId: string,
): Promise<{ autonoma: boolean; ejecutivo?: EjecutivoAutonoma }> {
  try {
    const owner = await ownerVentaAutonoma()
    if (!owner) return { autonoma: false }
    // SOLO CHILE (Lalo 31-jul): CO y MX siguen con sus reglas antiguas.
    if (!contact.startsWith("56")) return { autonoma: false }
    // ¿Intervino un humano? Un traspaso PTV activo significa que un vendedor
    // fue presentado y estaba encima de la venta → esa venta es suya, no
    // autónoma, y su asignación no se toca.
    const url = (process.env.SUPABASE_URL || "").trim()
    const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
    if (url && key) {
      const r = await fetch(
        `${url}/rest/v1/vic_ptv?contact=eq.${encodeURIComponent(contact)}&estado=eq.activo&select=id&limit=1`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" },
      )
      const filas = r.ok ? ((await r.json().catch(() => [])) as unknown[]) : []
      if (Array.isArray(filas) && filas.length > 0) return { autonoma: false }
    }
    const { getZohoAccessToken } = await import("./zoho-token")
    const token = await getZohoAccessToken()
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
    const quoteModule = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
    // La cotización, y de ella la cuenta y el contacto asociados ("todos los
    // registros", Lalo 04-ago). El lead convertido no se toca: Zoho no
    // permite editar leads ya convertidos.
    const gQuote = await fetch(
      `${api}/crm/v3/${quoteModule}/${quoteId}?fields=Cuenta_Asociada,Contacto_Asociado`,
      { headers: H, cache: "no-store" },
    )
    const filaQuote = gQuote.ok
      ? ((await gQuote.json().catch(() => ({}))) as {
          data?: Array<{ Cuenta_Asociada?: { id?: string } | null; Contacto_Asociado?: { id?: string } | null }>
        }).data?.[0]
      : undefined
    await fetch(`${api}/crm/v3/${quoteModule}`, {
      method: "PUT",
      headers: H,
      cache: "no-store",
      body: JSON.stringify({ data: [{ id: quoteId, Owner: { id: owner } }] }),
    }).catch(() => {})
    const skip = { skip_feature_execution: [{ name: "assignment_rules" }] }
    if (filaQuote?.Cuenta_Asociada?.id) {
      await fetch(`${api}/crm/v3/Accounts`, {
        method: "PUT", headers: H, cache: "no-store",
        body: JSON.stringify({ data: [{ id: filaQuote.Cuenta_Asociada.id, Owner: { id: owner } }], ...skip }),
      }).catch(() => {})
    }
    if (filaQuote?.Contacto_Asociado?.id) {
      await fetch(`${api}/crm/v3/Contacts`, {
        method: "PUT", headers: H, cache: "no-store",
        body: JSON.stringify({ data: [{ id: filaQuote.Contacto_Asociado.id, Owner: { id: owner } }], ...skip }),
      }).catch(() => {})
    }
    const fono = contact.replace(/\D/g, "")
    const s = await fetch(`${api}/crm/v3/Leads/search?phone=${fono}&converted=both&per_page=3`, { headers: H, cache: "no-store" })
    const dealId = s.ok && s.status !== 204
      ? ((await s.json().catch(() => ({}))) as { data?: Array<{ Converted_Deal?: { id?: string } | null }> }).data?.find((l) => l.Converted_Deal?.id)?.Converted_Deal?.id
      : undefined
    if (dealId) {
      await fetch(`${api}/crm/v3/Deals`, {
        method: "PUT",
        headers: H,
        cache: "no-store",
        body: JSON.stringify({ data: [{ id: String(dealId), Owner: { id: owner } }], ...skip }),
      }).catch(() => {})
    }
    const ejecutivo = await datosOwnerAutonoma(owner, H, api)
    console.log(
      `[postpago] venta 100% Vicky: cotización ${quoteId}, deal ${dealId || "-"}, cuenta y contacto asignados a ${ejecutivo.email}`,
    )
    return { autonoma: true, ejecutivo }
  } catch (e) {
    console.warn("[postpago] asignarVentaAutonoma falló:", e instanceof Error ? e.message : e)
    return { autonoma: false }
  }
}

/**
 * Cierra toda la proactividad del contacto dueño de la cotización (nudges,
 * anuncios y llamadas agendadas) y, si `enviarTraspaso`, le presenta a su
 * ejecutivo humano. Best-effort en cada paso; nunca lanza.
 */
export async function cerrarYTraspasarPostPago(
  quoteId: string,
  opts: { enviarTraspaso?: boolean; motivoCierre?: "pagado" | "aceptada" } = {},
): Promise<ResultadoTraspaso> {
  const enviarTraspaso = opts.enviarTraspaso !== false
  const contact = await findContactByQuoteId(quoteId).catch(() => null)
  if (!contact) return { traspaso: "sin_contacto" }

  await closeFollowup(contact, "cotizacion_aceptada").catch(() => {})
  // Regla de oro del Loop v2: la venta cerrada corta el loop de toques para
  // siempre (best-effort). El motivo distingue pago real de aceptación (fix
  // 10-ago) — el cobro asistido depende de esa diferencia.
  await pagoCierraLoop(contact, opts.motivoCierre || "pagado").catch(() => {})
  // Venta 100% Vicky → todos los registros al dueño de ventas autónomas
  // (Aleydis, vic_kv owner_venta_autonoma) y la bienvenida LA presenta
  // (decisión Lalo 04-ago: ella hace la gestión post-venta).
  const ventaAutonoma = await asignarVentaAutonoma(contact, quoteId)

  const esCO = contact.startsWith("57")
  const esMX = contact.startsWith("521") || (contact.startsWith("52") && contact.length === 12)
  const esCL = !esCO && !esMX
  // Vicky onboarding — CHILE PRIMERO (decisión 26-jul): el pago es la ÚNICA
  // puerta que mueve al contacto de venta a onboarding. CO y MX siguen con el
  // traspaso a ejecutivo humano hasta que la fase se abra para ellos.
  let borradorSembrado: Borrador | null = null
  if (onboardingEnabled() && esCL) {
    await setKvValue(claveFase(contact), "onboarding").catch(() => {})
    // Sembrar el borrador con lo que la VENTA ya sabe (regla de Eduardo,
    // 26-jul: no volver a preguntar lo que el cliente ya dio — confirmarlo o
    // actualizarlo). La cotización PAGADA trae razón social y RUT; si el
    // contacto ya dijo algo en la fase, eso queda por encima de la semilla.
    try {
      const pointers = await getQuotePointers(contact)
      const pagada = pointers.find((p) => p.quoteId === quoteId) || pointers[0]
      const previo = parsearBorrador(await getKvValue(claveBorrador(contact)).catch(() => null))
      borradorSembrado = sembrarBorrador(
        previo,
        { empresa: { nombre: pagada?.empresa, identificador: pagada?.rut } },
        "cl",
      )
      await setKvValue(claveBorrador(contact), JSON.stringify(borradorSembrado))
    } catch {
      borradorSembrado = null
    }
  }

  if (!enviarTraspaso) return { contact, traspaso: "omitido" }

  const kvKey = `traspaso_postpago_${quoteId}`
  const ya = await getKvValue(kvKey).catch(() => null)
  if (ya) return { contact, traspaso: "ya_enviado" }

  // Vicky AUTÓNOMA en CL (decisión 26-jul): con el flag encendido NO se
  // presenta a ningún ejecutivo — el mismo mensaje de bienvenida abre el alta
  // por chat, y el gate del webhook atiende las respuestas con el agente de
  // onboarding. Reemplaza al bloque del ejecutivo, no lo suma.
  if (onboardingEnabled() && esCL) {
    // UN solo mensaje de arranque para las dos vías de pago y para dentro y
    // fuera de la ventana. Fuera de ventana el texto libre moriría en silencio
    // (el cliente pudo pagar un domingo tras dos días callado), así que ahí va
    // la plantilla HSM — con el MISMO texto.
    const { via, texto } = await entregarKickoffOnboarding(
      contact,
      borradorSembrado?.empresa.nombre,
      borradorSembrado?.empresa.identificador,
    )
    if (via === "fallo") return { contact, traspaso: "push_fallo" }
    await setKvValue(kvKey, new Date().toISOString()).catch(() => {})
    // Solo el texto libre entra al historial: la plantilla la despacha Botmaker
    // y meterla le daría al modelo un turno que no dijo.
    if (via === "texto") await appendAssistantV3(contact, texto, "cl").catch(() => {})
    return { contact, traspaso: "enviado" }
  }

  // CL: se presenta al DUEÑO REAL del deal pagado, no a un nombre fijo.
  // Relevo 27-jul: las cotizaciones nuevas son de Eddyluz y las anteriores
  // siguen siendo de Anderson — presentar al equivocado en el mensaje de
  // bienvenida es exactamente la incoherencia del caso "yo misma te
  // acompaño" (tests/coherencia-post-pago), ahora entre dos humanos.
  const EJECUTIVOS_CL: Record<string, { nombre: string; email: string; telefono: string }> = {
    "emujica@geovictoria.com": { nombre: "Eddyluz Mujica", email: "emujica@geovictoria.com", telefono: "+56 9 3932 1687" },
    "adiazg@geovictoria.com": { nombre: "Anderson Díaz", email: "adiazg@geovictoria.com", telefono: "+56 9 3937 2058" },
    // Vendedores de la tómbola de deals (31-jul). Extensible sin deploy por
    // env VICKY_TELEFONOS_EJECUTIVOS="email:+56 9 ...,email:+56 9 ...".
    "tmartinezq@geovictoria.com": { nombre: "Tamara Martínez", email: "tmartinezq@geovictoria.com", telefono: "+56 9 3452 9937" },
    "alopez@geovictoria.com": { nombre: "Ana Paula López", email: "alopez@geovictoria.com", telefono: "+56 9 6647 4270" },
  }
  for (const par of (process.env.VICKY_TELEFONOS_EJECUTIVOS || "").split(",")) {
    const idx = par.indexOf(":")
    if (idx > 0) {
      const email = par.slice(0, idx).trim().toLowerCase()
      const telefono = par.slice(idx + 1).trim()
      if (email && telefono) {
        EJECUTIVOS_CL[email] = { nombre: EJECUTIVOS_CL[email]?.nombre || email.split("@")[0], email, telefono }
      }
    }
  }
  const duenoCL = !esMX && !esCO ? await ownerDeCotizacion(quoteId).catch(() => null) : null
  const ejecutivo = esMX
    ? { nombre: "Yahel Segura", email: "ysegura@geovictoria.com", telefono: "+52 55 3763 6604" }
    : esCO
      ? PERFIL_CO.equipo.ejecutivo
      : duenoCL
        ? {
            // Nombre real desde Zoho (jamás un prefijo de correo); el teléfono
            // sale del directorio si lo conocemos.
            nombre: duenoCL.nombre || EJECUTIVOS_CL[duenoCL.email]?.nombre || "",
            email: duenoCL.email,
            telefono: EJECUTIVOS_CL[duenoCL.email.toLowerCase()]?.telefono || "",
          }
        : EJECUTIVOS_CL["emujica@geovictoria.com"]
  // Caso Jessica/JEANSCO (24-jul): el mensaje de bienvenida DEBE traer el link
  // del auto-onboarding — antes solo presentaba al ejecutivo y el cliente
  // tenía que encontrar el wizard por su cuenta. El endpoint es idempotente.
  const linkOnboarding = await obtenerLinkOnboarding(quoteId).catch(() => "")
  const encabezado =
    `¡Felicitaciones y bienvenido a GeoVictoria! 🎉 Tu pago quedó registrado.\n\n` +
    (linkOnboarding
      ? `Para dejar tu empresa configurada y lista para operar, completa tu auto-onboarding aquí (toma ~10 minutos):\n👉 ${linkOnboarding}\n\n`
      : "")
  // Venta autónoma: se presenta al dueño de ventas autónomas (Aleydis) — es
  // quien hace la gestión post-venta (Lalo 04-ago; antes no se presentaba a
  // nadie y "nuestro equipo te contactará" quedaba sin cara).
  const quienPresenta = ventaAutonoma.autonoma && ventaAutonoma.ejecutivo ? ventaAutonoma.ejecutivo : ejecutivo
  const traspaso =
    encabezado +
    `De aquí en adelante te acompaña *${quienPresenta.nombre}*, ${ventaAutonoma.autonoma ? "de nuestro equipo" : "tu ejecutivo comercial"}, quien te contactará para coordinar la puesta en marcha:\n` +
    (quienPresenta.telefono ? `📱 ${quienPresenta.telefono}\n` : "") +
    `✉️ ${quienPresenta.email}`
  const pushed = await sendBotmakerMessage(
    contact,
    traspaso,
    esCO ? PERFIL_CO.canal.channelId : undefined,
  ).catch(() => false)
  if (!pushed) return { contact, traspaso: "push_fallo" }
  await setKvValue(kvKey, new Date().toISOString()).catch(() => {})
  await appendAssistantV3(contact, traspaso, esCO ? "co" : "cl").catch(() => {})
  return { contact, traspaso: "enviado" }
}
