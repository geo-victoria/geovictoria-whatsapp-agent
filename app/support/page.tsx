"use client"
import { useEffect, useState, useCallback } from "react"

type Msg = { role: string; content: string; at: string }

type SupportCase = {
  id: string
  contact: string
  nombre: string | null
  empresa: string | null
  email: string | null
  telefono: string | null
  necesidad: string | null
  resumen: string | null
  started_at: string
  last_user_at: string
  ultimo_mensaje: string | null
  mensajes: Msg[]
  attended: boolean
  attended_at: string | null
  botmaker_url: string | null
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString("es-CL", {
    timeZone: "America/Santiago",
    day: "2-digit", month: "2-digit", year: "2-digit",
    hour: "2-digit", minute: "2-digit",
  })
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "ahora"
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}

function Transcript({ msgs }: { msgs: Msg[] }) {
  return (
    <div style={{ marginTop: 10, borderTop: "1px solid #eee", paddingTop: 10, maxHeight: 280, overflowY: "auto" }}>
      {msgs.map((m, i) => (
        <div key={i} style={{
          marginBottom: 6,
          display: "flex",
          justifyContent: m.role === "assistant" ? "flex-end" : "flex-start",
        }}>
          <div style={{
            maxWidth: "80%",
            background: m.role === "assistant" ? "#dcf8c6" : "#f0f0f0",
            borderRadius: 10,
            padding: "6px 10px",
            fontSize: 12,
            color: "#333",
            lineHeight: 1.4,
          }}>
            <div style={{ whiteSpace: "pre-wrap" }}>{m.content.replace(/LEAD_CAPTURED[^\n]*/g, "").replace(/SUPPORT_CASE/g, "").trim()}</div>
            <div style={{ fontSize: 10, color: "#999", marginTop: 2, textAlign: "right" }}>
              {new Date(m.at).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function CaseCard({ c, onAttend }: { c: SupportCase; onAttend: (id: string) => void }) {
  const [showTranscript, setShowTranscript] = useState(false)

  return (
    <div style={{
      background: "#fff",
      borderRadius: 12,
      padding: "16px 20px",
      boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
      borderLeft: `4px solid ${c.attended ? "#27ae60" : "#e74c3c"}`,
      opacity: c.attended ? 0.75 : 1,
    }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 16, alignItems: "start" }}>

        {/* Col 1: Datos de contacto */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Contacto</div>
          <div style={{ fontWeight: 600, fontSize: 14, color: "#1a1a2e" }}>{c.nombre || "Desconocido"}</div>
          {c.empresa && <div style={{ fontSize: 13, color: "#555", marginTop: 2 }}>{c.empresa}</div>}
          <div style={{ fontSize: 12, color: "#888", marginTop: 4 }}>📞 {c.telefono || `+${c.contact}`}</div>
          {c.email && <div style={{ fontSize: 12, color: "#888" }}>📧 {c.email}</div>}
        </div>

        {/* Col 2: Resumen de lo que necesita */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Requiere</div>
          {c.necesidad && (
            <span style={{ background: "#fff3cd", borderRadius: 4, padding: "2px 8px", fontSize: 12, color: "#856404", display: "inline-block", marginBottom: 6 }}>
              {c.necesidad}
            </span>
          )}
          <div style={{ fontSize: 12, color: "#444", fontStyle: "italic", lineHeight: 1.4 }}>
            "{(c.resumen || c.ultimo_mensaje || "Sin detalle")?.slice(0, 140)}"
          </div>
        </div>

        {/* Col 3: Fecha/hora + links */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Sesión</div>
          <div style={{ fontSize: 13, color: "#333" }}>{fmt(c.last_user_at)}</div>
          <div style={{ fontSize: 12, color: c.attended ? "#27ae60" : "#e74c3c", fontWeight: 500, marginTop: 2 }}>
            hace {timeAgo(c.last_user_at)}
          </div>
          {c.botmaker_url && (
            <a href={c.botmaker_url} target="_blank" rel="noopener noreferrer" style={{
              display: "inline-block", marginTop: 8, fontSize: 12,
              color: "#1a73e8", textDecoration: "none", fontWeight: 500,
            }}>
              💬 Ver en Botmaker ↗
            </a>
          )}
          {!c.botmaker_url && (
            <div style={{ fontSize: 11, color: "#bbb", marginTop: 8 }}>Sin chat Botmaker</div>
          )}
        </div>

        {/* Col 4: Acciones */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
          <button onClick={() => setShowTranscript(v => !v)} style={{
            background: "#f0f4ff", border: "1px solid #c5d5ff", borderRadius: 8,
            padding: "6px 12px", cursor: "pointer", fontSize: 12, fontWeight: 500, color: "#3554d1",
            whiteSpace: "nowrap",
          }}>
            {showTranscript ? "▲ Ocultar" : "▼ Transcripción"}
          </button>
          {!c.attended ? (
            <button onClick={() => onAttend(c.id)} style={{
              background: "#27ae60", color: "#fff", border: "none",
              borderRadius: 8, padding: "6px 14px", cursor: "pointer",
              fontSize: 12, fontWeight: 600, whiteSpace: "nowrap",
            }}>
              ✓ Atendido
            </button>
          ) : (
            <span style={{ fontSize: 11, color: "#27ae60", fontWeight: 500, textAlign: "right" }}>
              ✓ Atendido<br />{c.attended_at ? fmt(c.attended_at) : ""}
            </span>
          )}
        </div>
      </div>

      {showTranscript && c.mensajes.length > 0 && <Transcript msgs={c.mensajes} />}
    </div>
  )
}

export default function SupportDashboard() {
  const [cases, setCases] = useState<SupportCase[]>([])
  const [loading, setLoading] = useState(true)
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())
  const [filter, setFilter] = useState<"all" | "pending" | "attended">("pending")

  const fetchCases = useCallback(async () => {
    try {
      const res = await fetch("/api/support")
      const data = await res.json()
      setCases(data)
      setLastRefresh(new Date())
    } catch { /* silent */ } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    fetchCases()
    const iv = setInterval(fetchCases, 30000)
    return () => clearInterval(iv)
  }, [fetchCases])

  async function markAttended(id: string) {
    await fetch("/api/support", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    })
    setCases(prev => prev.map(c => c.id === id ? { ...c, attended: true, attended_at: new Date().toISOString() } : c))
  }

  const filtered = cases.filter(c =>
    filter === "all" ? true : filter === "pending" ? !c.attended : c.attended
  )
  const pending = cases.filter(c => !c.attended).length

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 1100, margin: "0 auto", padding: "24px 16px", background: "#f4f6fb", minHeight: "100vh" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "#1a1a2e" }}>🎧 Mesa de Soporte — Vicky</h1>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "#888" }}>
            Última actualización: {lastRefresh.toLocaleTimeString("es-CL")} · refresco automático cada 30s
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {pending > 0 && (
            <span style={{ background: "#e74c3c", color: "#fff", borderRadius: 20, padding: "5px 14px", fontSize: 14, fontWeight: 700 }}>
              {pending} pendiente{pending > 1 ? "s" : ""}
            </span>
          )}
          <button onClick={fetchCases} style={{ background: "#fff", border: "1px solid #ddd", borderRadius: 8, padding: "7px 16px", cursor: "pointer", fontSize: 13 }}>
            ↻ Actualizar
          </button>
        </div>
      </div>

      {/* Filtros */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {(["pending", "all", "attended"] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{
            padding: "6px 18px", borderRadius: 20, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 500,
            background: filter === f ? "#1a1a2e" : "#fff",
            color: filter === f ? "#fff" : "#555",
            boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
          }}>
            {f === "pending" ? `Pendientes (${cases.filter(c => !c.attended).length})`
              : f === "attended" ? `Atendidos (${cases.filter(c => c.attended).length})`
              : `Todos (${cases.length})`}
          </button>
        ))}
      </div>

      {/* Encabezado de columnas */}
      {filtered.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 16, padding: "0 20px", marginBottom: 6 }}>
          {["Contacto", "Requiere", "Sesión", ""].map((h, i) => (
            <div key={i} style={{ fontSize: 11, fontWeight: 700, color: "#aaa", textTransform: "uppercase", letterSpacing: 0.5 }}>{h}</div>
          ))}
        </div>
      )}

      {/* Lista */}
      {loading ? (
        <p style={{ textAlign: "center", color: "#888", padding: 60 }}>Cargando casos...</p>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: 80, color: "#888" }}>
          <div style={{ fontSize: 48 }}>✅</div>
          <p style={{ marginTop: 12, fontSize: 15 }}>Sin casos {filter === "pending" ? "pendientes" : "en esta vista"}</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {filtered.map(c => <CaseCard key={c.id} c={c} onAttend={markAttended} />)}
        </div>
      )}
    </div>
  )
}
