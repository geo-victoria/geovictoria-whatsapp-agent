import { NextResponse } from "next/server"
import { fetchConversations, isSupabaseConfigured } from "@/lib/supabase-persistence"

type ConversationMessage = {
  role: "user" | "assistant"
  content: string
  at: string
}

type LeadData = {
  nombre?: string
  empresa?: string
  cargo?: string
  correo?: string
  telefono?: string
  pais?: string
  trabajadores?: string
  necesidad?: string
  idioma?: string
  agendar_reunion?: string
}

type ConversationState = {
  contact: string
  startedAt: string
  updatedAt: string
  lastUserAt?: string
  messages: ConversationMessage[]
  lead?: LeadData
  lastEvaluationAt?: string
  lastEvaluation?: {
    score_total: number
    conversion: number
    engagement: number
    calidad_info: number
    tono_experiencia: number
    diagnostico_abandono: string
    tramo: "80-100" | "50-79" | "20-49" | "0-19"
    analizadas: number
  }
}

const globalStore = globalThis as unknown as { __vicConversations?: Map<string, ConversationState> }
if (!globalStore.__vicConversations) {
  globalStore.__vicConversations = new Map<string, ConversationState>()
}

function getEnv(name: string) {
  return (process.env[name] || "").trim()
}

export async function GET(request: Request) {
  const adminSecret = getEnv("ADMIN_API_SECRET")
  if (adminSecret) {
    const headerSecret = request.headers.get("x-admin-secret") || ""
    if (headerSecret !== adminSecret) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
    }
  }

  const url = new URL(request.url)
  const contact = (url.searchParams.get("contact") || "").trim()
  const memoryConversations = Array.from(globalStore.__vicConversations?.values() || [])

  if (isSupabaseConfigured()) {
    const persistent = await fetchConversations(contact)
    if (contact) {
      return NextResponse.json({ success: true, source: "supabase", data: persistent || null })
    }

    const list = Array.isArray(persistent) ? persistent : []
    return NextResponse.json({
      success: true,
      source: "supabase",
      count: list.length,
      data: list,
    })
  }

  if (contact) {
    const one = memoryConversations.find((c) => c.contact === contact)
    return NextResponse.json({ success: true, source: "memory", data: one || null })
  }

  return NextResponse.json({
    success: true,
    source: "memory",
    count: memoryConversations.length,
    data: memoryConversations.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
  })
}
