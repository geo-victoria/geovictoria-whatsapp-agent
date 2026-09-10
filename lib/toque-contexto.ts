/**
 * TOQUE 5 PERSONALIZADO (Rodrigo + Lalo 26-ago, documento v21 — solo CHILE).
 *
 * El toque 5 del loop deja la plantilla fija por etapa y pasa a TEXTO LIBRE
 * generado por conversación en el momento del despacho: menciona el dolor
 * operativo concreto que el cliente contó y la etapa exacta donde quedó —
 * el mismo patrón que la campaña del 10% del 26-ago, pero generado al vuelo
 * en vez de pre-redactado.
 *
 * Contratos:
 *  - Falla o conversación sin sustancia → null, y el llamador cae al texto
 *    fijo de siempre (el toque JAMÁS se pierde por culpa de la generación).
 *  - Guardrail determinista: tope de largo con corte en borde de oración,
 *    sin guiones largos, sin "Oye", una sola idea de retome.
 *  - Fuera de la ventana de 24h el texto viaja como variable `contexto` de la
 *    plantilla (patrón probado hoy con campana_contexto_vicky_p1_v2): sin
 *    saltos de línea y más corto.
 */

import Anthropic from "@anthropic-ai/sdk"
import { fetchHistoryV3 } from "./supabase-persistence-v3"

const MODEL = (process.env.VICKY_TOQUE5_MODEL || "claude-haiku-4-5-20251001").trim()
const MAX_CHARS = 480

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

/** Conversación del cliente con su EJECUTIVO por el WhatsApp espejado
 * (Lalo 27-ago: el toque también incorpora lo clave del espejo, y con
 * conversación de vendedor el foco pasa a "¿cómo te fue con X?"). */
async function transcriptEspejo(
  contact: string,
): Promise<{ transcript: string; vendedorSesion: string; vendedorNombre: string } | null> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null
  try {
    const limpio = contact.replace(/\D/g, "")
    const nueve = limpio.slice(-9)
    const H = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    // EL ESPEJO DEL EJECUTIVO ASIGNADO, NO DE CUALQUIERA (09-sep, caso
    // Sebastián SAIC: el toque le nombró a Paola, el traspaso era de Aleydis
    // y quien cotizó fue Anderson — tres nombres en 24 h). Si el contacto
    // tiene traspaso activo, solo cuenta el WhatsApp de ESE vendedor; sin
    // traspaso, cualquier espejo que haya hablado con el número.
    let sesionPtv = ""
    let nombrePtv = ""
    try {
      const rp = await fetch(
        `${SUPABASE_URL}/rest/v1/vic_ptv?contact=eq.${encodeURIComponent(limpio)}&estado=eq.activo&select=vendedor_email,vendedor_nombre&order=traspasado_at.desc&limit=1`,
        { headers: H, cache: "no-store" },
      )
      const fila = rp.ok ? (((await rp.json().catch(() => [])) as Array<{ vendedor_email?: string; vendedor_nombre?: string }>)[0] || null) : null
      sesionPtv = String(fila?.vendedor_email || "").split("@")[0].trim().toLowerCase()
      nombrePtv = String(fila?.vendedor_nombre || "").trim()
    } catch { /* sin traspaso legible: espejo libre */ }
    const desde = new Date(Date.now() - 14 * 86_400_000).toISOString()
    const filtroSesion = sesionPtv ? `&session_id=eq.${encodeURIComponent(sesionPtv)}` : ""
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_wa_espejo_mensajes?select=from_me,texto,enviado_at,session_id&telefono_chat=like.*${nueve}&es_grupo=eq.false&enviado_at=gte.${encodeURIComponent(desde)}${filtroSesion}&order=enviado_at.desc&limit=16`,
      { headers: H, cache: "no-store" },
    )
    if (!r.ok) return null
    const filas = ((await r.json().catch(() => [])) as Array<{
      from_me: boolean
      texto?: string
      session_id?: string
    }>) || []
    if (!filas.length) return null
    const transcript = filas
      .reverse()
      .map((f) => `${f.from_me ? "Ejecutivo" : "Cliente"}: ${String(f.texto || "").slice(0, 300)}`)
      .join("\n")
      .slice(-3000)
    return {
      transcript,
      vendedorSesion: sesionPtv || filas.find((f) => f.from_me)?.session_id || "",
      vendedorNombre: nombrePtv,
    }
  } catch {
    return null
  }
}

const REGLAS = [
  "Eres Vicky, la vendedora de GeoVictoria por WhatsApp (control de asistencia y gestión de personal en Chile).",
  "Vas a escribir UN solo mensaje corto para retomar el contacto con un cliente que dejó de responder hace días.",
  "Reglas estrictas:",
  "1. Dos o tres frases, máximo 400 caracteres.",
  "2. Menciona la operación o el dolor CONCRETO que el cliente contó (su rubro, su equipo, su problema, con sus palabras) y el punto exacto donde quedó la conversación.",
  "3. UNA sola pregunta, al final del mensaje.",
  "4. NO saludes ni te presentes: tu texto va DENTRO de un mensaje que ya parte con 'Hola, todo bien?' — entra directo al tema.",
  "5. Prohibido partir con 'Oye'. Prohibido usar guiones largos, negritas o listas.",
  "6. Tuteo chileno neutro y cercano, sin jerga.",
  "7. No inventes datos, precios ni promesas que no estén en la conversación. No ofrezcas descuentos.",
  // (Lalo 04-sep) "Los toques son muy malos en contenido, son apelando al pago,
  // y deberían apelar a cómo resolvemos los dolores que levantó durante la
  // conversación." En etapa formal el cliente ya tiene su cotización: si no
  // avanzó fue por algo, y pedirle el pago por cuarta vez no lo resuelve.
  "8. NO pidas el pago ni digas 'acepta y paga'. El cliente que ya tiene su cotización no se frenó por falta de un recordatorio: se frenó por una duda, una comparación o algo de su operación. Tu trabajo es retomar ESO. El pago se pide solo cuando el cliente ya aceptó y lo único que falta es pagar.",
  "9. Si el cliente dejó una duda sin responder, una objeción o una comparación con otro proveedor, ese es el tema del mensaje.",
  "10. Si el cliente ya dijo que NO le interesa, que ya contrató otra cosa, que se desvinculó de la empresa, que cerró la conversación o que no le escriban más, NO escribas ningún mensaje: responde exactamente NO_ENVIAR y nada más.",
  "Responde SOLO con el texto del mensaje, sin comillas ni explicaciones. Jamás expliques tu razonamiento ni describas al cliente en tercera persona: eso NO es un mensaje.",
].join("\n")

function recortarEnOracion(texto: string, max: number): string {
  if (texto.length <= max) return texto
  const corte = texto.slice(0, max)
  const fin = Math.max(corte.lastIndexOf(". "), corte.lastIndexOf("? "), corte.lastIndexOf("! "))
  return fin > 40 ? corte.slice(0, fin + 1).trim() : corte.trim()
}

export async function generarToqueContexto(
  contact: string,
  stage: "sin_precio" | "con_precio" | "formal",
): Promise<string | null> {
  try {
    const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim()
    if (!apiKey) return null
    const historia = await fetchHistoryV3(contact, 30)
    // Sin conversación real no hay contexto que personalizar.
    if (!historia || historia.filter((m) => m.role === "user").length < 2) return null

    const transcript = historia
      .map((m) => `${m.role === "user" ? "Cliente" : "Vicky"}: ${String(m.content || "").slice(0, 400)}`)
      .join("\n")
      .slice(-6000)

    const etapa =
      stage === "sin_precio"
        ? "aún no ve precio; falta saber cuántas personas marcarían y cómo"
        : stage === "con_precio"
          ? "ya vio el valor referencial; solo falta el RUT (o su ok) para dejarle la cotización formal"
          : "tiene la cotización formal lista para aceptar y pagar en línea"

    // ESPEJO DEL EJECUTIVO (Lalo 27-ago): si el cliente ya conversó con un
    // vendedor humano, el toque cambia de naturaleza — el foco es preguntar
    // CÓMO LE FUE con el ejecutivo y recoger lo clave de ESA conversación
    // (Vicky nunca se apaga: acompaña como equipo, no compite).
    const espejo = await transcriptEspejo(contact).catch(() => null)
    let nombreEjecutivo = espejo?.vendedorNombre ? espejo.vendedorNombre.split(/\s+/)[0] : ""
    if (!nombreEjecutivo && espejo?.vendedorSesion) {
      try {
        const { directorioEjecutivos } = await import("./directorio-ejecutivos")
        const ficha = directorioEjecutivos().find((f) =>
          f.email.toLowerCase().startsWith(espejo.vendedorSesion.toLowerCase() + "@"),
        )
        nombreEjecutivo = ficha?.nombre?.split(/\s+/)[0] || ""
      } catch { /* sin nombre: se dice "nuestro ejecutivo" */ }
    }
    const bloqueEspejo = espejo
      ? `\n\nCONVERSACIÓN DEL CLIENTE CON ${nombreEjecutivo ? `SU EJECUTIVO/A ${nombreEjecutivo.toUpperCase()}` : "SU EJECUTIVO/A"} (por el WhatsApp del ejecutivo):\n${espejo.transcript}\n\nINSTRUCCIÓN ESPECIAL: como el cliente ya está conversando con ${nombreEjecutivo || "un ejecutivo del equipo"}, tu mensaje debe centrarse en preguntarle CÓMO LE FUE con ${nombreEjecutivo || "el ejecutivo"} y recoger con naturalidad lo clave que quedó en esa conversación (un acuerdo, una duda, un pendiente). Preséntate como parte del mismo equipo que acompaña, JAMÁS contradigas ni repitas lo que el ejecutivo ya ofreció, y no cites frases textuales.`
      : ""

    const client = new Anthropic({ apiKey })
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 300,
      system: REGLAS,
      messages: [
        {
          role: "user",
          content: `TRANSCRIPCIÓN DE LA CONVERSACIÓN CON VICKY:\n${transcript}\n\nETAPA EN QUE QUEDÓ: ${etapa}${bloqueEspejo}\n\nEscribe el mensaje de retome.`,
        },
      ],
    })
    let texto = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim()
    texto = texto.replace(/^["«“]+|["»”]+$/g, "").trim()
    // El modelo decidió que no corresponde escribir (rechazo previo del
    // cliente) o devolvió razonamiento en vez de mensaje: se devuelve TAL CUAL
    // para que el llamador lo reconozca (pareceTextoInterno) y NO mande nada.
    const { pareceTextoInterno } = await import("./rechazo-cliente")
    if (pareceTextoInterno(texto)) return "NO_ENVIAR"
    if (!texto || texto.length < 30) return null
    if (/^oye\b/i.test(texto)) return null
    // Estilo sellado: sin guiones largos (parecen IA — Lalo 26-ago).
    texto = texto.replace(/\s*—\s*/g, ", ").replace(/\s{2,}/g, " ")
    // NINGÚN PRECIO SIN RESPALDO, también acá (04-sep). El toque generado cita
    // cifras cuando la conversación las tuvo ("$67.616 al mes"), y eso está
    // bien; lo que no puede hacer es componer una nueva. Se compara contra lo
    // que Vicky YA le dijo a este contacto: si aparece un monto que nadie le
    // dio, el toque generado se descarta y sale el texto fijo de siempre.
    // El toque nunca se pierde por esto — a lo más pierde personalización.
    const { chequearPreciosDelReply } = await import("./precio-sin-tool")
    const dichos = historia.filter((m) => m.role === "assistant").map((m) => String(m.content || ""))
    const chequeo = chequearPreciosDelReply(texto, [], dichos)
    if (chequeo.hayInventado) {
      console.warn(
        `[toque-contexto] ${contact}: PRECIO SIN RESPALDO en el toque generado (${chequeo.inventados.join(", ")}) — se usa el texto fijo`,
      )
      return null
    }
    // El marco del llamador ya saluda ("Hola, todo bien? …"): si el modelo
    // saludó igual, se le quita (08-sep: "Hola, todo bien? Hola, todo bien?").
    const { quitarSaludoInicial } = await import("./rechazo-cliente")
    texto = quitarSaludoInicial(texto)
    // CINTURÓN DE ESTILO, TAMBIÉN EN LOS TOQUES (Lalo 10-sep: "no puedes decir
    // 'pasai', es muy informal"). El saneador anti-voseo corría en los cuatro
    // webhooks y en el canario, pero NO en el loop: el toque generado se
    // enviaba crudo y salió "¿me pasai el RUT?" — el mapa ya tenía el patrón,
    // le faltaba pasar por acá. Cubre el texto en ventana y la variable
    // ${contexto} de la plantilla (las dos salen de esta función).
    const { sanitizarVoseo, normalizarFormatoWhatsApp, quitarSignosApertura } = await import("./voseo-v3")
    texto = quitarSignosApertura(normalizarFormatoWhatsApp(sanitizarVoseo(texto)))
    return recortarEnOracion(texto, MAX_CHARS)
  } catch (e) {
    console.error(`[toque5] generación falló ${contact}:`, e instanceof Error ? e.message : e)
    return null
  }
}

/** Versión para variable de plantilla: una línea, corta, sin saltos. */
export function contextoParaPlantilla(texto: string): string {
  return recortarEnOracion(texto.replace(/\s*\n+\s*/g, " ").trim(), 340)
}
