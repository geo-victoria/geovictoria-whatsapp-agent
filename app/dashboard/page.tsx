"use client"
import { useEffect, useState, useCallback } from "react"

type Conv = {
  contact: string
  hora: string
  tipo: "lead" | "soporte" | "rebote"
  nombre: string | null
  empresa: string | null
  necesidad: string | null
  meetingBooked: boolean
  meetingSlot: string | null
  zohoLeadId: string | null
  firstMsg: string | null
  bmLink: string | null
}

const TEAL = "#00838F"
const COLORS = { lead: "#27ae60", soporte: "#e67e22", rebote: "#95a5a6" }
const LABELS = { lead: "🎯 Lead", soporte: "🛠️ Soporte", rebote: "💬 Rebote" }

function fmt(slot: string | null) {
  if (!slot) return "—"
  const d = new Date(slot)
  return d.toLocaleDateString("es-CL", { timeZone: "America/Santiago", day: "numeric", month: "short" }) +
    " " + d.toLocaleTimeString("es-CL", { timeZone: "America/Santiago", hour: "2-digit", minute: "2-digit" })
}

function KPI({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ background: "#fff", borderRadius: 10, padding: "14px 18px", boxShadow: "0 1px 3px rgba(0,0,0,.07)", borderTop: `3px solid ${color}`, minWidth: 120 }}>
      <div style={{ fontSize: 30, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 12, color: "#888", fontWeight: 500 }}>{label}</div>
    </div>
  )
}

export default function Dashboard() {
  const [convs, setConvs] = useState<Conv[]>([])
  const [loading, setLoading] = useState(true)
  const [date, setDate] = useState(() => new Date().toISOString().split("T")[0])
  const [lastRefresh, setLastRefresh] = useState(new Date())

  const load = useCallback(async () => {
    try {
      // Propaga ?key=... de la URL del dashboard a la API (gate opcional para
      // compartir el link sin dejarlo 100% abierto).
      const key = typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("key") || ""
        : ""
      const r = await fetch(`/api/report?date=${date}${key ? `&key=${encodeURIComponent(key)}` : ""}`)
      const data = await r.json()
      setConvs(Array.isArray(data) ? data : [])
      setLastRefresh(new Date())
    } catch { /* silent */ } finally { setLoading(false) }
  }, [date])

  useEffect(() => { load(); const iv = setInterval(load, 60000); return () => clearInterval(iv) }, [load])

  const leads   = convs.filter(c => c.tipo === "lead")
  const soporte = convs.filter(c => c.tipo === "soporte")
  const rebotes = convs.filter(c => c.tipo === "rebote")
  const reus    = convs.filter(c => c.meetingBooked)

  return (
    <div style={{ fontFamily: "system-ui,sans-serif", maxWidth: 1100, margin: "0 auto", padding: "24px 16px", background: "#f4f6fb", minHeight: "100vh" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "#1a1a2e" }}>💬 Conversaciones Vicky</h1>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "#888" }}>
            {new Date(date + "T12:00:00").toLocaleDateString("es-CL", { weekday: "long", day: "numeric", month: "long" })} · actualización: {lastRefresh.toLocaleTimeString("es-CL")}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            style={{ border: "1px solid #ddd", borderRadius: 8, padding: "6px 12px", fontSize: 13, background: "#fff" }} />
          <button onClick={load} style={{ background: "#fff", border: "1px solid #ddd", borderRadius: 8, padding: "7px 14px", cursor: "pointer", fontSize: 13 }}>↻</button>
        </div>
      </div>

      {/* KPIs */}
      <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <KPI label="Conversaciones" value={convs.length} color={TEAL} />
        <KPI label="Leads 🎯"       value={leads.length}   color="#27ae60" />
        <KPI label="Reuniones 📅"   value={reus.length}    color="#1565c0" />
        <KPI label="Soporte 🛠️"    value={soporte.length} color="#e67e22" />
        <KPI label="Rebotes 💬"     value={rebotes.length} color="#95a5a6" />
      </div>

      {/* Tabla */}
      {loading ? (
        <p style={{ textAlign: "center", color: "#888", padding: 60 }}>Cargando...</p>
      ) : convs.length === 0 ? (
        <div style={{ textAlign: "center", padding: 80, color: "#888" }}>
          <div style={{ fontSize: 48 }}>📭</div>
          <p>Sin conversaciones para este día</p>
        </div>
      ) : (
        <div style={{ background: "#fff", borderRadius: 12, boxShadow: "0 1px 4px rgba(0,0,0,.08)", overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: TEAL, color: "#fff" }}>
                {["Hora","Tipo","Nombre / Empresa","Primer mensaje","Reunión","Zoho","BotMaker"].map(h => (
                  <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontWeight: 600, fontSize: 12 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {convs.map((c, i) => (
                <tr key={c.contact + c.hora} style={{ background: i % 2 === 0 ? "#fafafa" : "#fff", borderBottom: "1px solid #f0f0f0" }}>
                  <td style={{ padding: "10px 14px", fontWeight: 600, color: "#555" }}>{c.hora}</td>
                  <td style={{ padding: "10px 14px" }}>
                    <span style={{ background: COLORS[c.tipo] + "22", color: COLORS[c.tipo], borderRadius: 20, padding: "2px 10px", fontSize: 12, fontWeight: 600 }}>
                      {LABELS[c.tipo]}
                    </span>
                  </td>
                  <td style={{ padding: "10px 14px" }}>
                    {c.nombre ? (
                      <div>
                        <div style={{ fontWeight: 600, color: "#1a1a2e" }}>{c.nombre}</div>
                        {c.empresa && <div style={{ fontSize: 12, color: "#666" }}>{c.empresa}</div>}
                        {c.necesidad && <div style={{ fontSize: 11, color: "#999" }}>{c.necesidad}</div>}
                      </div>
                    ) : (
                      <span style={{ color: "#bbb", fontStyle: "italic" }}>+{c.contact}</span>
                    )}
                  </td>
                  <td style={{ padding: "10px 14px", color: "#555", maxWidth: 220 }}>
                    <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {c.firstMsg ? c.firstMsg.slice(0, 80) : "—"}
                    </div>
                  </td>
                  <td style={{ padding: "10px 14px" }}>
                    {c.meetingBooked
                      ? <span style={{ color: "#27ae60", fontWeight: 600 }}>✅ {fmt(c.meetingSlot)}</span>
                      : <span style={{ color: "#bbb" }}>—</span>}
                  </td>
                  <td style={{ padding: "10px 14px" }}>
                    {c.zohoLeadId
                      ? <a href={`https://crm.zoho.com/crm/org685875245/tab/Leads/${c.zohoLeadId}`} target="_blank" rel="noopener noreferrer" style={{ color: TEAL, fontWeight: 500 }}>Ver →</a>
                      : <span style={{ color: "#bbb" }}>—</span>}
                  </td>
                  <td style={{ padding: "10px 14px" }}>
                    {c.bmLink
                      ? <a href={c.bmLink} target="_blank" rel="noopener noreferrer" style={{ color: TEAL, fontWeight: 500 }}>Ver →</a>
                      : <span style={{ color: "#bbb" }}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
