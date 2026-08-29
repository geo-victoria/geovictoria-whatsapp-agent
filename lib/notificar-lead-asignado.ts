/**
 * NOTIFICACIÓN AL EJECUTIVO CUANDO LA TÓMBOLA LE ASIGNA UN LEAD (29-ago).
 *
 * HALLAZGO (auditoría del informe de Rodrigo, casos Sebastián Goic/Invergrup y
 * Belén Fuentes/El Alerce): el lead calificado por Vicky se asignaba al
 * ejecutivo por la regla de Zoho **en silencio**. El timeline de ambos leads
 * lo muestra crudo: la única notificación por correo ("Nuevo Lead Chile", de
 * la regla NOTIFICA NUEVO LEAD SEGÚN TERRITORIO) sale al CREARSE el lead,
 * cuando el dueño todavía es vicky@geovictoria.com — y la asignación al
 * humano ocurre 5 minutos después, sin disparar nada. Peor: la tarea y la
 * llamada agendada del workflow "TASK Y CALL NO CONTACTADO" también quedan a
 * nombre de Vicky, así que tampoco aparecen en el to-do del ejecutivo.
 * Resultado: dos clientes que pidieron explícitamente que los llamaran
 * quedaron días sin gestión, y no por negligencia — nadie les avisó.
 *
 * El traspaso por relojes (vic-ptv-cron) SÍ notificaba; este camino —lead
 * calificado entregado por crm-hitos— no. Acá se cierra ese hueco.
 *
 * Best-effort puro: jamás lanza ni bloquea la conversación (principio 24-jul).
 */

import { getZohoAccessToken } from "./zoho-token"

export type LeadAsignadoInfo = {
  leadId: string
  vendedorEmail: string
  /** Teléfono del prospecto (para el asunto y el CC chileno). */
  contact?: string
  /** Nombre del prospecto, si se conoce. */
  nombre?: string
  /** Empresa declarada, si se conoce. */
  empresa?: string
  /** Dotación declarada (0 = desconocida). */
  empleados?: number
  /** true = el cliente pidió explícitamente hablar con una persona. */
  pidioHumano?: boolean
}

/**
 * Avisa por correo al ejecutivo que la tómbola le acaba de asignar un lead
 * calificado por Vicky, con el contexto para llamar sin leer el chat entero.
 */
export async function notificarLeadAsignado(info: LeadAsignadoInfo): Promise<boolean> {
  const { leadId, vendedorEmail } = info
  if (!leadId || !vendedorEmail) return false
  // Dueños robot: no son personas, no reciben aviso.
  if (/vicky@|info@geovictoria/i.test(vendedorEmail)) return false
  try {
    // MISMOS DESTINATARIOS QUE LA ACCIÓN OFICIAL (Lalo 29-ago, "usa la acción,
    // ahí ya se definen los destinatarios"): la API de Zoho NO deja ejecutar
    // una acción de workflow desde fuera, pero el timeline de los leads
    // mostró su configuración exacta — "Nuevo Lead Chile" va al DUEÑO del
    // registro (verificado: Karina Soto→asepulveda@, manuel garcia→aaraque@)
    // con copia FIJA a Brayan Bernal y Valeria Barbano. Se replica acá.
    // Override por env; `-` deja el correo sin copia.
    const ccCrudo = (process.env.VICKY_CC_LEAD_ASIGNADO || "bbernal@geovictoria.com,vbarbano@geovictoria.com").trim()
    const ccFijos = ccCrudo === "-" ? [] : ccCrudo.split(",").map((e) => e.trim()).filter(Boolean)
    // CONTENIDO: por defecto el nuestro (trae dotación y la marca de "pidió
    // que lo llamaran", que la plantilla oficial no tiene). Con vic_kv
    // `tpl_lead_asignado` = <id de plantilla Zoho> se manda EXACTAMENTE la
    // plantilla oficial en vez del HTML propio — sin deploy.
    let tplOficial = ""
    try {
      const { getKvValue } = await import("./supabase-persistence-v3")
      tplOficial = ((await getKvValue("tpl_lead_asignado")) || "").trim()
    } catch { /* sin kv, contenido propio */ }
    const token = await getZohoAccessToken()
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
    const { correoEntregable } = await import("./correo-alias")
    const destino = await correoEntregable(vendedorEmail)
    const fono = String(info.contact || "").replace(/\D/g, "")
    const esChile = fono.startsWith("56")

    const quien = [info.nombre, info.empresa].filter(Boolean).join(" · ") || "un prospecto"
    const dotacion = Number(info.empleados) > 0 ? `${info.empleados} personas` : "dotación por confirmar"
    const urgencia = info.pidioHumano
      ? "<b>Pidió expresamente que lo llamaran.</b> "
      : ""
    const asunto = fono
      ? `Lead calificado por Vicky: ${info.empresa || info.nombre || "nuevo prospecto"} (+${fono})`
      : "Lead calificado por Vicky para contactar"

    // La copia de la acción oficial (fija) más la de traspaso chilena, sin
    // repetir a nadie ni copiarse al propio destinatario.
    const cc = [...ccFijos, ...(esChile ? [(process.env.VICKY_TRASPASO_CC || "vluna@geovictoria.com").trim()] : [])]
      .filter((e, i, a) => e && e.toLowerCase() !== destino.toLowerCase() && a.indexOf(e) === i)

    const res = await fetch(`${api}/crm/v3/Leads/${leadId}/actions/send_mail`, {
      method: "POST",
      headers: H,
      cache: "no-store",
      body: JSON.stringify({
        data: [
          {
            from: { email: "vicky@geovictoria.com" },
            to: [{ email: destino }],
            ...(cc.length ? { cc: cc.map((email) => ({ email })) } : {}),
            subject: asunto,
            ...(tplOficial
              ? { template: { id: tplOficial } }
              : {
                  content:
                    `<html><body style="font-family:Segoe UI,Arial,sans-serif;color:#2d3748;">` +
                    `<p>Te asignamos un lead que Vicky ya calificó: <b>${quien}</b> (${dotacion}).</p>` +
                    `<p>${urgencia}La conversación completa está en las notas del lead${fono ? `, y su WhatsApp es <b>+${fono}</b>` : ""}.</p>` +
                    `<p><a href="https://crm.zoho.com/crm/org685875245/tab/Leads/${leadId}">Ver el Lead en Zoho</a></p>` +
                    `</body></html>`,
                  mail_format: "html",
                }),
          },
        ],
      }),
    })
    if (!res.ok) {
      console.warn(`[lead-asignado] aviso a ${destino} devolvió ${res.status} (lead ${leadId})`)
      return false
    }
    console.log(`[lead-asignado] avisado ${destino} — lead ${leadId} (${quien})`)
    return true
  } catch (e) {
    console.warn("[lead-asignado] aviso falló:", e instanceof Error ? e.message : e)
    return false
  }
}
