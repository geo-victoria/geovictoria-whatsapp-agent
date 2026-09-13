/**
 * CUERPOS DE CORREO DE LA CAMPAÑA DE REACTIVACIÓN — uno por toque (13-sep).
 *
 * El miércoles el correo sale SOLO a quien recibió el WhatsApp del martes y
 * sigue sin dar señales, así que es el MISMO mensaje por otra vía: tiene que
 * decir lo mismo que dijo la plantilla, no un texto genérico que contradiga el
 * gancho de esa semana (hasta hoy los cuatro toques mandaban un único cuerpo
 * que hablaba de "la cotización sigue vigente" incluso en el último aviso).
 *
 * Módulo PURO: recibe todo resuelto y devuelve {asunto, html}. Nada de red, así
 * los textos se pueden testear.
 *
 * DOS HONESTIDADES QUE ESTE ARCHIVO NO PUEDE ROMPER:
 *  - El toque 3 ofrece un descuento que aplica el TAP del botón de WhatsApp
 *    (procesarRespuestaCampana). El correo NO puede aplicarlo, así que jamás
 *    dice "ya te lo dejé aplicado": manda a responder por WhatsApp.
 *  - El toque 4 solo nombra el 20 % si el descuento está REALMENTE aplicado en
 *    la cotización (pctDescuento ≥ tope). Si la aplicación se negó —canal
 *    ejecutivo, cotización aceptada, fallo— el correo cierra sin prometer nada,
 *    igual que la plantilla de respaldo.
 */

export type DatosCorreo = {
  casilla: 1 | 2 | 3 | 4
  nombre?: string | null
  empresa?: string | null
  /** Link corto /q/ de la cotización; vacío si no hay cotización. */
  link?: string | null
  pdfUrl?: string | null
  /** Gancho del toque 2 (mismo texto que la plantilla de WhatsApp). */
  gancho?: string | null
  /** Descuento REAL vigente en la cotización, leído de Zoho. */
  pctDescuento?: number | null
  /** Link "escríbeme por WhatsApp". */
  waUrl: string
}

const esc = (s: string) =>
  (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export function asuntoDeToque(d: DatosCorreo): string {
  const emp = d.empresa ? ` · ${d.empresa}` : ""
  if (d.casilla === 2) return `Sobre tu cotización de control de asistencia${emp}`
  if (d.casilla === 3) return `Te dejé un descuento esperándote${emp}`
  if (d.casilla === 4) {
    return (d.pctDescuento || 0) >= 20
      ? `Último aviso: tu cotización con 20% de descuento${emp}`
      : `¿Cerramos o lo dejamos hasta aquí?${emp}`
  }
  return `Tu cotización de control de asistencia sigue vigente${emp}`
}

/** Párrafos del cuerpo, en el orden en que se pintan. */
function cuerpoDeToque(d: DatosCorreo): string[] {
  const emp = d.empresa ? ` de <b>${esc(d.empresa)}</b>` : ""
  if (d.casilla === 2) {
    const gancho = (d.gancho || "").trim()
    return [
      `Ayer te escribí por WhatsApp por la cotización de control de asistencia${emp} y quedó dando vueltas, así que te dejo por acá lo que suele ser la duda.`,
      gancho ? `${esc(gancho.charAt(0).toUpperCase() + gancho.slice(1))}.` : "",
      "Si hay otra cosa que te frena, respóndeme y lo vemos: no tienes que decidirlo a ciegas.",
    ].filter(Boolean)
  }
  if (d.casilla === 3) {
    return [
      `Te escribí ayer por WhatsApp con un <b>descuento adicional</b> sobre el valor de tu cotización${emp}.`,
      "Para dejártelo aplicado necesito que me respondas por WhatsApp: con eso actualizo la cotización y te llega el valor nuevo al tiro.",
      "El link de acá abajo es tu cotización tal como está hoy, todavía sin el descuento.",
    ]
  }
  if (d.casilla === 4) {
    const con20 = (d.pctDescuento || 0) >= 20
    return con20
      ? [
          `Este es mi último recordatorio por la cotización${emp}, para no ser pesada 🙂`,
          "Antes de cerrarla te dejé aplicado el <b>máximo que manejo: 20% de descuento en el plan durante los primeros 6 meses</b>. Ya está en el link, con el valor nuevo.",
          "Si no es el momento, no pasa nada: la dejo guardada y la retomamos cuando tú quieras.",
        ]
      : [
          `Este es mi último recordatorio por la cotización${emp}, para no ser pesada 🙂`,
          "Si te sirve, la dejo acá abajo para que la revises cuando quieras. Y si el precio o el momento no cuadran, dímelo y lo vemos juntos.",
          "Si no es el momento, no pasa nada: la dejo guardada y la retomamos cuando tú quieras.",
        ]
  }
  return [
    `Ayer te escribí por WhatsApp para retomar la cotización de control de asistencia${emp}. Sigue vigente y con el mismo valor.`,
    "Si quieres partir, se paga en línea y tu cuenta queda activa el mismo día; yo te acompaño con la configuración por WhatsApp.",
  ]
}

export function htmlDeToque(d: DatosCorreo): string {
  const saludo = d.nombre ? `Hola ${esc(d.nombre)}!` : "Hola!"
  const btn = (href: string, texto: string, fondo: string, borde: string, color: string) =>
    `<a href="${href}" style="background:${fondo};border:1px solid ${borde};color:${color};text-decoration:none;font-weight:700;padding:12px 24px;border-radius:10px;display:inline-block;font-size:15px;margin:4px 6px">${texto}</a>`
  const botones = [
    d.link ? btn(d.link, "Ver mi cotización", "#0087C8", "#0087C8", "#ffffff") : "",
    d.pdfUrl ? btn(d.pdfUrl, "Descargar el PDF", "#ffffff", "#0087C8", "#0087C8") : "",
  ].filter(Boolean).join("")
  const cta = botones ? `<p style="text-align:center;margin:22px 0">${botones}</p>` : ""
  // En el toque 3 el WhatsApp no es un adorno: es DONDE se aplica el descuento.
  const wa = d.casilla === 3
    ? `<p style="text-align:center;margin:0 0 18px">${btn(d.waUrl, "Responder por WhatsApp y aplicar el descuento 💬", "#25D366", "#25D366", "#ffffff")}</p>`
    : `<p style="text-align:center;margin:0 0 18px"><a href="${d.waUrl}" style="color:#25D366;font-weight:700;text-decoration:none;font-size:14px">Escribirme por WhatsApp 💬</a></p>`
  const parrafos = cuerpoDeToque(d)
    .map((p) => `<p style="margin:0 0 14px;font-size:14.5px;line-height:1.6">${p}</p>`)
    .join("\n    ")
  return `<!doctype html><html><body style="margin:0;background:#f4f6f8;font-family:'Segoe UI',Arial,sans-serif;color:#2d3748">
<div style="max-width:560px;margin:0 auto;padding:26px 18px">
  <div style="background:#fff;border-radius:14px;padding:28px 26px;box-shadow:0 1px 4px rgba(0,0,0,.06)">
    <p style="margin:0 0 14px;font-size:15px">${saludo} Soy <b>Vicky</b>, de GeoVictoria 👋</p>
    ${parrafos}
    ${cta}
    ${wa}
    <p style="margin:0;font-size:13px;color:#718096;line-height:1.6">Si ya no lo necesitas o prefieres que no te escribamos más por esta cotización, respóndeme este correo y lo dejo hasta aquí.</p>
  </div>
</div></body></html>`
}

export function correoDeToque(d: DatosCorreo): { asunto: string; html: string } {
  return { asunto: asuntoDeToque(d), html: htmlDeToque(d) }
}
