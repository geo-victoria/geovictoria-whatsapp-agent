/**
 * Escalamiento al IMPLEMENTADOR desde la fase de onboarding (09-sep, caso
 * Lorena Ortiz / Lara pinta el sol).
 *
 * Lo que pasó: la clienta pagó el 08-sep, cargó su nómina por chat y al día
 * siguiente escribió "necesito usar HOY la plataforma", "si no puedo hoy NO
 * me sirve", "qué hago!!!!!". Vicky le ofreció capacitación para 5 días
 * después, la mandó a la Mesa de Ayuda (que no resuelve implementaciones), le
 * dictó pasos de menú de la plataforma que no conoce y terminó
 * "diagnosticando" desde una captura que su perfil no tenía permisos. Nada de
 * eso era suyo: cuando un cliente en onboarding pide un cupo antes, tiene un
 * problema para entrar/usar la plataforma o se frustra, la respuesta correcta
 * es UNA sola — avisarle a su implementador (el relator de su IMP) y decirle
 * al cliente que ya está avisado. Reglas de Lalo (09-sep): "Vicky no da
 * soporte", "Vicky no conoce la plataforma", "tiene que escalar cuando le
 * piden si hay cupo antes".
 *
 * Esta función es esa única salida: correo al relator (con copia interna),
 * alerta interna, nota en la Implementación y un texto listo para el cliente.
 * Candado por motivo (2 h) para no bombardear al relator si el cliente
 * insiste. Best-effort en cada canal: si el correo falla igual queda la alerta
 * interna, y la tool responde ok mientras al menos un aviso haya salido.
 */
import { getKvValue, setKvValue } from "./supabase-persistence-v3"
import { claveCapacitacion } from "./onboarding/fase"
import { avisarEquipoInterno } from "./alerta-interna"
import { getZohoAccessToken } from "./zoho-token"
import { RELATORES_GV_AVANZADO } from "./implementacion-vicky"

const ZOHO_API = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").replace(/\/+$/, "")
const MAIL_ANCHOR = (process.env.VIC_DASH_MAIL_ANCHOR || "Contacts/3525045000645054553").trim()
const FROM_EMAIL = "vicky@geovictoria.com"
const CANDADO_MS = 2 * 60 * 60 * 1000

export type MotivoEscalamiento = "urgencia_capacitacion" | "problema_plataforma" | "cliente_molesto" | "otro"

const TITULOS: Record<MotivoEscalamiento, string> = {
  urgencia_capacitacion: "pide capacitación antes de los cupos disponibles",
  problema_plataforma: "problema para entrar o usar la plataforma",
  cliente_molesto: "cliente molesto o frustrado",
  otro: "necesita a su implementador",
}

const esc = (s: string) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export async function escalarAImplementador(
  contact: string,
  args: { motivo: MotivoEscalamiento; detalle: string },
): Promise<{
  ok: boolean
  relator?: string
  yaAvisado?: boolean
  canales?: string[]
  mensajeParaProspecto?: string
  error?: string
}> {
  const fono = String(contact || "").replace(/\D/g, "")
  const motivo: MotivoEscalamiento = (["urgencia_capacitacion", "problema_plataforma", "cliente_molesto", "otro"] as const).includes(args.motivo)
    ? args.motivo
    : "otro"
  const detalle = String(args.detalle || "").trim().slice(0, 600)

  let cap: { implementacionId?: string; numero?: string; empresa?: string; relator?: { nombre: string; email: string }; cuando?: string } | null = null
  try {
    const crudo = await getKvValue(claveCapacitacion(fono))
    cap = crudo ? JSON.parse(crudo) : null
  } catch {
    cap = null
  }
  // Sin IMP todavía (alta recién hecha) el aviso va a los DOS relatores: alguien tiene que tomarlo.
  const destinos = cap?.relator?.email
    ? [{ nombre: cap.relator.nombre, email: cap.relator.email }]
    : RELATORES_GV_AVANZADO.map((r) => ({ nombre: r.nombre, email: r.email }))
  const relatorNombre = cap?.relator?.nombre || "tu implementador"
  const empresa = cap?.empresa || ""

  // Candado por motivo: el cliente insiste 5 veces en 10 minutos y el relator
  // recibe UN correo, no cinco. El texto al cliente sigue saliendo igual.
  const claveCandado = `onb_escala_${fono}_${motivo}`
  try {
    const previo = await getKvValue(claveCandado)
    if (previo && Date.now() - Date.parse(previo) < CANDADO_MS) {
      return { ok: true, yaAvisado: true, relator: relatorNombre, mensajeParaProspecto: textoCliente(relatorNombre, motivo) }
    }
  } catch { /* sin candado legible, se avisa */ }

  const canales: string[] = []
  const linkChat = `https://go.botmaker.com/#/chats/${fono}`
  const asunto = `Onboarding · ${empresa || `+${fono}`}: ${TITULOS[motivo]}`
  const cuerpoTexto =
    `${empresa ? `${empresa} · ` : ""}+${fono}${cap?.numero ? ` · ${cap.numero}` : ""}\n` +
    `Motivo: ${TITULOS[motivo]}.\n` +
    (detalle ? `Lo que dijo el cliente: "${detalle}"\n` : "") +
    (cap?.cuando ? `Capacitación agendada: ${cap.cuando}.\n` : "Sin capacitación agendada.\n") +
    `Vicky le dijo que su implementador lo contacta HOY. El chat: ${linkChat}`

  // 1) Correo al relator (copia interna por env, default egomez).
  try {
    const token = await getZohoAccessToken()
    const cc = (process.env.VICKY_ONBOARDING_ESCALA_CC || "egomez@geovictoria.com")
      .split(",").map((s) => s.trim()).filter((e) => e && !destinos.some((d) => d.email.toLowerCase() === e.toLowerCase()))
    const res = await fetch(`${ZOHO_API}/crm/v3/${MAIL_ANCHOR}/actions/send_mail`, {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        data: [{
          from: { email: FROM_EMAIL },
          to: destinos.map((d) => ({ email: d.email, user_name: d.nombre })),
          ...(cc.length ? { cc: cc.map((email) => ({ email })) } : {}),
          subject: asunto,
          mail_format: "html",
          content:
            `<html><body style="font-family:Segoe UI,Arial,sans-serif;color:#2d3748;font-size:14px;line-height:20px">` +
            `<p><b>${esc(empresa || `+${fono}`)}</b> necesita a su implementador hoy: <b>${esc(TITULOS[motivo])}</b>.</p>` +
            (detalle ? `<p>Lo que dijo el cliente por WhatsApp: <i>"${esc(detalle)}"</i></p>` : "") +
            `<p>WhatsApp del cliente: <b>+${fono}</b>${cap?.numero ? ` · Implementación ${esc(cap.numero)}` : ""}${cap?.cuando ? ` · capacitación agendada ${esc(cap.cuando)}` : " · sin capacitación agendada"}.</p>` +
            `<p>Vicky le dijo que lo contactas <b>hoy</b>. Lo que ya está guardado (nómina, turnos) va en las notas de la Implementación.</p>` +
            `<p><a href="${linkChat}">Ver el chat</a>${cap?.numero ? ` · busca ${esc(cap.numero)} en Implementaciones` : ""}</p>` +
            `</body></html>`,
        }],
      }),
    })
    if (res.ok) canales.push("correo")
    else console.warn(`[onb-escala] correo ${res.status} a ${destinos.map((d) => d.email).join(",")}`)
  } catch (e) {
    console.warn("[onb-escala] correo falló:", e instanceof Error ? e.message : e)
  }

  // 2) Alerta interna (durable en el inbox del dash + push).
  try {
    if (await avisarEquipoInterno(`🚨 ONBOARDING — ${asunto}\n${cuerpoTexto}\nAvisado a: ${destinos.map((d) => d.nombre).join(" y ")}`)) canales.push("alerta")
  } catch { /* best-effort */ }

  // 3) Nota en la IMP para que quede en el registro.
  if (cap?.implementacionId) {
    try {
      const token = await getZohoAccessToken()
      const r = await fetch(`${ZOHO_API}/crm/v3/Notes`, {
        method: "POST",
        headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ data: [{ Note_Title: `Escalamiento Vicky · ${TITULOS[motivo]}`, Note_Content: cuerpoTexto, Parent_Id: cap.implementacionId, $se_module: "Implementaciones" }] }),
      })
      if (r.ok) canales.push("nota_imp")
    } catch { /* best-effort */ }
  }

  if (!canales.length) {
    return { ok: false, error: "No pude avisar a nadie (correo y alerta fallaron). Dile al cliente que lo estás escalando y vuelve a intentar en el próximo mensaje." }
  }
  await setKvValue(claveCandado, new Date().toISOString()).catch(() => {})
  return { ok: true, relator: relatorNombre, canales, mensajeParaProspecto: textoCliente(relatorNombre, motivo) }
}

function textoCliente(relator: string, motivo: MotivoEscalamiento): string {
  const quien = relator === "tu implementador" ? "tu implementador" : `${relator}, tu implementador,`
  if (motivo === "urgencia_capacitacion") {
    return `Entiendo, necesitas partir antes. Ya le avisé a ${quien} para que te contacte hoy y vean cómo adelantarlo. Mientras, yo dejo guardado todo lo que me mandes para que la carga sea inmediata cuando te llame.`
  }
  if (motivo === "problema_plataforma") {
    return `Eso lo revisa directamente ${quien}: ya le avisé para que te contacte hoy y lo vea contigo en la plataforma.`
  }
  return `Ya le avisé a ${quien} para que te contacte hoy y lo resuelvan juntos.`
}
