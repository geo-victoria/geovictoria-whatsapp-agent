import { NextResponse } from "next/server"

const globalStore = globalThis as unknown as {
  __vicConversations?: Map<string, unknown>
}

export async function POST(request: Request) {
  const secret = request.headers.get("x-secret") || ""
  if (secret !== (process.env.BOTMAKER_SECRET || "").trim()) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { contact } = await request.json() as { contact?: string }
  if (!contact) {
    return NextResponse.json({ error: "contact requerido" }, { status: 400 })
  }

  const clean = contact.replace(/\D/g, "")
  const deleted = globalStore.__vicConversations?.delete(clean) ?? false

  return NextResponse.json({ success: true, contact: clean, wasInMemory: deleted })
}
