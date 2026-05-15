"use client"
import { useEffect, useState, useCallback } from "react"

type Meeting = {
  id: number
  uid: string
  status: string
  start_time: string
  end_time: string
  attendee_name: string | null
  attendee_email: string | null
  empresa: string | null
  host_name: string | null
  host_email: string | null
  meeting_url: string | null
  contact: string | null
  zoho_lead_id: string | null
  attendee_absent: boolean
  host_absent: boolean
}

function fmt(iso: string) {
  return new Date(iso).toLocaleTimeString("es-CL", {
    timeZone: "America/Santiago", hour: "2-digit", minute: "2-digit",
  })
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("es-CL", {
    timeZone: "America/Santiago", weekday: "long", day: "numeric", month: "long",
  })
}

function statusLabel(m: Meeting) {
  if (m.status === "cancelled") return { text: "Cancelada", color: "#95a5a6" }
  const now = new Date()
  const end = new Date(m.end_time)
  const start = new Date(m.start_time)
  if (now < start) return { text: "Pendiente", color: "#3498db" }
  if (m.attendee_absent) return { text: "No-show", color: "#e74c3c" }
  if (m.host_absent) return { text: "Host ausente", color: "#e67e22" }
  if (now > end) return { text: "Realizada", color: "#27ae60" }
  return { text: "En curso", color: "#f39c12" }
}

function MeetingCard({ m, onMark }: { m: Meeting; onMark: (uid: string, field: "attendee_absent" | "host_absent", val: boolean) => void }) {
  const sl = statusLabel(m)
  const now = new Date()
  const isPast = new Date(m.end_time) < now
  const isCancelled = m.status === "cancelled"
  const canMark = isPast && !isCancelled

  return (
    <div style={{
      background: "#fff", borderRadius: 12, padding: "16px 20px",
      boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
      borderLeft: `4px solid ${sl.color}`,
      opacity: isCancelled ? 0.6 : 1,
    }}>
      <div style={{ display: "grid", gridTemplateColumns: "80px 1fr 1fr auto", gap: 16, alignItems: "start" }}>

        {/* Hora */}
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: "#1a1a2e" }}>{fmt(m.start_time)}</div>
          <div style={{ fontSize: 11, color: "#aaa" }}>{fmt(m.end_time)}</div>
          <div style={{ marginTop: 6, background: sl.color, color: "#fff", borderRadius: 20, padding: "2px 8px", fontSize: 11, fontWeight: 600 }}>
            {sl.text}
          </div>
        </div>

        {/* Cliente */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Cliente</div>
          <div style={{ fontWeight: 600, fontSize: 14, color: "#1a1a2e" }}>{m.attendee_name || "—"}</div>
          {m.empresa && <div style={{ fontSize: 13, color: "#555" }}>{m.empresa}</div>}
          {m.attendee_email && <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>📧 {m.attendee_email}</div>}
          {m.contact && <div style={{ fontSize: 12, color: "#888" }}>📞 +{m.contact}</div>}
        </div>

        {/* Ejecutiva */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Ejecutiva</div>
          <div style={{ fontWeight: 600, fontSize: 14, color: "#1a1a2e" }}>{m.host_name || "—"}</div>
          {m.host_email && <div style={{ fontSize: 12, color: "#888" }}>{m.host_email}</div>}
          {m.meeting_url && (
            <a href={m.meeting_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: "#1a73e8", fontWeight: 500, display: "inline-block", marginTop: 6 }}>
              🔗 Unirse ↗
            </a>
          )}
        </div>

        {/* Asistencia */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 140 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: 0.5 }}>Asistencia cliente</div>
          {!canMark ? (
            <span style={{ fontSize: 12, color: "#bbb", fontStyle: "italic" }}>
              {isCancelled ? "Cancelada" : "Disponible al terminar"}
            </span>
          ) : (
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={() => onMark(m.uid, "attendee_absent", false)} style={{
                flex: 1, padding: "8px 4px", borderRadius: 8, border: "2px solid",
                borderColor: !m.attendee_absent ? "#27ae60" : "#eee",
                background: !m.attendee_absent ? "#27ae60" : "#fff",
                color: !m.attendee_absent ? "#fff" : "#555",
                cursor: "pointer", fontSize: 13, fontWeight: 600,
              }}>✅ Asistió</button>
              <button onClick={() => onMark(m.uid, "attendee_absent", true)} style={{
                flex: 1, padding: "8px 4px", borderRadius: 8, border: "2px solid",
                borderColor: m.attendee_absent ? "#e74c3c" : "#eee",
                background: m.attendee_absent ? "#e74c3c" : "#fff",
                color: m.attendee_absent ? "#fff" : "#555",
                cursor: "pointer", fontSize: 13, fontWeight: 600,
              }}>❌ No-show</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function MeetingsDashboard() {
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [loading, setLoading] = useState(true)
  const [lastRefresh, setLastRefresh] = useState(new Date())
  const [date, setDate] = useState(() => new Date().toISOString().split("T")[0])

  const fetchMeetings = useCallback(async () => {
    try {
      const res = await fetch(`/api/meetings?date=${date}`)
      setMeetings(await res.json())
      setLastRefresh(new Date())
    } catch { /* silent */ } finally { setLoading(false) }
  }, [date])

  useEffect(() => {
    fetchMeetings()
    const iv = setInterval(fetchMeetings, 60000)
    return () => clearInterval(iv)
  }, [fetchMeetings])

  async function markAttendance(uid: string, field: "attendee_absent" | "host_absent", val: boolean) {
    await fetch("/api/meetings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid, [field]: val }),
    })
    setMeetings(prev => prev.map(m => m.uid === uid ? { ...m, [field]: val } : m))
  }

  const total = meetings.filter(m => m.status !== "cancelled").length
  const realizadas = meetings.filter(m => {
    if (m.status === "cancelled") return false
    return new Date(m.end_time) < new Date() && !m.attendee_absent
  }).length
  const noShows = meetings.filter(m => m.attendee_absent).length
  const pendientes = meetings.filter(m => m.status !== "cancelled" && new Date(m.start_time) > new Date()).length

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 960, margin: "0 auto", padding: "24px 16px", background: "#f4f6fb", minHeight: "100vh" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "#1a1a2e" }}>📅 Reuniones Vicky</h1>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "#888" }}>
            {fmtDate(date + "T12:00:00")} · actualización: {lastRefresh.toLocaleTimeString("es-CL")}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{
            border: "1px solid #ddd", borderRadius: 8, padding: "6px 12px", fontSize: 13, background: "#fff"
          }} />
          <button onClick={fetchMeetings} style={{ background: "#fff", border: "1px solid #ddd", borderRadius: 8, padding: "7px 14px", cursor: "pointer", fontSize: 13 }}>
            ↻
          </button>
        </div>
      </div>

      {/* Resumen */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>
        {[
          { label: "Total", value: total, color: "#3498db" },
          { label: "Realizadas", value: realizadas, color: "#27ae60" },
          { label: "No-shows", value: noShows, color: "#e74c3c" },
          { label: "Pendientes", value: pendientes, color: "#f39c12" },
        ].map(s => (
          <div key={s.label} style={{ background: "#fff", borderRadius: 10, padding: "14px 16px", boxShadow: "0 1px 3px rgba(0,0,0,0.07)", borderTop: `3px solid ${s.color}` }}>
            <div style={{ fontSize: 28, fontWeight: 700, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 12, color: "#888", fontWeight: 500 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Lista */}
      {loading ? (
        <p style={{ textAlign: "center", color: "#888", padding: 60 }}>Cargando reuniones...</p>
      ) : meetings.length === 0 ? (
        <div style={{ textAlign: "center", padding: 80, color: "#888" }}>
          <div style={{ fontSize: 48 }}>📭</div>
          <p style={{ marginTop: 12 }}>Sin reuniones para este día</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {meetings.map(m => <MeetingCard key={m.uid} m={m} onMark={markAttendance} />)}
        </div>
      )}
    </div>
  )
}
