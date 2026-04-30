import { Langfuse } from "langfuse"

function getLangfuse() {
  const publicKey = (process.env.LANGFUSE_PUBLIC_KEY || "").trim()
  const secretKey = (process.env.LANGFUSE_SECRET_KEY || "").trim()
  const baseUrl = (process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com").trim()
  if (!publicKey || !secretKey) return null
  return new Langfuse({ publicKey, secretKey, baseUrl, flushAt: 1, flushInterval: 500 })
}

export type LangfuseTrace = ReturnType<Langfuse["trace"]>

export function createConversationTrace(params: {
  contact: string
  lead?: Record<string, unknown>
  sessionId?: string
}): { trace: LangfuseTrace | null; lf: Langfuse | null } {
  const lf = getLangfuse()
  if (!lf) return { trace: null, lf: null }

  const trace = lf.trace({
    name: "vicky-conversation",
    userId: params.contact,
    sessionId: params.sessionId || params.contact,
    metadata: { lead: params.lead || {} },
    tags: ["whatsapp", "vicky"],
  })

  return { trace, lf }
}

export async function traceGeneration(params: {
  trace: LangfuseTrace
  lf: Langfuse
  name: string
  model: string
  input: unknown
  output: string
  inputTokens?: number
  outputTokens?: number
  startTime: Date
  metadata?: Record<string, unknown>
}) {
  const gen = params.trace.generation({
    name: params.name,
    model: params.model,
    input: params.input,
    startTime: params.startTime,
    metadata: params.metadata,
  })

  gen.end({
    output: params.output,
    usage: {
      input: params.inputTokens,
      output: params.outputTokens,
      unit: "TOKENS",
    },
  })

  await params.lf.flushAsync()
}

export async function traceScore(params: {
  trace: LangfuseTrace
  lf: Langfuse
  name: string
  value: number
  comment?: string
}) {
  params.trace.score({
    name: params.name,
    value: params.value,
    comment: params.comment,
  })
  await params.lf.flushAsync()
}
