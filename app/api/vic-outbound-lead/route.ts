/**
 * OUTBOUND — Toque 0 a leads del formulario web (Vicky proactiva).
 *
 * Lo llama el Workflow de Zoho cuando se crea/asigna un lead del formulario
 * "Solicita cotización o demo" que califica para Vicky (≤49 empleados y NO es
 * cliente actual — ese ruteo/filtro vive en Zoho, acá se confía en él).
 *
 * Qué hace (velocity-first: cada minuto post-formulario es conversión perdida):
 *   1. Envía la plantilla HSM de apertura vía Botmaker (OUTBOUND_TEMPLATE_LEAD).
 *   2. Persiste el turno de apertura de Vicky + los datos del formulario en la
 *      conversación (patrón de la reactivación), para que cuando el lead
 *      responda, Vicky tenga TODO el contexto sin lookups.
 *
 * SEGURO POR DEFECTO: sin OUTBOUND_TEMPLATE_LEAD configurada no envía nada
 * (deployable antes de aprobar la plantilla en Meta).
 * DEDUP: si el contacto ya tiene conversación con mensajes, no se le escribe
 * (ya está conversando con Vicky o ya recibió el toque; re-disparos del
 * workflow quedan absorbidos).
 *
 * Auth: x-cron-secret == vic_kv.followup_cron_secret, o Bearer/?key=CRON_SECRET.
 *
 * Body esperado (JSON desde el workflow de Zoho):
 *   {
 *     "nombre": "María",              // requerido
 *     "apellido": "Pérez",            // opcional
 *     "empresa": "Comercial XYZ",     // requerido
 *     "telefono": "+56 9 1234 5678",  // requerido (con o sin formato)
 *     "email": "maria@xyz.cl",        // opcional pero recomendado
 *     "empleadosRango": "20 - 49",    // opcional (rango del formulario)
 *     "zohoLeadId": "352504500..."    // opcional (trazabilidad)
 *   }
 */

import { NextResponse } from "next/server"
import { sendBotmakerTemplate } from "@/lib/botmaker-push-v3"
import { appendAssistantV3, getFollowupCronSecret, getKvValue, setKvValue } from "@/lib/supabase-persistence-v3"
import { isTestContact, testContactSet } from "@/lib/funnel-analysis"
import {
  agregarNotaLead,
  buscarLeadAbiertoDeOtroDueno,
  updateZohoLeadStatus,
  updateZohoLeadFields,
  reasignarLeadSdrInbound,
  reasignarLeadSdrInboundCO,
  updateZohoLeadOwner,
} from "@/lib/zoho-leads"
import { PERFIL_CO } from "@/lib/paises/co"
import { PERFIL_MX } from "@/lib/paises/mx"
import { enrolarEnLoop } from "@/lib/loop-v2"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
// Nombre de la plantilla HSM de apertura en Botmaker (variables: nombre, empresa).
const TPL_LEAD = (process.env.OUTBOUND_TEMPLATE_LEAD || "").trim()
// Colombia (17-jul, paridad de proactividad): plantilla de apertura propia que
// sale por la línea +57. Categoría UTILITY (aprobada 17-jul con copy
// transaccional): inmune al cap de frecuencia de Meta sobre Marketing
// (131049, caso Marcela). La env queda como override. Zona horaria/feriados
// CO los resuelve la cadencia con vic_is_business_now (prefijo 57 → Bogotá).
const TPL_LEAD_CO = (process.env.OUTBOUND_TEMPLATE_LEAD_CO || "vicky_co_solicitud_recibida").trim()
// México (21-jul): plantilla de apertura propia por la línea +52 1 56 5977 8486.
const TPL_LEAD_MX = (process.env.OUTBOUND_TEMPLATE_LEAD_MX || "vicky_mx_lead_apertura").trim()
// T0 de FIN DE SEMANA (regla Rodrigo/Lalo 24-jul, parte del loop v2): sábado y
// domingo la apertura pregunta "¿conversamos ahora o prefieres el lunes?"
// (plantilla vicky_t0_finde, creada por Lalo el 24-jul). Sin gemela del país
// (CO/MX aún) cae a la apertura normal — un lead JAMÁS se queda sin T0.
const TPL_LEAD_FINDE = (process.env.OUTBOUND_TEMPLATE_LEAD_FINDE || "vicky_t0_finde").trim()
// El texto de vicky_t0_finde es neutro (sin chilenismos) y las plantillas del
// workspace sirven en todas las líneas → CO la reutiliza tal cual (25-jul).
const TPL_LEAD_FINDE_CO = (process.env.OUTBOUND_TEMPLATE_LEAD_FINDE_CO || "vicky_t0_finde").trim()

function esFinDeSemana(country: string): boolean {
  const tz =
    country === "co" ? "America/Bogota" : country === "mx" ? "America/Mexico_City" : "America/Santiago"
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date())
  return wd === "Sat" || wd === "Sun"
}

async function authorized(req: Request): Promise<boolean> {
  const xcron = (req.headers.get("x-cron-secret") || "").trim()
  if (xcron) {
    const expected = await getFollowupCronSecret().catch(() => "")
    if (expected && xcron === expected) return true
  }
  if (CRON_SECRET) {
    const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
    if (bearer === CRON_SECRET) return true
    const key = (new URL(req.url).searchParams.get("key") || "").trim()
    if (key === CRON_SECRET) return true
  }
  return false
}

type LeadBody = {
  nombre?: string
  apellido?: string
  empresa?: string
  telefono?: string
  email?: string
  empleadosRango?: string
  zohoLeadId?: string
  // País/territorio explícito desde Zoho ("Chile"/"Colombia" o "cl"/"co").
  // Manda sobre la inferencia por prefijo y permite NORMALIZAR teléfonos en
  // formato local (formularios que llegan sin +57/+56). Opcional: sin él, el
  // prefijo del teléfono decide, como siempre.
  country?: string
  territorio?: string
  // Página donde convirtió el lead (Zoho Conversion/Landing Page, ej.
  // "/es-cl/servicios/alertas/"). Va al contexto interno: Vicky abre sabiendo
  // qué producto estaba mirando en vez de partir genérica.
  paginaConversion?: string
  landingPage?: string
}

export async function POST(req: Request): Promise<Response> {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  const body = (await req.json().catch(() => ({}))) as LeadBody
  const nombre = (body.nombre || "").trim()
  const apellido = (body.apellido || "").trim()
  // Empresa es OPCIONAL (el formulario a veces llega sin Company): con fallback
  // la plantilla lee natural ("...tu solicitud de cotización para tu empresa").
  // Un valor puramente numérico tampoco es un nombre — el formulario a veces
  // trae la cédula/RUT en el campo empresa (caso Marcela "1128404362", 17-jul)
  // y la plantilla quedaba "cotización para 1128404362". Se normaliza acá para
  // que plantilla, contexto y correos de cadencia hereden el fallback.
  const empresaRaw = (body.empresa || "").trim()
  const empresa = /^[\d\s.\-]*$/.test(empresaRaw) ? "tu empresa" : empresaRaw
  const email = (body.email || "").trim()
  const rango = (body.empleadosRango || "").trim()
  const zohoLeadId = (body.zohoLeadId || "").trim()
  // Página de conversión/aterrizaje (pista de interés). Zoho a veces manda el
  // literal "none" o "-" en estos campos de marketing: se tratan como vacío.
  const paginaRaw = (body.paginaConversion || body.landingPage || "").trim()
  const paginaInteres = /^(none|null|-|—)?$/i.test(paginaRaw) ? "" : paginaRaw.slice(0, 200)
  let contact = (body.telefono || "").replace(/\D/g, "")

  if (!contact || !nombre) {
    return NextResponse.json(
      { ok: false, error: "telefono y nombre son requeridos" },
      { status: 400 },
    )
  }

  // LEADS DEL BOTÓN WHATSAPP DE LAS LANDINGS (Lalo 21-ago: "el miniform
  // reenvía a hablar con Vicky — no es para que nosotros enviemos
  // plantillas"): ese flujo es INBOUND PURO. El cliente llenó el formulario y
  // viene EN CAMINO a escribir por el mensaje prellenado; mandarle un toque 0
  // encima duplica el saludo, y la detección de fijo lo entregaría a SDR
  // cuando el diseño es esperar su mensaje. Con Form_Vicky = "Si" este
  // endpoint NO hace nada: ni plantilla, ni cadencia, ni entrega — el lead
  // queda con Vicky esperando el inbound. (Capa 2: Dave excluye Form_Vicky=Si
  // del workflow "Vicky - Toque 0 WhatsApp lead asignado" en Zoho.)
  if (zohoLeadId) {
    // CANDADO POR LEAD (31-ago, caso Doctoc: el webhook de Zoho y el poller
    // dispararon con 5 segundos de diferencia y cada uno "regaló" el lead a
    // una SDR distinta). El primero en llegar marca; el segundo se aplaza y
    // el poller decide después con el estado real.
    const lockKey = `outb_lock_${zohoLeadId}`
    const lock = Number((await getKvValue(lockKey).catch(() => null)) || 0)
    if (lock && Date.now() - lock < 90_000) {
      console.log(`[outbound-lead] lead ${zohoLeadId} ya está siendo procesado (candado) — aplazado`)
      return NextResponse.json({ ok: true, aplazado: "en_proceso", contact })
    }
    await setKvValue(lockKey, String(Date.now())).catch(() => {})
    try {
      const { getZohoAccessToken } = await import("@/lib/zoho-token")
      const tk = await getZohoAccessToken()
      const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
      const rl = await fetch(`${api}/crm/v3/Leads/${zohoLeadId}?fields=Form_Vicky,Owner`, {
        headers: { Authorization: `Zoho-oauthtoken ${tk}` },
        cache: "no-store",
      })
      if (rl.status === 200) {
        const dl = ((await rl.json().catch(() => ({}))) as {
          data?: Array<{ Form_Vicky?: string | null; Owner?: { id?: string; email?: string } | null }>
        })?.data?.[0]
        const fv = String(dl?.Form_Vicky || "")
        if (/^si$/i.test(fv.trim())) {
          console.log(`[outbound-lead] lead ${zohoLeadId} viene del botón WhatsApp de landing (Form_Vicky=Si) — inbound puro, sin toque 0`)
          return NextResponse.json({ ok: true, skipped: "form_vicky_inbound" })
        }
        // LEAD YA ENTREGADO (orden Lalo 31-ago: "no vuelvas a enviar
        // plantillas si ya traspasamos estos leads a las SDR"): si el dueño
        // vigente ya no es el robot, el lead es de un humano — ni plantilla
        // ni reasignación, nada.
        const ownerId = String(dl?.Owner?.id || "")
        const VICKY_ID = (process.env.VICKY_ZOHO_CREATOR_ID || "3525045000484500876").trim()
        if (ownerId && ownerId !== VICKY_ID) {
          console.log(`[outbound-lead] lead ${zohoLeadId} ya es de ${dl?.Owner?.email || ownerId} — sin toque 0`)
          return NextResponse.json({ ok: true, skipped: `lead ya entregado a ${dl?.Owner?.email || "un humano"}` })
        }
        // FOTO DE LA ASIGNACIÓN (Lalo 31-ago, "quiero la tasa entre lo que se
        // le asigna y lo que logra contactar"): la primera vez que este lead
        // del tramo pasa por acá siendo de Vicky, queda la marca — inmutable,
        // gane o pierda el envío después. El dash cuenta la columna 📋 desde
        // estas marcas; vic_outbound_cadence (que además gobierna el umbral
        // de precios) sigue naciendo solo con el toque REAL.
        const kAsig = `outb_asignado_${zohoLeadId}`
        const yaAsig = await getKvValue(kAsig).catch(() => null)
        if (!yaAsig) {
          await setKvValue(
            kAsig,
            JSON.stringify({ at: new Date().toISOString(), contact, nombre, empresa }),
          ).catch(() => {})
        }
      }
    } catch { /* ante la duda, el flujo outbound clásico sigue */ }
  }

  // País: el territorio EXPLÍCITO de Zoho manda; el prefijo telefónico es el
  // fallback. Con país conocido se normalizan teléfonos en formato local:
  // CL móvil "9XXXXXXXX" (9 dígitos) → 56...; CO celular "3XXXXXXXXX" (10) → 57...
  const territorioRaw = (body.country || body.territorio || "").trim().toLowerCase()
  const territorio = /colombia|^co$/.test(territorioRaw)
    ? "co"
    : /m[eé]xico|^mx$/.test(territorioRaw)
      ? "mx"
      : /chile|^cl$/.test(territorioRaw)
        ? "cl"
        : null
  if (territorio === "cl" && contact.length === 9 && contact.startsWith("9")) {
    contact = `56${contact}`
  } else if (territorio === "co" && contact.length === 10 && contact.startsWith("3")) {
    contact = `57${contact}`
  } else if (territorio === "mx" && contact.length === 10) {
    // Celulares mexicanos: 10 dígitos locales → WhatsApp usa 52 + 1 + número.
    contact = `521${contact}`
  }
  const porPrefijo = contact.startsWith("56")
    ? "cl"
    : contact.startsWith("57")
      ? "co"
      : contact.startsWith("521") || (contact.startsWith("52") && contact.length === 12)
        ? "mx"
        : null
  // El prefijo del teléfono manda (define la línea por la que se puede escribir);
  // el territorio solo normaliza y deja traza si no calzan.
  const country = porPrefijo || territorio
  if (porPrefijo && territorio !== porPrefijo) {
    console.warn(
      `[outbound-lead] territorio=${territorio || "(vacío)"} no calza con prefijo del teléfono ${contact} — se usa el prefijo`,
    )
    // El formulario trae el país malo (o vacío): se corrige en Zoho con la
    // verdad del prefijo, para que reportes y futuras assignment rules no
    // hereden el dato falso (20-jul, a raíz del caso Joys/Perú invertido).
    if (zohoLeadId) {
      const pais = porPrefijo === "mx" ? "México" : porPrefijo === "co" ? "Colombia" : "Chile"
      updateZohoLeadFields(zohoLeadId, { Country: pais, Territorio: pais }).catch(() => {})
    }
  }
  const esCO = country === "co"
  const esMX = country === "mx"
  const finde = esFinDeSemana(country || "cl")
  const tplPais = esMX
    ? TPL_LEAD_MX
    : esCO
      ? (finde && TPL_LEAD_FINDE_CO) || TPL_LEAD_CO
      : (finde && TPL_LEAD_FINDE) || TPL_LEAD
  const channelId = esMX
    ? PERFIL_MX.canal.channelId
    : esCO
      ? PERFIL_CO.canal.channelId
      : undefined

  // Los números internos no reciben prospección (mismo set que excluye el
  // embudo). OUTBOUND_ALLOW_CONTACTS (coma-separado) permite excepciones
  // puntuales para pruebas E2E del flujo completo con números del equipo.
  const allowList = new Set(
    (process.env.OUTBOUND_ALLOW_CONTACTS || "")
      .split(",")
      .map((s) => s.replace(/\D/g, ""))
      .filter(Boolean),
  )
  if (!allowList.has(contact) && isTestContact(contact, testContactSet())) {
    return NextResponse.json({ ok: true, skipped: "contacto interno" })
  }
  // Red de seguridad: prospección SOLO a países con línea y flujo propios
  // (Chile +56, Colombia +57). WhatsApp necesita el número internacional: si
  // tras normalizar no hay prefijo válido (ej. fijo local sin país), se salta.
  // La calificación fina vive en las assignment rules de Zoho.
  if (!porPrefijo) {
    // El lead NO se queda con Vicky (20-jul, caso Joys/Perú: la tómbola lo
    // asignó con Country "Chile" pero el teléfono era +51 — quedó mudo 2 días).
    // El país del formulario puede venir mal; el prefijo telefónico es la
    // verdad. Mismo acuerdo que el envío fallido: vuelve a un humano
    // (round-robin SDR Inbound) para que lo trabaje por otro canal.
    let reasignado: string | undefined
    if (zohoLeadId) {
      // Antes de reasignar, corrige el país en Zoho según el prefijo real
      // (así el SDR y los reportes ven la verdad, no el país del formulario).
      // 3 dígitos primero (59x) para no confundir con los de 2.
      const PREFIJO_PAIS: Array<[string, string]> = [
        ["593", "Ecuador"], ["591", "Bolivia"], ["595", "Paraguay"], ["598", "Uruguay"],
        ["507", "Panamá"], ["506", "Costa Rica"], ["502", "Guatemala"],
        ["51", "Perú"], ["52", "México"], ["54", "Argentina"], ["55", "Brasil"],
        ["58", "Venezuela"], ["34", "España"], ["1", "Estados Unidos"],
      ]
      const paisReal = PREFIJO_PAIS.find(([p]) => contact.startsWith(p))?.[1]
      if (paisReal) {
        // Territorio es picklist: solo se toca con valores conocidos del org.
        await updateZohoLeadFields(zohoLeadId, {
          Country: paisReal,
          ...(paisReal === "Perú" ? { Territorio: "Perú" } : {}),
        }).catch(() => {})
      }
      const r = await reasignarLeadSdrInbound(zohoLeadId).catch(() => null)
      reasignado = r?.ownerEmail
      console.warn(
        `[outbound-lead] telefono ${contact} sin prefijo +56/+57 (país real: ${paisReal || "desconocido"}) → lead ${zohoLeadId} reasignado a ${reasignado || "(reasignación falló)"}`,
      )
    }

    if (zohoLeadId) {
      await setKvValue(
        `outb_regalado_${zohoLeadId}`,
        JSON.stringify({ at: new Date().toISOString(), contact, motivo: "telefono_sin_prefijo", a: reasignado || "" }),
      ).catch(() => {})
    }
    return NextResponse.json({
      ok: true,
      skipped: `telefono sin prefijo +56/+57 utilizable${territorio ? ` (territorio ${territorio})` : ""}`,
      contact,
      reasignado,
    })
  }
  if (!tplPais) {
    return NextResponse.json({
      ok: true,
      skipped: `OUTBOUND_TEMPLATE_LEAD${esCO ? "_CO" : ""} no configurada`,
    })
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return NextResponse.json({ ok: false, error: "Supabase no configurado" }, { status: 503 })
  }

  // VISIBILIDAD INTER-CANAL (caso Ingesub, 20-jul): si el contacto ya tiene un
  // lead ABIERTO trabajado por otro ejecutivo (formulario duplicado, doble
  // canal), Vicky NO prospecta en paralelo — anota en ambos leads y el equipo
  // decide quién sigue. Política Lalo: el humano ya está trabajando el caso.
  const procesoHumano = await buscarLeadAbiertoDeOtroDueno(contact, email).catch(() => null)
  if (procesoHumano && (!zohoLeadId || procesoHumano.id !== zohoLeadId)) {
    const cuando = new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" })
    await agregarNotaLead(
      procesoHumano.id,
      "Lead duplicado llegó a Vicky — NO se prospectó",
      `Aviso automático (${cuando}): llegó un lead de formulario duplicado de este contacto (${nombre} · +${contact}${email ? ` · ${email}` : ""}) asignado a Vicky${zohoLeadId ? ` (lead ${zohoLeadId})` : ""}. Para evitar venta en paralelo, Vicky NO lo contactó. Si prefieren que lo trabaje Vicky, reasignen el lead duplicado y reenvíen el webhook.`,
    ).catch(() => {})
    if (zohoLeadId) {
      await agregarNotaLead(
        zohoLeadId,
        "Contacto ya trabajado por otro ejecutivo — Vicky no prospectó",
        `Aviso automático (${cuando}): este contacto ya tiene un lead abierto de ${procesoHumano.ownerNombre} (${procesoHumano.ownerEmail}), estado "${procesoHumano.status}". Vicky no envió el toque 0 para no vender en paralelo.`,
      ).catch(() => {})
    }
    // RE-NOTIFICACIÓN AL DUEÑO (regla 2 del doc de Gestión de Leads,
    // implementada 03-ago — caso Karina): además de la nota, el dueño recibe
    // un CORREO. La nota sola no funcionó: Eddyluz nunca se enteró de que su
    // lead volvió a llenar el formulario y el prospecto quedó mudo.
    if (procesoHumano.ownerEmail) {
      try {
        const { getZohoAccessToken } = await import("@/lib/zoho-token")
        const token = await getZohoAccessToken()
        const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
        await fetch(`${api}/crm/v3/Leads/${procesoHumano.id}/actions/send_mail`, {
          method: "POST",
          headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
          cache: "no-store",
          body: JSON.stringify({
            data: [{
              from: { email: "vicky@geovictoria.com" },
              to: [{ email: procesoHumano.ownerEmail }],
              subject: `Tu lead volvió a contactarnos: ${nombre || `+${contact}`} — retómalo hoy`,
              content: `<html><body style="font-family:Segoe UI,Arial,sans-serif;color:#2d3748;"><p>Tu lead <b>${nombre || ""} (+${contact})</b> acaba de llegar de nuevo por el formulario web — interés fresco. Como el lead sigue abierto a tu nombre, Vicky NO lo contactó para no vender en paralelo: <b>el seguimiento es tuyo</b>.</p><p>Si prefieres que lo trabaje Vicky, reasigna tu lead o avisa a Lalo.</p><p><a href="https://crm.zoho.com/crm/org685875245/tab/Leads/${procesoHumano.id}">Ver tu Lead en Zoho</a></p></body></html>`,
              mail_format: "html",
            }],
          }),
        })
      } catch { /* best-effort: la nota ya quedó */ }
    }
    console.warn(
      `[outbound-lead] ${contact} ya está en proceso con ${procesoHumano.ownerNombre} → toque 0 omitido, dueño notificado por correo`,
    )
    return NextResponse.json({
      ok: true,
      skipped: "contacto con lead abierto de otro ejecutivo — no se prospecta en paralelo",
      dueno: procesoHumano.ownerNombre,
      contact,
    })
  }

  // DEDUP: si ya existe conversación para el contacto, no tocarla (ya está
  // hablando con Vicky, o el workflow re-disparó).
  const existing = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_v3_conversations?contact=eq.${contact}&select=id&limit=1`,
    {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      cache: "no-store",
    },
  )
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => [])
  if (Array.isArray(existing) && existing.length > 0) {
    return NextResponse.json({ ok: true, skipped: "conversación ya existe", contact })
  }

  // CANDADO NÚMERO FIJO (caso Karla/Transportes Mobility, 10-ago): un fijo
  // (CL sin 569…, CO sin 573…) casi nunca tiene WhatsApp, y Meta NO emite
  // "undeliverable" para esos envíos — el mensaje queda en "sent" para
  // siempre, el candado 131026 del webhook de estados jamás se entera y el
  // lead muere en silencio con Vicky. Sin intento de WhatsApp: directo a un
  // humano con nota de LLAMAR. (MX queda fuera: su numeración móvil no es
  // distinguible por prefijo.)
  const esFijo =
    (contact.startsWith("56") && !contact.startsWith("569")) ||
    (contact.startsWith("57") && !contact.startsWith("573"))
  if (esFijo) {
    let reasignado: string | undefined
    if (zohoLeadId) {
      await agregarNotaLead(
        zohoLeadId,
        "Vicky: número FIJO — contactar por LLAMADA",
        `El teléfono del formulario (+${contact}) es un número fijo: no recibe WhatsApp, así que Vicky no envió la plantilla. Contactar por llamada telefónica${email ? ` o al correo ${email}` : ""}.`,
      ).catch(() => {})
      if (esMX) {
        const yahel = "ysegura@geovictoria.com"
        const r = await updateZohoLeadOwner(zohoLeadId, yahel).catch(() => null)
        reasignado = r?.success ? yahel : undefined
      } else if (esCO) {
        const r = await reasignarLeadSdrInboundCO(zohoLeadId).catch(() => null)
        reasignado = r?.ownerEmail
      } else {
        const { reasignarLeadTelemarketingCL } = await import("@/lib/zoho-leads")
        let r = await reasignarLeadTelemarketingCL(zohoLeadId).catch(() => null)
        if (!r?.success) r = await reasignarLeadSdrInbound(zohoLeadId).catch(() => null)
        reasignado = r?.ownerEmail
      }
    }

    if (zohoLeadId) {
      await setKvValue(
        `outb_regalado_${zohoLeadId}`,
        JSON.stringify({ at: new Date().toISOString(), contact, motivo: "numero_fijo", a: reasignado || "" }),
      ).catch(() => {})
    }
    console.warn(`[outbound-lead] número fijo +${contact} → sin WhatsApp; lead ${zohoLeadId || "(sin id)"} a ${reasignado || "humano (reasignación falló)"}`)
    return NextResponse.json({ ok: true, envio: "omitido_numero_fijo", contact, reasignado })
  }

  // GATE — NINGÚN BLOQUEO ES UN ENVÍO FALLIDO (31-ago, al retomar la
  // prospección de formularios; AMPLIADO la misma tarde tras el caso de los 8
  // leads regalados por `plantilla_repetida`). Cualquier bloqueo del gate es
  // NUESTRO y jamás debe leerse como "envío fallido":
  //   · motivos transitorios (ventana 9-21, anti-ráfaga) → APLAZAR: ok sin
  //     `skipped`, el poller no marca nada y reintenta cada 2 min.
  //   · plantilla_repetida → SKIP con motivo: desde hoy la marca solo se
  //     estampa con envío exitoso, así que repetida = ya la recibió.
  //   · cerrado_* (opt-out, perdido, soporte) → SKIP con motivo: a ese
  //     contacto no se le escribe, y el lead queda marcado en Zoho para que
  //     un humano decida.
  // En NINGÚN caso un bloqueo del gate entrega el lead a una SDR.
  {
    const { evaluarGateProactividad } = await import("@/lib/gate-proactividad")
    const gate = await evaluarGateProactividad(contact, { tipo: "plantilla", plantilla: tplPais })
    if (!gate.permitir && gate.motivos.length > 0) {
      const TRANSITORIOS = new Set(["fuera_de_9_21", "rafaga_10min"])
      if (gate.motivos.every((m) => TRANSITORIOS.has(m))) {
        console.log(`[outbound-lead] toque 0 APLAZADO ${contact}: ${gate.motivos.join(",")} — se reintenta en el próximo tick`)
        return NextResponse.json({ ok: true, aplazado: gate.motivos.join(","), contact })
      }
      console.warn(`[outbound-lead] toque 0 OMITIDO ${contact} por gate: ${gate.motivos.join(",")} — el lead queda con Vicky, marcado`)
      return NextResponse.json({ ok: true, skipped: `gate: ${gate.motivos.join(",")}`, contact })
    }
  }

  // 1. Plantilla HSM de apertura (variables por nombre, como las define Botmaker).
  const sent = await sendBotmakerTemplate(contact, tplPais, { nombre, empresa }, channelId).catch(() => false)
  if (!sent) {
    // PRESUPUESTO DE REINTENTOS (Lalo 31-ago, tras los 8 leads regalados): un
    // fallo real de envío ya no entrega el lead al primer golpe — el poller
    // vuelve cada 2 minutos y acá se cuentan los intentos. Recién al TERCER
    // fallo el lead pasa a un humano, y con el motivo escrito en
    // Comentario_Vicky (que quedara vacío fue lo que hizo invisible el bug).
    if (zohoLeadId) {
      const kIntentos = `outb_intentos_${zohoLeadId}`
      const intentos = Number((await getKvValue(kIntentos).catch(() => null)) || 0) + 1
      if (intentos < 3) {
        await setKvValue(kIntentos, String(intentos)).catch(() => {})
        // liberar el candado para que el reintento del poller entre
        await setKvValue(`outb_lock_${zohoLeadId}`, "0").catch(() => {})
        console.warn(`[outbound-lead] envío falló (intento ${intentos}/3) lead=${zohoLeadId} — se reintenta, el lead SIGUE con Vicky`)
        return NextResponse.json({ ok: true, aplazado: `envio_fallido_${intentos}`, contact })
      }
      await updateZohoLeadFields(zohoLeadId, {
        Comentario_Vicky: `Outbound: envío de plantilla falló 3 veces (${new Date().toISOString().slice(0, 16)}Z) → entregado al equipo`,
      }).catch(() => {})
    }
    // Acuerdo con Marketing (jul-2026): agotados los reintentos, el lead
    // vuelve a un humano (round-robin SDR Inbound del país correspondiente).
    let reasignado: string | undefined
    if (zohoLeadId) {
      if (esMX) {
        // México v1: sin round-robin SDR — el lead va directo al ejecutivo MX
        // (Yahel Segura) para contacto manual.
        const yahel = "ysegura@geovictoria.com"
        const r = await updateZohoLeadOwner(zohoLeadId, yahel).catch(() => null)
        reasignado = r?.success ? yahel : undefined
        await agregarNotaLead(
          zohoLeadId,
          "Vicky: WhatsApp de apertura falló",
          "No se pudo enviar la plantilla de apertura por la línea MX. El lead requiere contacto manual.",
        ).catch(() => {})
      } else if (esCO) {
        const r = await reasignarLeadSdrInboundCO(zohoLeadId).catch(() => null)
        reasignado = r?.ownerEmail
      } else {
        // CL: telemarketing por la regla de Zoho (Lalo 04-ago); SDR de fallback.
        const { reasignarLeadTelemarketingCL } = await import("@/lib/zoho-leads")
        let r = await reasignarLeadTelemarketingCL(zohoLeadId).catch(() => null)
        if (!r?.success) r = await reasignarLeadSdrInbound(zohoLeadId).catch(() => null)
        reasignado = r?.ownerEmail
      }
      console.warn(`[outbound-lead] envío falló → lead ${zohoLeadId} reasignado a ${reasignado || "(reasignación falló)"}`)
    }

    if (zohoLeadId) {
      await setKvValue(
        `outb_regalado_${zohoLeadId}`,
        JSON.stringify({ at: new Date().toISOString(), contact, motivo: "envio_fallido_3_intentos", a: reasignado || "" }),
      ).catch(() => {})
    }
    return NextResponse.json(
      { ok: false, error: "fallo el envío de la plantilla", contact, reasignado },
      { status: 502 },
    )
  }
  // Diccionario Vicky (acuerdo con Marketing): envío de mensaje = intento de
  // contacto. Best-effort: no bloquea la respuesta al workflow.
  if (zohoLeadId) {
    await updateZohoLeadStatus(zohoLeadId, "2. Intento de contacto").catch(() => {})
  }

  // 2. Persistir la apertura + contexto del formulario. El bloque [Datos del
  // formulario web: ...] es CONTEXTO INTERNO para Vicky (el prompt le enseña a
  // usarlo sin citarlo); el cliente solo recibió la plantilla. El country
  // marca la conversación para que la respuesta corra el agente del país y
  // los toques salgan por su línea y en su zona horaria.
  // Espejos 1:1 de las plantillas reales (si se edita una plantilla en
  // Botmaker, actualizar el literal en el mismo cambio):
  // CO → UTILITY vicky_co_solicitud_recibida · CL → vicky_lead_apertura_v3
  // (v3 pide de una la cantidad de personas: ahorra un turno y la respuesta
  // ya es la calificación — decisión Lalo/Rodrigo 17-jul) · MX → UTILITY
  // vicky_mx_lead_apertura (21-jul, vocabulario es-mx: "registrarían su
  // asistencia").
  // CL finde → espejo de vicky_t0_finde ("¿ahora o el lunes?").
  const saludoApertura =
    !esMX && !esCO && finde
      ? `Hola ${nombre}, soy Vicky de GeoVictoria 👋 Recibimos tu solicitud de cotización para ${empresa}. ¿Quieres conversar ahora o prefieres que te contacte el lunes?`
      : esMX
        ? `Hola ${nombre} 👋 Soy Vicky de GeoVictoria. Recibimos tu solicitud de cotización para ${empresa}. ¿Cuántas personas registrarían su asistencia? Con ese dato te armo el valor de inmediato.`
        : esCO
          ? `Hola ${nombre}, te escribimos de GeoVictoria por la solicitud de cotización que registraste para ${empresa}. Puedes completarla por este medio: responde este mensaje y continuamos con el detalle.`
          : `Hola ${nombre} 👋 Soy Vicky de GeoVictoria. Recibimos tu solicitud de cotización para ${empresa}. ¿Cuántas personas marcarían asistencia? Con eso te la armo de inmediato.`
  const ctx = [
    saludoApertura,
    ``,
    // OJO con la empresa: el fallback "tu empresa" existe para que la PLANTILLA
    // lea natural ("...cotización para tu empresa"), pero acá adentro NO puede
    // presentarse como si fuera la razón social — Vicky se lo creía y emitió
    // cotizaciones formales a nombre de "tu empresa" (3 casos reales, 21–24 jul:
    // Notaría Almendras $334.188 entre ellos). Si el formulario no la trajo, el
    // contexto lo dice explícito para que Vicky la PREGUNTE antes de cotizar.
    `[Datos del formulario web: nombre ${[nombre, apellido].filter(Boolean).join(" ")}` +
      ` · empresa ${empresa === "tu empresa" ? "NO INDICADA (el formulario vino sin razón social: pregúntala antes de la cotización formal)" : empresa}` +
      `${rango ? ` · ${rango} empleados` : ""}${email ? ` · email ${email}` : ""}` +
      `${paginaInteres ? ` · convirtió en la página ${paginaInteres} (úsalo como pista de qué le interesa, sin citar la URL)` : ""}` +
      `${zohoLeadId ? ` · zohoLeadId ${zohoLeadId}` : ""}]`,
  ].join("\n")
  await appendAssistantV3(contact, ctx, esMX ? "mx" : esCO ? "co" : "cl").catch(() => {})

  // Primera respuesta del lead OUTBOUND = el toque 0 (regla Lalo 10-ago): la
  // métrica del equipo mide desde que salió la primera plantilla, no desde
  // que un humano abre el lead después. Best-effort, jamás frena el flujo.
  if (zohoLeadId) {
    updateZohoLeadFields(zohoLeadId, {
      Fecha_de_Primera_revision_Lead: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    }).catch(() => {})
  }

  // 3. Arranca la CADENCIA multicanal (correos vía Zoho + HSM día 1/7): el cron
  // vic-outbound-cadence-cron toma esta fila; cualquier respuesta la corta.
  await fetch(`${SUPABASE_URL}/rest/v1/vic_outbound_cadence?on_conflict=contact`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({
      contact,
      zoho_lead_id: zohoLeadId || null,
      email: email || null,
      nombre,
      empresa,
    }),
    cache: "no-store",
  }).catch(() => {})

  // 4. Loop v2 (flag LOOP_V2_ENABLED, no-op apagado): el lead nuevo queda
  // enrolado en el loop de toques — la cadencia del paso 3 lo salta mientras
  // tenga fila en vic_loop (contactosEnLoop), así no hay doble toque. MX
  // entra desde el 25-jul (número +52 conectado y flujo de voz creado).
  await enrolarEnLoop(contact, esMX ? "mx" : esCO ? "co" : "cl").catch(() => {})

  console.log(`[outbound-lead] toque 0 → ${contact} (${empresa}${rango ? `, ${rango}` : ""})`)
  return NextResponse.json({ ok: true, contact, empresa, template: tplPais, cadencia: "iniciada" })
}
