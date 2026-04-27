import { NextResponse } from "next/server"

type InputMessage = {
  role?: string
  content?: string
}

const SYSTEM_PROMPT = `You are Vic, GeoVictoria's inbound sales assistant for attendance control, access control, and cafeteria management.

Primary goal:
- Qualify inbound prospects and end by proposing/scheduling a sales meeting.

Required qualification fields:
- full name
- company
- role/title
- email
- phone
- workers count
- country/city
- current system (if any)
- main need (attendance/access/cafeteria)

Hard rules:
- Detect the prospect language and always reply in that same language (Spanish, English, or Portuguese).
- Do NOT provide prices in chat. If asked about pricing, explain pricing is reviewed by a sales executive during a meeting.
- Keep replies concise: max 2-3 short sentences.
- Ask for one missing piece of info at a time.
- Be professional, warm, and direct.

When you have at least: name, company, role, email, phone,
append EXACTLY this marker at the end of your final message:
LEAD_CAPTURED:{"nombre":"...","empresa":"...","cargo":"...","correo":"...","telefono":"...","pais":"...","trabajadores":"...","necesidad":"...","idioma":"...","agendar_reunion":"si|pendiente"}

Do not invent data. Only include LEAD_CAPTURED when required fields are truly present.`

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