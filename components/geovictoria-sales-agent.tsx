"use client"

/**
 * Componente de chat para Vicky V3.
 *
 * Usa styled-jsx (integrado en Next.js, no requiere deps adicionales)
 * en lugar de Tailwind, para no agregar infraestructura al proyecto V2.
 *
 * Mantiene historial conversacional en estado React (efímero, se pierde
 * al refrescar). Cada mensaje se envía a /api/vic-sales-agent-v3 junto
 * con el historial completo.
 *
 * Muestra debug pane lateral con:
 *   - Cantidad de iteraciones del agent loop por turno
 *   - Tools invocadas por turno (ok/fail)
 *   - Handoff flag cuando se activó
 */

import { useState, useRef, useEffect } from "react"

type Role = "user" | "assistant"

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
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
  }, [messages])

  // Devolver el foco al input cuando termina de cargar la respuesta.
  // Sin esto, el navegador deja al usuario teniendo que volver a clickear
  // el campo de texto cada vez que envía un mensaje (porque `disabled={loading}`
  // hace que el input pierda el foco mientras carga).
  useEffect(() => {
    if (!loading) {
      inputRef.current?.focus()
    }
  }, [loading])

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
      const history = newMessages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-40)
        .slice(0, -1)
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
    } catch {
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
    <div className="layout">
      {/* Chat principal */}
      <div className="chat-column">
        <header className="header">
          <div>
            <h1 className="title">Vicky V3 — Chat de prueba</h1>
            <p className="subtitle">
              Endpoint: /api/vic-sales-agent-v3 · Scope: 1-50 trabajadores
            </p>
          </div>
          <div className="header-actions">
            <button
              type="button"
              onClick={() => setShowDebug(!showDebug)}
              className="btn btn-secondary"
            >
              {showDebug ? "Ocultar debug" : "Mostrar debug"}
            </button>
            <button type="button" onClick={handleReset} className="btn btn-danger">
              Reiniciar
            </button>
          </div>
        </header>

        <div ref={scrollRef} className="messages">
          {messages.map((m) => (
            <div
              key={m.id}
              className={`row ${m.role === "user" ? "row-user" : "row-assistant"}`}
            >
              <div className={`bubble ${m.role === "user" ? "bubble-user" : "bubble-assistant"}`}>
                <div className="bubble-content">{m.content}</div>
                {m.handoff && <div className="handoff-badge">⚠️ Handoff activado</div>}
              </div>
            </div>
          ))}
          {loading && (
            <div className="row row-assistant">
              <div className="bubble bubble-assistant">
                <div className="typing">Vicky está pensando…</div>
              </div>
            </div>
          )}
        </div>

        <footer className="composer">
          <input
            ref={inputRef}
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
            className="composer-input"
            autoFocus
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={loading || !input.trim()}
            className="btn btn-primary"
          >
            Enviar
          </button>
        </footer>
      </div>

      {/* Debug panel */}
      {showDebug && (
        <aside className="debug-pane">
          <div className="debug-header">
            <h2 className="debug-title">Debug Trace</h2>
            <p className="debug-subtitle">Tools y iteraciones por turno</p>
          </div>
          <div className="debug-body">
            {messages
              .filter((m) => m.role === "assistant" && (m.toolCalls?.length || m.iterations))
              .map((m) => (
                <div key={`d-${m.id}`} className="debug-turn">
                  <div className="debug-ts">
                    Turno @ {new Date(m.ts).toLocaleTimeString()}
                  </div>
                  <div className="debug-card">
                    <div className="debug-row">
                      <span className="debug-label">iters:</span>
                      <span className="debug-iters">{m.iterations}</span>
                    </div>
                    {m.toolCalls && m.toolCalls.length > 0 && (
                      <div>
                        <div className="debug-label">tools:</div>
                        {m.toolCalls.map((tc, i) => (
                          <div key={i} className="debug-tool">
                            <div className="debug-tool-name">
                              <span className={tc.ok ? "ok" : "fail"}>
                                {tc.ok ? "✓" : "✗"}
                              </span>
                              <span className="debug-tool-label">{tc.name}</span>
                            </div>
                            <details className="debug-details">
                              <summary>input</summary>
                              <pre className="debug-pre">
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
              <div className="debug-empty">
                Sin tool calls todavía. Iniciá una conversación para ver la traza.
              </div>
            )}
          </div>
        </aside>
      )}

      <style jsx>{`
        .layout {
          display: flex;
          height: 100vh;
          background-color: #f9fafb;
          font-family:
            -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell,
            "Helvetica Neue", sans-serif;
          color: #111827;
        }

        .chat-column {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-width: 0;
        }

        .header {
          background-color: #ffffff;
          border-bottom: 1px solid #e5e7eb;
          padding: 16px 24px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .title {
          font-size: 18px;
          font-weight: 600;
          color: #111827;
          margin: 0;
        }

        .subtitle {
          font-size: 12px;
          color: #6b7280;
          margin: 4px 0 0 0;
        }

        .header-actions {
          display: flex;
          gap: 8px;
        }

        .btn {
          font-size: 12px;
          padding: 6px 12px;
          border-radius: 6px;
          border: 1px solid transparent;
          cursor: pointer;
          font-family: inherit;
          transition: background-color 0.15s;
        }

        .btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }

        .btn-secondary {
          background-color: #ffffff;
          border-color: #d1d5db;
          color: #374151;
        }

        .btn-secondary:hover {
          background-color: #f3f4f6;
        }

        .btn-danger {
          background-color: #ffffff;
          border-color: #fca5a5;
          color: #b91c1c;
        }

        .btn-danger:hover {
          background-color: #fef2f2;
        }

        .btn-primary {
          background-color: #2563eb;
          color: #ffffff;
          padding: 10px 24px;
          font-size: 14px;
        }

        .btn-primary:hover:not(:disabled) {
          background-color: #1d4ed8;
        }

        .messages {
          flex: 1;
          overflow-y: auto;
          padding: 16px 24px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .row {
          display: flex;
        }

        .row-user {
          justify-content: flex-end;
        }

        .row-assistant {
          justify-content: flex-start;
        }

        .bubble {
          max-width: 70%;
          padding: 10px 16px;
          border-radius: 12px;
          font-size: 14px;
          line-height: 1.5;
        }

        .bubble-user {
          background-color: #2563eb;
          color: #ffffff;
        }

        .bubble-assistant {
          background-color: #ffffff;
          border: 1px solid #e5e7eb;
          color: #111827;
        }

        .bubble-content {
          white-space: pre-wrap;
        }

        .handoff-badge {
          margin-top: 8px;
          font-size: 11px;
          padding: 4px 8px;
          background-color: #ffedd5;
          color: #9a3412;
          border-radius: 4px;
          display: inline-block;
        }

        .typing {
          color: #6b7280;
          font-size: 14px;
          font-style: italic;
        }

        .composer {
          background-color: #ffffff;
          border-top: 1px solid #e5e7eb;
          padding: 12px 24px;
          display: flex;
          gap: 8px;
        }

        .composer-input {
          flex: 1;
          padding: 10px 16px;
          border: 1px solid #d1d5db;
          border-radius: 8px;
          font-size: 14px;
          font-family: inherit;
          outline: none;
          color: #111827;
        }

        .composer-input:focus {
          border-color: #2563eb;
          box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.2);
        }

        .composer-input:disabled {
          background-color: #f9fafb;
          color: #6b7280;
        }

        .debug-pane {
          width: 320px;
          background-color: #111827;
          color: #f3f4f6;
          overflow-y: auto;
          flex-shrink: 0;
        }

        .debug-header {
          padding: 12px 16px;
          border-bottom: 1px solid #374151;
          position: sticky;
          top: 0;
          background-color: #111827;
          z-index: 1;
        }

        .debug-title {
          font-size: 13px;
          font-weight: 600;
          margin: 0;
          color: #f3f4f6;
        }

        .debug-subtitle {
          font-size: 11px;
          color: #9ca3af;
          margin: 4px 0 0 0;
        }

        .debug-body {
          padding: 12px 16px;
          display: flex;
          flex-direction: column;
          gap: 12px;
          font-size: 12px;
        }

        .debug-turn {
          font-size: 12px;
        }

        .debug-ts {
          color: #9ca3af;
          margin-bottom: 4px;
        }

        .debug-card {
          background-color: #1f2937;
          border-radius: 6px;
          padding: 8px;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .debug-row {
          display: flex;
          gap: 6px;
        }

        .debug-label {
          color: #9ca3af;
        }

        .debug-iters {
          color: #34d399;
          font-weight: 500;
        }

        .debug-tool {
          padding-left: 8px;
          border-left: 2px solid #374151;
          margin-top: 4px;
        }

        .debug-tool-name {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .debug-tool-label {
          color: #93c5fd;
          font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
        }

        .ok {
          color: #34d399;
        }

        .fail {
          color: #f87171;
        }

        .debug-details {
          color: #9ca3af;
          margin-top: 4px;
        }

        .debug-details summary {
          cursor: pointer;
          user-select: none;
        }

        .debug-pre {
          font-size: 10px;
          margin: 4px 0 0 0;
          white-space: pre-wrap;
          word-break: break-word;
          font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
        }

        .debug-empty {
          color: #6b7280;
          font-style: italic;
          font-size: 12px;
        }
      `}</style>
    </div>
  )
}
