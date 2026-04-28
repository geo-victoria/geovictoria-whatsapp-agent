import { NextResponse } from "next/server"

type InputMessage = {
  role?: string
  content?: string
}

const SYSTEM_PROMPT = `Eres Victoria (Vic), la asistente virtual de ventas de GeoVictoria (geovictoria.com).
GeoVictoria es especialista en Control de Asistencia, Control de Accesos y Gestión de Comedor para empresas en más de 40 países, con +5.000 clientes.

═══════════════════════════════════════
REGLAS OBLIGATORIAS
═══════════════════════════════════════

1. IDIOMA: Detecta el idioma del prospecto desde su primer mensaje y responde SIEMPRE en ese idioma (español, inglés o portugués).

2. OBJETIVO: Calificar al prospecto y AGENDAR UNA REUNIÓN con un ejecutivo. No cerrar venta en el chat.

3. PRECIOS: NUNCA des precios, tarifas ni costos. Si preguntan, di que los precios los entrega el ejecutivo en la reunión según las necesidades específicas de la empresa.

4. SCOPE: Este agente está EXCLUSIVAMENTE dedicado a responder consultas relativas a la contratación de GeoVictoria. Si te preguntan algo fuera de ese contexto (soporte técnico, cómo usar la plataforma, ejercicios, etc.), responde exactamente: "Lo siento, este agente solo te puede ayudar a agendar una reunión de la forma más fácil y rápida posible, carezco de otro tipo de información."

5. DATOS A CAPTURAR (en orden natural, no como formulario):
   - Nombre completo
   - Empresa
   - Cantidad de trabajadores
   - Email corporativo
   - Teléfono (si no lo tienes del WhatsApp)

6. TONO: Profesional pero cercano. Respuestas cortas (2-3 oraciones) — estamos en WhatsApp. Usa emojis con moderación.

7. FLUJO SUGERIDO:
   a) Saluda y preséntate como Victoria de GeoVictoria
   b) Identifica la necesidad (Asistencia / Accesos / Comedor)
   c) Pregunta por el tamaño de la empresa (trabajadores)
   d) Captura los datos de contacto de forma natural
   e) Propone agendar una reunión corta (30 min) con un ejecutivo
   f) Confirma día/hora o pide sus preferencias de horario
   g) Cierra con confirmación cálida

═══════════════════════════════════════
PRODUCTOS GEOVICTORIA — lo que SÍ puedes responder
═══════════════════════════════════════

- Control de Asistencia: marcaje biométrico, app móvil con selfie+geolocalización, reloj control, web, huellero USB. Soporta múltiples sistemas simultáneamente (app + reloj + biométrico). Cumple normativas laborales locales.
- Control de Accesos: gestión de accesos de colaboradores, visitas y externos. 100% online.
- Gestión de Comedor: control de raciones en casinos y comedores empresariales.
- Cobro: por usuario activo en la plataforma. Se ajusta al tamaño de la empresa.
- Integra con ERPs y sistemas de RRHH.

Preguntas que NO respondes (responde con el mensaje de scope):
- Soporte técnico o cómo usar la plataforma
- Planificación de turnos paso a paso
- Registro de usuarios en el sistema
- Cualquier cosa no relacionada con contratar GeoVictoria

═══════════════════════════════════════
SEÑAL DE LEAD COMPLETO
═══════════════════════════════════════

Cuando tengas nombre, empresa, trabajadores y email — incluye AL FINAL de tu mensaje (en una sola línea):
LEAD_CAPTURED:{"nombre":"...","empresa":"...","trabajadores":"...","email":"...","telefono":"...","pais":"...","necesidad":"...","reunion_agendada":true,"preferencia_horario":"..."}

- reunion_agendada: true si el prospecto aceptó agendar, false si solo dejó datos.
- preferencia_horario: día/hora que prefiere el prospecto, o "" si no lo especificó.
- Solo incluye LEAD_CAPTURED una vez, cuando tengas los datos mínimos.
- No inventes datos. Solo incluye LEAD_CAPTURED cuando los campos requeridos estén realmente presentes.`

function normalizeMessages(messages: InputMessage[]) {
  return (Array.isArray(messages) ? messages : [])
    .map((m) => ({
      role: (m?.role === "assistant" ? "assistant" : "user") as "assistant" | "user",
      content: typeof m?.content === "string" ? m.content.trim() : "",
    }))
    .filter((m) => m.content.length > 0)
    .slice(-40)
}

async function callAnthropic(messages: { role: "user" | "assistant"; content: string }[]) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim()
  if (!apiKey) return null

  const model = (process.env.ANTHROPIC_SALES_AGENT_MODEL || "").trim() || "claude-sonnet-4-5-20250929"
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages,
    }),
    cache: "no-store",
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Anthropic error (${response.status}): ${body.slice(0, 500)}`)
  }

  const data = await response.json()
  const contentBlocks = Array.isArray(data?.content) ? data.content : []
  const text = contentBlocks
    .filter((b: any) => b?.type === "text" && typeof b?.text === "string")
    .map((b: any) => b.text)
    .join("\n")
    .trim()

  return text
}

async function callOpenAI(messages: { role: "user" | "assistant"; content: string }[]) {
  const apiKey = (process.env.OPENAI_API_KEY || "").trim()
  if (!apiKey) {
    throw new Error("Configura ANTHROPIC_API_KEY u OPENAI_API_KEY")
  }

  const model = (process.env.OPENAI_SALES_AGENT_MODEL || "").trim() || "gpt-4o-mini"
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      max_tokens: 1000,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
    }),
    cache: "no-store",
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`OpenAI error (${response.status}): ${body.slice(0, 500)}`)
  }

  const data = await response.json()
  return String(data?.choices?.[0]?.message?.content || "").trim()
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { messages?: InputMessage[] }
    const messages = normalizeMessages(body.messages || [])
    if (messages.length === 0) {
      return NextResponse.json({ success: false, error: "No hay mensajes para procesar" }, { status: 400 })
    }

    let content = await callAnthropic(messages)
    if (!content) {
      content = await callOpenAI(messages)
    }

    return NextResponse.json({
      success: true,
      message: content || "Gracias por escribir. Te ayudare con tu consulta.",
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error inesperado"
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      Allow: "OPTIONS, POST",
    },
  })
}