/**
 * CADENCIA DE CONTENIDO — el estado terminal del ciclo de reactivación.
 *
 * El artefacto de los ciclos (836b5316) define "Contenido" como un ESTADO, no
 * como un toque más: quien terminó el ciclo comercial sin responder sale de
 * ventas y entra a una cadencia de branding, y CUALQUIER señal real lo devuelve
 * a ventas. Lo que el artefacto dejaba pendiente eran tres decisiones (línea,
 * frecuencia y cómo comparte el opt-out); Lalo (13-sep) ordenó partir y validar
 * después, así que acá quedan tomadas y declaradas:
 *
 *  1. CANAL = CORREO, nunca WhatsApp. El riesgo que el propio artefacto nombra
 *     es mandar branding con plantillas de MARKETING por la línea de Vicky:
 *     cuesta por mensaje, consume el tope de frecuencia de Meta por receptor y
 *     castiga la calidad de la línea — la misma línea de la que dependen las
 *     ventas. Además, a esta persona ya le escribimos 4 veces por WhatsApp sin
 *     respuesta: insistir por ahí es lo que la trajo hasta acá.
 *  2. FRECUENCIA = una pieza cada 30 días (CONTENIDO_DIAS).
 *  3. OPT-OUT COMPARTIDO = el runner pasa por el MISMO `evaluarGrupo1` de la
 *     campaña (opt-out, rechazo en contexto, casuística, cliente, pago, tiempo
 *     acotado), más una baja propia del contenido. Un solo criterio, no dos.
 *
 * EL CONTENIDO NO VENDE. No lleva precio, ni link de cotización, ni llamado a
 * comprar: lleva UNA cosa útil y la puerta abierta. Si el lector responde, la
 * respuesta entra por el chat de Vicky y ahí vuelve a ser una venta.
 *
 * POR QUÉ ESTAS PIEZAS: el catálogo es el blog vivo de GeoVictoria Chile
 * (URLs verificadas una a una — el slug de HubSpot NO es la URL pública: dos de
 * los primeros candidatos redirigían al índice del blog), y cada pieza responde
 * una objeción que Vicky YA sabe contestar. Así, si el lector escribe de vuelta,
 * el agente está preparado; y cuando el clasificador guardó por qué no cerró,
 * la primera pieza que sale es justo la de esa objeción.
 *
 * Módulo PURO: sin red, sin Supabase. El runner (vic-campana-contenido) envía.
 */

const BLOG = "https://www.geovictoria.com/es-cl/blog"

export type Tema = "legal" | "horas" | "hardware" | "operacion" | "comparacion"

export type Pieza = {
  id: string
  titulo: string
  /** Una línea de por qué le sirve al lector. Sin adjetivos de venta. */
  gancho: string
  url: string
  temas: Tema[]
}

/**
 * Orden = orden de salida por defecto. Las primeras son las que responden las
 * dudas legales más frecuentes del chat (artículo 22 y la Resolución 38 son
 * literalmente las dos que más daño hicieron cuando se contestaron mal).
 */
export const PIEZAS: Pieza[] = [
  { id: "art22", titulo: "Artículo 22: quién está obligado a marcar y quién no", gancho: "los excluidos de jornada no están obligados a registrar asistencia, y conviene tenerlo claro antes de contar cuánta gente marca", url: `${BLOG}/nuevas-definiciones-articulo-22/`, temas: ["legal"] },
  { id: "res38", titulo: "Resolución Exenta N°38: qué exige la Dirección del Trabajo", gancho: "qué tiene que cumplir un sistema de asistencia para estar autorizado", url: `${BLOG}/resolucion-exenta-38-en-que-consiste/`, temas: ["legal"] },
  { id: "leyes_asistencia", titulo: "Las leyes de asistencia en Chile, en simple", gancho: "qué obliga la ley a registrar, en lenguaje de persona", url: `${BLOG}/leyes-de-asistencia-chile/`, temas: ["legal"] },
  { id: "ley40", titulo: "Ley de 40 horas: cómo queda la jornada", gancho: "el calendario de la reducción y qué cambia en la práctica", url: `${BLOG}/ley-de-40-horas-en-chile/`, temas: ["legal"] },
  { id: "horas_extra", titulo: "Cinco formas de contar horas extra sin pelear con la planilla", gancho: "métodos concretos para que el conteo no dependa de la memoria de nadie", url: `${BLOG}/conteo-de-horas-extras-5-metodos-efectivos/`, temas: ["horas", "operacion"] },
  { id: "marcar_jornada", titulo: "Cómo se marca legalmente la jornada en Chile", gancho: "las formas válidas de registro y qué pide la DT de cada una", url: `${BLOG}/marcar-jornada-de-trabajo-chile/`, temas: ["legal"] },
  { id: "remotos", titulo: "Control de asistencia con gente en terreno o en teletrabajo", gancho: "cómo se registra a quien no pasa por una oficina", url: `${BLOG}/control-de-asistencia-para-trabajadores-remotos/`, temas: ["operacion"] },
  { id: "ley40_extras", titulo: "40 horas y compensación de horas extra", gancho: "cómo se compensan las horas cuando la jornada baja", url: `${BLOG}/ley-40-horas-compensacion-horas-extra/`, temas: ["legal", "horas"] },
  { id: "celular", titulo: "Marcar desde el celular: cómo funciona", gancho: "qué se puede y qué no con el teléfono como reloj de control", url: `${BLOG}/como-funciona-control-de-asistencia-por-celular/`, temas: ["hardware", "operacion"] },
  { id: "huellero", titulo: "Huellero digital: qué es y cómo funciona", gancho: "para decidir con datos si el equipo físico hace falta o no", url: `${BLOG}/huellero-digital-que-es-y-como-funciona-en-el-control-de-asistencia/`, temas: ["hardware"] },
  { id: "tres_normas", titulo: "Tres normas de control de asistencia que conviene conocer", gancho: "lo mínimo que le suelen preguntar a un empleador en una fiscalización", url: `${BLOG}/tres-normas-de-control-de-asistencia-al-trabajo-que-debes-conocer/`, temas: ["legal"] },
  { id: "turnos_rotativos", titulo: "Software de asistencia para turnos rotativos", gancho: "qué mirar cuando los turnos cambian semana a semana", url: `${BLOG}/los-mejores-software-de-control-de-asistencia-para-turnos-rotativos-en-2026/`, temas: ["operacion", "comparacion"] },
  { id: "inspeccion", titulo: "Qué revisa la Inspección del Trabajo", gancho: "lo que se mira en terreno y dónde suelen aparecer las multas", url: `${BLOG}/inspeccion-del-trabajo-y-vacaciones-lo-que-deben-saber-las-empresaso/`, temas: ["legal"] },
  { id: "obligaciones", titulo: "Obligaciones del empleador en la legislación laboral chilena", gancho: "el mapa completo, para revisar de una sola pasada", url: `${BLOG}/legislacion-laboral-en-chile-obligaciones-del-empleador/`, temas: ["legal"] },
  { id: "subcontratacion", titulo: "Ley de subcontratación y control de asistencia", gancho: "qué le toca a la empresa principal cuando hay contratistas en faena", url: `${BLOG}/control-de-asistencia-en-el-cumplimiento-de-la-ley-de-subcontratacion/`, temas: ["legal"] },
  { id: "tipos_horarios", titulo: "Tipos de horario de trabajo", gancho: "cómo se arman jornadas fijas, rotativas y parciales sin enredarse", url: `${BLOG}/tipos-de-horarios-de-trabajo/`, temas: ["operacion"] },
]

/** Cada cuánto sale una pieza (días). */
export const CONTENIDO_DIAS = Number(process.env.CONTENIDO_DIAS || 30)

/** Tema que mejor responde el motivo de no cierre que guardó el clasificador. */
export function temaParaMotivo(motivo: string | null | undefined): Tema | null {
  const m = String(motivo || "").toLowerCase()
  if (!m) return null
  if (m.includes("legal") || m.includes("normativ") || m.includes("multa")) return "legal"
  if (m.includes("hardware") || m.includes("reloj") || m.includes("huellero")) return "hardware"
  if (m.includes("hora")) return "horas"
  if (m.includes("proveedor") || m.includes("competencia")) return "comparacion"
  if (m.includes("turno") || m.includes("terreno") || m.includes("operac")) return "operacion"
  return null
}

/**
 * Siguiente pieza: primero una que responda la objeción del contacto (si el
 * clasificador dejó motivo y aún no se la mandamos), si no la siguiente del
 * orden por defecto. `null` = ya recibió todo el catálogo.
 */
export function siguientePieza(enviadas: string[] | null | undefined, motivo?: string | null): Pieza | null {
  const ya = new Set((enviadas || []).map((s) => String(s)))
  const pendientes = PIEZAS.filter((p) => !ya.has(p.id))
  if (!pendientes.length) return null
  const tema = temaParaMotivo(motivo)
  if (tema) {
    const match = pendientes.find((p) => p.temas.includes(tema))
    if (match) return match
  }
  return pendientes[0]
}

/** ¿Toca pieza? Sin envío previo, sí. */
export function tocaContenido(
  ultimoEnvioIso: string | null | undefined,
  ahora: Date,
  dias = CONTENIDO_DIAS,
): { toca: boolean; diasDesde: number; diasFaltan: number } {
  if (!ultimoEnvioIso) return { toca: true, diasDesde: Number.POSITIVE_INFINITY, diasFaltan: 0 }
  const ms = Date.parse(String(ultimoEnvioIso))
  if (!Number.isFinite(ms)) return { toca: true, diasDesde: Number.POSITIVE_INFINITY, diasFaltan: 0 }
  const d = (ahora.getTime() - ms) / 86_400_000
  return { toca: d >= dias, diasDesde: Math.floor(d), diasFaltan: Math.max(0, Math.ceil(dias - d)) }
}

// ── el correo ───────────────────────────────────────────────────────────────

const esc = (s: string) =>
  (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export type DatosContenido = {
  nombre?: string | null
  empresa?: string | null
  pieza: Pieza
  /** Correo desde el que sale, para el enlace de baja. */
  fromEmail: string
  waUrl: string
}

export function asuntoDeContenido(d: DatosContenido): string {
  return d.pieza.titulo
}

/**
 * El cuerpo NO vende: una pieza, por qué le sirve, y la puerta abierta. Sin
 * precio, sin link de cotización, sin "aprovecha". Si algún día este correo
 * incluye una oferta, deja de ser contenido y vuelve a ser campaña — y ahí
 * corresponde el ciclo, no esto.
 */
export function htmlDeContenido(d: DatosContenido): string {
  const saludo = d.nombre ? `Hola ${esc(d.nombre)}!` : "Hola!"
  const baja = `mailto:${d.fromEmail}?subject=${encodeURIComponent("Baja de correos")}&body=${encodeURIComponent("Prefiero no recibir más estos correos.")}`
  return `<div style="max-width:560px;margin:0 auto;padding:26px 18px;font-family:'Segoe UI',Arial,sans-serif;color:#2d3748">
  <div style="background:#fff;border-radius:14px;padding:28px 26px;box-shadow:0 1px 4px rgba(0,0,0,.06)">
    <p style="margin:0 0 14px;font-size:15px">${saludo} Soy <b>Vicky</b>, de GeoVictoria 👋</p>
    <p style="margin:0 0 14px;font-size:14.5px;line-height:1.6">No vengo a venderte nada. Escribimos sobre control de asistencia y normativa laboral, y esto de acá te puede servir aunque nunca trabajemos juntos:</p>
    <p style="margin:0 0 6px;font-size:16px;line-height:1.45;font-weight:700">${esc(d.pieza.titulo)}</p>
    <p style="margin:0 0 18px;font-size:14.5px;line-height:1.6;color:#4a5568">${esc(d.pieza.gancho.charAt(0).toUpperCase() + d.pieza.gancho.slice(1))}.</p>
    <p style="text-align:center;margin:22px 0"><a href="${d.pieza.url}" style="background:#0087C8;border:1px solid #0087C8;color:#fff;text-decoration:none;font-weight:700;padding:12px 24px;border-radius:10px;display:inline-block;font-size:15px">Leerlo</a></p>
    <p style="margin:0 0 14px;font-size:14.5px;line-height:1.6">Y si en algún momento quieres retomar lo del control de asistencia, me escribes y lo vemos al tiro — sin apuro.</p>
    <p style="text-align:center;margin:0 0 18px"><a href="${d.waUrl}" style="color:#25D366;font-weight:700;text-decoration:none;font-size:14px">Escribirme por WhatsApp 💬</a></p>
    <p style="margin:0;font-size:13px;color:#718096;line-height:1.6">Si prefieres no recibir estos correos, <a href="${baja}" style="color:#718096">avísame acá</a> o responde este mismo correo y lo dejo hasta aquí.</p>
  </div>
</div>`
}

export function correoDeContenido(d: DatosContenido): { asunto: string; html: string } {
  return { asunto: asuntoDeContenido(d), html: htmlDeContenido(d) }
}
