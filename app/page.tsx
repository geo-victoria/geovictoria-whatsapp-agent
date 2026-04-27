export default function HomePage() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1 style={{ marginTop: 0 }}>GeoVictoria WhatsApp Agent</h1>
      <p>Estado: operativo.</p>
      <p>UI de Vic: <a href="/vic">/vic</a></p>
      <p>Webhook WhatsApp: <code>/api/whatsapp/geovictoria/webhook</code></p>
    </main>
  )
}
