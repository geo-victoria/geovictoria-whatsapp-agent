"use client"
import { useEffect, useState, useCallback } from "react"

type SupportCase = {
  id: string
  contact: string
  nombre: string | null
  empresa: string | null
  necesidad: string | null
  last_user_at: string
  ultimo_mensaje: string | null
  attended: boolean
  attended_at: string | null
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "ahora"
  if (mins < 60) return `hace ${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `hace ${hrs}h`
  return `hace ${Math.floor(hrs / 24)}d`
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleString("es-CL", {
    timeZone: "America/Santiago",
    day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit",
  })
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
    } catch { /* silent */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    fetchCases()
    const interval = setInterval(fetchCases, 30000)
    return () => clearInterval(interval)
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
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 900, margin: "0 auto", padding: "24px 16px", background: "#f8f9fa", minHeight: "100vh" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "#1a1a2e" }}>
            🎧 Mesa de Soporte — Vicky
          </h1>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "#666" }}>
            Actualizado: {lastRefresh.toLocaleTimeString("es-CL")} · se refresca cada 30s
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {pending > 0 && (
            <span style={{ background: "#e74c3c", color: "#fff", borderRadius: 20, padding: "4px 12px", fontSize: 13, fontWeight: 600 }}>
              {pending} pendiente{pending > 1 ? "s" : ""}
            </span>
          )}
          <button onClick={fetchCases} style={{ background: "#fff", border: "1px solid #ddd", borderRadius: 8, padding: "6px 14px", cursor: "pointer", fontSize: 13 }}>
            ↻ Actualizar
          </button>
        </div>
      </div>

      {/* Filtros */}
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {(["pending", "all", "attended"] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{
            padding: "6px 16px", borderRadius: 20, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 500,
            background: filter === f ? "#1a1a2e" : "#fff",
            color: filter === f ? "#fff" : "#555",
            boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
          }}>
            {f === "pending" ? `Pendientes (${cases.filter(c => !c.attended).length})` : f === "attended" ? `Atendidos (${cases.filter(c => c.attended).length})` : `Todos (${cases.length})`}
          </button>
        ))}
      </div>

      {/* Lista */}
      {loading ? (
        <p style={{ textAlign: "center", color: "#888", padding: 40 }}>Cargando...</p>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: 60, color: "#888" }}>
          <p style={{ fontSize: 40, margin: 0 }}>✅</p>
          <p style={{ marginTop: 12 }}>Sin casos {filter === "pending" ? "pendientes" : "en esta vista"}</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {filtered.map(c => (
            <div key={c.id} style={{
              background: "#fff",
              borderRadius: 12,
              padding: "16px 20px",
              boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
              borderLeft: `4px solid ${c.attended ? "#27ae60" : "#e74c3c"}`,
              opacity: c.attended ? 0.7 : 1,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                <div style={{ flex: 1 }}>
                  {/* Nombre / empresa */}
                  <div style={{ fontWeight: 600, fontSize: 15, color: "#1a1a2e", marginBottom: 2 }}>
                    {c.nombre || `+${c.contact}`}
                    {c.empresa && <span style={{ fontWeight: 400, color: "#555", marginLeft: 6 }}>· {c.empresa}</span>}
                  </div>

                  {/* Teléfono */}
                  <div style={{ fontSize: 13, color: "#888", marginBottom: 8 }}>
                    📞 +{c.contact}
                    {c.necesidad && <span style={{ marginLeft: 10, background: "#fff3cd", borderRadius: 4, padding: "1px 6px", fontSize: 12, color: "#856404" }}>{c.necesidad}</span>}
                  </div>

                  {/* Último mensaje */}
                  {c.ultimo_mensaje && (
                    <div style={{ fontSize: 13, color: "#333", background: "#f8f9fa", borderRadius: 8, padding: "8px 12px", fontStyle: "italic", maxWidth: 520 }}>
                      "{c.ultimo_mensaje.slice(0, 200)}{c.ultimo_mensaje.length > 200 ? "…" : ""}"
                    </div>
                  )}
                </div>

                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8, minWidth: 120 }}>
                  <span style={{ fontSize: 12, color: "#888" }}>
                    {formatTime(c.last_user_at)}
                    <br />
                    <span style={{ color: c.attended ? "#27ae60" : "#e74c3c", fontWeight: 500 }}>
                      {timeAgo(c.last_user_at)}
                    </span>
                  </span>

                  {!c.attended ? (
                    <button onClick={() => markAttended(c.id)} style={{
                      background: "#27ae60", color: "#fff", border: "none",
                      borderRadius: 8, padding: "7px 14px", cursor: "pointer",
                      fontSize: 13, fontWeight: 600, whiteSpace: "nowrap",
                    }}>
                      ✓ Atendido
                    </button>
                  ) : (
                    <span style={{ fontSize: 12, color: "#27ae60", fontWeight: 500 }}>
                      ✓ Atendido {c.attended_at ? timeAgo(c.attended_at) : ""}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
