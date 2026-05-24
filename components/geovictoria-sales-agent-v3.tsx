"use client"

/**
 * Componente de chat para probar Vicky V3 en /vic-v3.
 *
 * Mantiene historial conversacional en estado React (efímero, se pierde
 * al refrescar). Cada mensaje se envía a /api/vic-sales-agent-v3 junto
 * con el historial completo de la conversación.
 *
 * Muestra el debug pane lateral con:
 *   - Cantidad de iteraciones del agent loop por turno
 *   - Tools invocadas por turno (con ok/fail)
 *   - Handoff flag si se activó
 *
 * Esto permite a Eduardo y Nico validar visualmente que las tools se están
 * usando como esperan, sin necesidad de leer Langfuse.
 */

import { useState, useRef, useEffect } from "react"

type Role = "user" | "assistant" | "system-debug"

type ToolCall = { name: string; input: unknown; ok: boolean }

type Message = {
  id: string
  role: Role
  content: string
  toolCalls?: ToolCall[]
  iterations?: number
  handoff?: boolean
  ts: number
}

const INITIAL_MESSAGE: Message = {
  id: "init",
  role: "assistant",
  content:
    "¡Hola! Soy Vicky, de GeoVictoria. Te ayudo si querés cotizar para tu empresa. ¿Cuántas personas trabajan ahí?",
  ts: Date.now(),
}

export default function VickyV3Chat() {
  const [messages, setMessages] = useState<Message[]>([INITIAL_MESSAGE])
  const [input, setInput] = useState("")
  const [loading, setLoading] = useState(false)
  const [showDebug, setShowDebug] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
  }, [messages])

  async function handleSend() {
    const trimmed = input.trim()
    if (!trimmed || loading) return

    const userMsg: Message = {
      id: `u-${Date.now()}`,
      role: "user",
      content: trimmed,
      ts: Date.now(),
    }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setInput("")
    setLoading(true)

    try {
      // Historial para el endpoint: solo user/assistant, sin debug
      const history = newMessages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-40)
        .slice(0, -1) // sin el último, que va en `message`
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))

      const res = await fetch("/api/vic-sales-agent-v3", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ history, message: trimmed }),
      })

      const data = await res.json()

      if (!res.ok) {
        setMessages((prev) => [
          ...prev,
          {
            id: `a-${Date.now()}`,
            role: "assistant",
            content: data.error || "Error procesando tu mensaje.",
            ts: Date.now(),
          },
        ])
      } else {
        setMessages((prev) => [
          ...prev,
          {
            id: `a-${Date.now()}`,
            role: "assistant",
            content: data.reply || "(sin respuesta)",
            toolCalls: data.toolCalls,
            iterations: data.iterations,
            handoff: data.handoff,
            ts: Date.now(),
          },
        ])
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: "assistant",
          content: "Tuve un problema de conexión. Intentá de nuevo en un momento.",
          ts: Date.now(),
        },
      ])
    } finally {
      setLoading(false)
    }
  }

  function handleReset() {
    setMessages([{ ...INITIAL_MESSAGE, ts: Date.now() }])
    setInput("")
  }

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Chat principal */}
      <div className="flex-1 flex flex-col">
        <header className="bg-white border-b px-6 py-4 flex justify-between items-center">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">Vicky V3 — Chat de prueba</h1>
            <p className="text-xs text-gray-500">Endpoint: /api/vic-sales-agent-v3 · Scope: 1-10 trabajadores</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setShowDebug(!showDebug)}
              className="text-xs px-3 py-1 rounded border border-gray-300 hover:bg-gray-100"
            >
              {showDebug ? "Ocultar debug" : "Mostrar debug"}
            </button>
            <button
              onClick={handleReset}
              className="text-xs px-3 py-1 rounded border border-red-300 text-red-600 hover:bg-red-50"
            >
              Reiniciar
            </button>
          </div>
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {messages.map((m) => (
            <div
              key={m.id}
              className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[70%] rounded-lg px-4 py-2 ${
                  m.role === "user"
                    ? "bg-blue-600 text-white"
                    : "bg-white border border-gray-200 text-gray-900"
                }`}
              >
                <div className="whitespace-pre-wrap text-sm">{m.content}</div>
                {m.handoff && (
                  <div className="mt-2 text-xs px-2 py-1 bg-orange-100 text-orange-800 rounded">
                    ⚠️ Handoff activado
                  </div>
                )}
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex justify-start">
              <div className="bg-white border border-gray-200 rounded-lg px-4 py-2">
                <div className="text-sm text-gray-500">Vicky está pensando…</div>
              </div>
            </div>
          )}
        </div>

        <footer className="bg-white border-t px-6 py-3">
          <div className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault()
                  handleSend()
                }
              }}
              disabled={loading}
              placeholder="Escribí un mensaje…"
              className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={handleSend}
              disabled={loading || !input.trim()}
              className="px-6 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-40 hover:bg-blue-700"
            >
              Enviar
            </button>
          </div>
        </footer>
      </div>

      {/* Debug panel */}
      {showDebug && (
        <aside className="w-80 bg-gray-900 text-gray-100 overflow-y-auto">
          <div className="px-4 py-3 border-b border-gray-700 sticky top-0 bg-gray-900">
            <h2 className="text-sm font-semibold">Debug Trace</h2>
            <p className="text-xs text-gray-400">Tools y iteraciones por turno</p>
          </div>
          <div className="px-4 py-3 space-y-3">
            {messages
              .filter((m) => m.role === "assistant" && (m.toolCalls?.length || m.iterations))
              .map((m) => (
                <div key={`d-${m.id}`} className="text-xs">
                  <div className="text-gray-400 mb-1">
                    Turno @ {new Date(m.ts).toLocaleTimeString()}
                  </div>
                  <div className="bg-gray-800 rounded p-2 space-y-1">
                    <div>
                      <span className="text-gray-400">iters:</span>{" "}
                      <span className="text-green-400">{m.iterations}</span>
                    </div>
                    {m.toolCalls && m.toolCalls.length > 0 && (
                      <div className="space-y-1">
                        <div className="text-gray-400">tools:</div>
                        {m.toolCalls.map((tc, i) => (
                          <div key={i} className="pl-2 border-l-2 border-gray-700">
                            <div className="flex items-center gap-1">
                              <span className={tc.ok ? "text-green-400" : "text-red-400"}>
                                {tc.ok ? "✓" : "✗"}
                              </span>
                              <span className="text-blue-300">{tc.name}</span>
                            </div>
                            <details className="text-gray-400 mt-1">
                              <summary className="cursor-pointer">input</summary>
                              <pre className="text-[10px] mt-1 whitespace-pre-wrap break-words">
                                {JSON.stringify(tc.input, null, 2)}
                              </pre>
                            </details>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            {messages.filter((m) => m.toolCalls?.length || m.iterations).length === 0 && (
              <div className="text-xs text-gray-500 italic">
                Sin tool calls todavía. Iniciá una conversación para ver la traza.
              </div>
            )}
          </div>
        </aside>
      )}
    </div>
  )
}
