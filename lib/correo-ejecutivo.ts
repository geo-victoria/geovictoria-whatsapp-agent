/**
 * Correo al EJECUTIVO sobre su trato (o lead) en Zoho.
 *
 * Los avisos de promesas vencidas y de reclamos iban solo a la bandeja interna
 * (vic_v3_inbox + WhatsApp de Lalo): el ejecutivo responsable nunca se
 * enteraba (caso Robin, Perú, 02-oct). Se manda con send_mail sobre el
 * registro del cliente, así queda en su historial de correos en Zoho.
 * Best-effort: nunca lanza.
 */
export async function correoAlEjecutivo(p: {
  contact: string
  para: string
  asunto: string
  html: string
  cc?: string[]
  /** Candado para no repetir el mismo correo (clave vic_kv) y su ventana. */
  candado?: { clave: string; horas: number }
}): Promise<boolean> {
  const clean = (p.contact || "").replace(/\D/g, "")
  if (!clean || !p.para) return false
  try {
    const { getKvValue, setKvValue } = await import("./supabase-persistence-v3")
    if (p.candado) {
      const previo = await getKvValue(p.candado.clave).catch(() => null)
      if (previo && Date.now() - Date.parse(previo) < p.candado.horas * 3600e3) return false
    }
    // Registro del cliente: el trato si existe; si no, el lead.
    const { dealActivoEnKv } = await import("./crm-hitos")
    const dealId = await dealActivoEnKv(clean).catch(() => null)
    const leadId = dealId ? null : await getKvValue(`zoho_lead_${clean}`).catch(() => null)
    const modulo = dealId ? "Deals" : leadId ? "Leads" : ""
    const id = dealId || leadId || ""
    if (!modulo) return false
    const { getZohoAccessToken } = await import("./zoho-token")
    const token = await getZohoAccessToken()
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const enlace = `https://crm.zoho.com/crm/org685875245/tab/${dealId ? "Potentials" : "Leads"}/${id}`
    const cc = (p.cc || []).filter((e) => e && e.toLowerCase() !== p.para.toLowerCase())
    const res = await fetch(`${api}/crm/v3/${modulo}/${encodeURIComponent(id)}/actions/send_mail`, {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        data: [{
          from: { email: (process.env.VICKY_FROM_EMAIL || "vicky@geovictoria.com").trim() },
          to: [{ email: p.para }],
          ...(cc.length ? { cc: cc.map((email) => ({ email })) } : {}),
          subject: p.asunto,
          content: `${p.html}<p><a href="${enlace}">Abrir el registro en Zoho</a></p>`,
          mail_format: "html",
        }],
      }),
    })
    if (!res.ok) {
      console.error(`[correo-ejecutivo] ${res.status}:`, (await res.text().catch(() => "")).slice(0, 200))
      return false
    }
    if (p.candado) await setKvValue(p.candado.clave, new Date().toISOString()).catch(() => {})
    return true
  } catch (e) {
    console.error("[correo-ejecutivo] falló:", e)
    return false
  }
}
