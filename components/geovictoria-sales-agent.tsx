"use client"

import { useEffect, useRef, useState } from "react"

type ChatMessage = {
  role: "user" | "assistant"
  content: string
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
}

const BRAND = {
  primary: "#0066CC",
  accent: "#00A3E0",
  dark: "#003A70",
  light: "#E8F4FD",
  white: "#FFFFFF",
  gray: "#F5F7FA",
  textDark: "#1A2B3C",
  textMid: "#4A5568",
  green: "#00C48C",
}

const INITIAL_MESSAGE =
  "Hola! Soy **Vic**, tu asistente de GeoVictoria. Estoy aqui para ayudarte a encontrar la solucion perfecta para gestionar la asistencia, accesos o comedor de tu empresa.\n\nEn que puedo ayudarte hoy?"

const SUGGESTIONS = [
  "Necesito control de asistencia",
  "Como funciona el marcaje biometrico?",
  "Tenemos 200 trabajadores",
  "Quiero una demo",
]

function extractLead(raw: string) {
  const leadMatch = raw.match(/LEAD_CAPTURED:(\{.*?\})/s)
  if (!leadMatch) {
    return { lead: null as LeadData | null, content: raw.trim() }
  }

  let lead: LeadData | null = null
  try {
    lead = JSON.parse(leadMatch[1]) as LeadData
  } catch {
    lead = null
  }

  const content = raw.replace(/LEAD_CAPTURED:(\{.*?\})/s, "").trim()
  return { lead, content }
}

export default function GeoVictoriaSalesAgent() {
  const [messages, setMessages] = useState<ChatMessage[]>([{ role: "assistant", content: INITIAL_MESSAGE }])
  const [input, setInput] = useState("")
  const [loading, setLoading] = useState(false)
  const [lead, setLead] = useState<LeadData | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, loading])

  const sendMessage = async () => {
    const text = input.trim()
    if (!text || loading) return

    const userMsg: ChatMessage = { role: "user", content: text }
    const updatedMessages = [...messages, userMsg]
    setMessages(updatedMessages)
    setInput("")
    setLoading(true)

    try {
      const response = await fetch("/api/vic-sales-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: updatedMessages,
        }),
      })

      const data = await response.json()
      if (!response.ok || !data?.success) {
        throw new Error(data?.error || "No fue posible consultar el agente.")
      }

      const raw = String(data.message || "")
      const { lead: extractedLead, content } = extractLead(raw)

      if (extractedLead) {
        setLead(extractedLead)
      }

      setMessages((prev) => [...prev, { role: "assistant", content: content || "Gracias, continuemos." }])
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Lo siento, ocurrio un error. Por favor intenta nuevamente.",
        },
      ])
    } finally {
      setLoading(false)
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void sendMessage()
    }
  }

  const renderText = (text: string) => {
    const parts = text.split(/(\*\*[^*]+\*\*)/g)
    return parts.map((part, i) =>
      part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : <span key={i}>{part}</span>,
    )
  }

  return (
    <div
      style={{
        fontFamily: "'Segoe UI', system-ui, sans-serif",
        background: `linear-gradient(135deg, ${BRAND.dark} 0%, ${BRAND.primary} 60%, ${BRAND.accent} 100%)`,
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div style={{ width: "100%", maxWidth: 480, display: "flex", flexDirection: "column", gap: 12 }}>
        <div
          style={{
            background: "rgba(255,255,255,0.1)",
            backdropFilter: "blur(10px)",
            borderRadius: 16,
            padding: "16px 20px",
            display: "flex",
            alignItems: "center",
            gap: 14,
            border: "1px solid rgba(255,255,255,0.2)",
          }}
        >
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: "50%",
              background: BRAND.white,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 22,
              boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
              flexShrink: 0,
            }}
          >
            🌍
          </div>
          <div>
            <div style={{ color: BRAND.white, fontWeight: 700, fontSize: 18, letterSpacing: "-0.3px" }}>GeoVictoria</div>
            <div style={{ color: "rgba(255,255,255,0.75)", fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
              <span
                style={{
                  width: 7,
                  height: 7,
                  background: BRAND.green,
                  borderRadius: "50%",
                  display: "inline-block",
                  boxShadow: `0 0 6px ${BRAND.green}`,
                }}
              />
              Vic · Asistente de Ventas
            </div>
          </div>
          <div style={{ marginLeft: "auto", textAlign: "right" }}>
            <div style={{ color: "rgba(255,255,255,0.6)", fontSize: 11 }}>+40 paises</div>
            <div style={{ color: "rgba(255,255,255,0.6)", fontSize: 11 }}>5.000+ clientes</div>
          </div>
        </div>

        <div
          style={{
            background: BRAND.white,
            borderRadius: 20,
            overflow: "hidden",
            boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
            display: "flex",
            flexDirection: "column",
            height: 500,
          }}
        >
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "20px 16px",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            {messages.map((msg, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  justifyContent: msg.role === "user" ? "flex-end" : "flex-start",
                  gap: 8,
                  alignItems: "flex-end",
                }}
              >
                {msg.role === "assistant" && (
                  <div
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: "50%",
                      background: `linear-gradient(135deg, ${BRAND.primary}, ${BRAND.accent})`,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 14,
                      flexShrink: 0,
                    }}
                  >
                    🤖
                  </div>
                )}
                <div
                  style={{
                    maxWidth: "78%",
                    padding: "10px 14px",
                    borderRadius: msg.role === "user" ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
                    background:
                      msg.role === "user" ? `linear-gradient(135deg, ${BRAND.primary}, ${BRAND.accent})` : BRAND.gray,
                    color: msg.role === "user" ? BRAND.white : BRAND.textDark,
                    fontSize: 14,
                    lineHeight: 1.55,
                    boxShadow:
                      msg.role === "user" ? "0 3px 12px rgba(0,102,204,0.3)" : "0 2px 6px rgba(0,0,0,0.06)",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {renderText(msg.content)}
                </div>
              </div>
            ))}

            {loading && (
              <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
                <div
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: "50%",
                    background: `linear-gradient(135deg, ${BRAND.primary}, ${BRAND.accent})`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 14,
                  }}
                >
                  🤖
                </div>
                <div
                  style={{
                    padding: "10px 16px",
                    background: BRAND.gray,
                    borderRadius: "18px 18px 18px 4px",
                    display: "flex",
                    gap: 5,
                    alignItems: "center",
                  }}
                >
                  {[0, 1, 2].map((d) => (
                    <div
                      key={d}
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: "50%",
                        background: BRAND.primary,
                        opacity: 0.5,
                        animation: "vic-bounce 1.2s ease-in-out infinite",
                        animationDelay: `${d * 0.2}s`,
                      }}
                    />
                  ))}
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {messages.length === 1 && (
            <div style={{ padding: "0 16px 10px", display: "flex", flexWrap: "wrap", gap: 6 }}>
              {SUGGESTIONS.map((s, i) => (
                <button
                  key={i}
                  onClick={() => {
                    setInput(s)
                    setTimeout(() => inputRef.current?.focus(), 50)
                  }}
                  style={{
                    padding: "5px 12px",
                    borderRadius: 20,
                    border: `1.5px solid ${BRAND.primary}`,
                    background: BRAND.light,
                    color: BRAND.primary,
                    fontSize: 12,
                    cursor: "pointer",
                    fontWeight: 600,
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          <div
            style={{
              padding: "12px 16px",
              borderTop: `1px solid ${BRAND.gray}`,
              display: "flex",
              gap: 8,
              alignItems: "flex-end",
              background: BRAND.white,
            }}
          >
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Escribe tu mensaje..."
              rows={1}
              style={{
                flex: 1,
                border: `1.5px solid ${input ? BRAND.primary : "#E2E8F0"}`,
                borderRadius: 24,
                padding: "10px 16px",
                fontSize: 14,
                resize: "none",
                outline: "none",
                fontFamily: "inherit",
                color: BRAND.textDark,
                background: BRAND.gray,
                lineHeight: 1.4,
                maxHeight: 100,
                overflow: "auto",
              }}
            />
            <button
              onClick={() => void sendMessage()}
              disabled={!input.trim() || loading}
              style={{
                width: 42,
                height: 42,
                borderRadius: "50%",
                border: "none",
                background: input.trim() && !loading ? `linear-gradient(135deg, ${BRAND.primary}, ${BRAND.accent})` : "#CBD5E0",
                color: BRAND.white,
                cursor: input.trim() && !loading ? "pointer" : "not-allowed",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 18,
                flexShrink: 0,
                boxShadow: input.trim() && !loading ? "0 4px 12px rgba(0,102,204,0.4)" : "none",
              }}
            >
              ➤
            </button>
          </div>
        </div>

        {lead && (
          <div
            style={{
              background: "rgba(255,255,255,0.95)",
              borderRadius: 16,
              padding: "18px 20px",
              border: `2px solid ${BRAND.green}`,
              boxShadow: "0 8px 30px rgba(0,196,140,0.3)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <span style={{ fontSize: 20 }}>✅</span>
              <span style={{ fontWeight: 700, color: BRAND.dark, fontSize: 15 }}>Lead capturado</span>
              <span
                style={{
                  marginLeft: "auto",
                  background: BRAND.green,
                  color: BRAND.white,
                  fontSize: 11,
                  fontWeight: 700,
                  padding: "2px 8px",
                  borderRadius: 10,
                }}
              >
                NUEVO
              </span>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 12px", fontSize: 13 }}>
              {[
                ["👤", "Nombre", lead.nombre],
                ["🏢", "Empresa", lead.empresa],
                ["💼", "Cargo", lead.cargo],
                ["📧", "Correo", lead.correo],
                ["📱", "Telefono", lead.telefono],
                ["🌎", "Pais", lead.pais],
                ["👥", "Trabajadores", lead.trabajadores],
                ["🎯", "Necesidad", lead.necesidad],
              ]
                .filter(([, , v]) => v)
                .map(([icon, label, value], i) => (
                  <div key={i}>
                    <span style={{ color: BRAND.textMid, fontSize: 11 }}>
                      {icon} {label}
                    </span>
                    <div
                      style={{
                        color: BRAND.textDark,
                        fontWeight: 600,
                        fontSize: 13,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {value}
                    </div>
                  </div>
                ))}
            </div>
          </div>
        )}

        <div style={{ textAlign: "center", color: "rgba(255,255,255,0.5)", fontSize: 11 }}>geovictoria.com · Powered by AI</div>
      </div>

      <style>{`
        @keyframes vic-bounce {
          0%, 60%, 100% { transform: translateY(0); opacity: 0.5; }
          30% { transform: translateY(-5px); opacity: 1; }
        }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #CBD5E0; border-radius: 4px; }
      `}</style>
    </div>
  )
}
