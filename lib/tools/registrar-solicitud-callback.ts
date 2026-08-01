/**
 * Tool: registrar_solicitud_callback
 *
 * Crea Lead en Zoho. Dos modos (callback explícito y fallback de cotización),
 * AMBOS con dueño por la tómbola interina del PTV (auditoría 31-jul: antes el
 * fallback iba a Eddyluz fija y el callback quedaba con owner Vicky, en la
 * bandeja de nadie — la regla de leads de Zoho no dispara por API).
 */

import { createZohoLead, updateZohoLeadOwner } from "@/lib/zoho-leads"
import { vendedoresDePais } from "@/lib/ptv"

// Residuo del relevo 27-jul eliminado (auditoría 31-jul): los callbacks y los
// fallbacks de cotización ya NO van a Eddyluz fija — el dueño sale de la
// MISMA tómbola interina del PTV (vendedoresDePais + round-robin persistido
// en vic_kv con la MISMA llave ptv_rr_<pais>, para que la rotación sea una
// sola entre el cron y esta tool). La lista se extiende sin deploy por env
// VICKY_PTV_VENDEDORES_<CC>.
function paisDeTelefono(tel: string): "cl" | "co" | "mx" {
  const d = (tel || "").replace(/\D/g, "")
  if (d.startsWith("57")) return "co"
  if (d.startsWith("521") || (d.startsWith("52") && d.length === 12)) return "mx"
  return "cl"
}

async function vendedorPorTombola(pais: "cl" | "co" | "mx"): Promise<string | undefined> {
  const lista = vendedoresDePais(pais)
  if (!lista.length) return undefined
  try {
    const { getKvValue, setKvValue } = await import("@/lib/supabase-persistence-v3")
    const key = `ptv_rr_${pais}`
    const last = parseInt((await getKvValue(key).catch(() => null)) || "-1")
    const idx = (isNaN(last) ? 0 : last + 1) % lista.length
    await setKvValue(key, String(idx)).catch(() => {})
    return lista[idx].email
  } catch {
    return lista[0].email
  }
}

export const registrarSolicitudCallbackSchema = {
  name: "registrar_solicitud_callback",
  description:
    "Registra un Lead en Zoho CRM. Dos usos: (1) callback explícito — el prospecto pide que lo llamen ('que me llamen', 'prefiero que me contacten', 'mejor por teléfono') → déjalo SIN seguimientoCotizacion: el Lead entra a la tómbola del equipo comercial. (2) Fallback de cotización — el prospecto tenía intención de cotizar y mostró interés real, pero NO alcanzaste a reunir los datos para emitir la cotización formal (le falta RUT, dirección o email y no los entrega) → pasa seguimientoCotizacion=true: el Lead entra igual a la tómbola y el vendedor sorteado lo retoma con ese contexto. NO usar para reuniones agendadas (para eso existe agendar_reunion). Antes de invocarla, captura nombre, empresa y teléfono como mínimo. Email, necesidad, cantidad de trabajadores y preferencia de horario son recomendados.",
  input_schema: {
    type: "object" as const,
    properties: {
      nombre: {
        type: "string" as const,
        description: "Nombre completo del prospecto.",
        minLength: 1,
        maxLength: 200,
      },
      empresa: {
        type: "string" as const,
        description: "Nombre de la empresa del prospecto.",
        minLength: 1,
        maxLength: 200,
      },
      telefono: {
        type: "string" as const,
        description: "Teléfono al que el prospecto quiere ser llamado.",
        minLength: 6,
        maxLength: 30,
      },
      email: {
        type: "string" as const,
        description: "Email del prospecto. Opcional pero recomendado.",
      },
      necesidad: {
        type: "string" as const,
        description: "Descripción libre de lo que busca. Si menciona 'acceso', 'comedor' o 'asistencia', el CRM la mapea al picklist.",
      },
      trabajadores: {
        type: "string" as const,
        description: "Cantidad de trabajadores reportada como string.",
      },
      cargo: {
        type: "string" as const,
        description: "Cargo del contacto en la empresa, si lo mencionó.",
      },
      pais: {
        type: "string" as const,
        description: "País del prospecto. Default Chile.",
      },
      ciudad: {
        type: "string" as const,
        description: "Ciudad del prospecto.",
      },
      preferenciaHorario: {
        type: "string" as const,
        description: "Franja horaria preferida para el callback (texto libre).",
      },
      seguimientoCotizacion: {
        type: "boolean" as const,
        description:
          "true SOLO en el fallback de cotización: el prospecto tenía intención de cotizar y mostró interés, pero no se pudo emitir la cotización por falta de datos. Marca el contexto para el vendedor que salga sorteado en la tómbola. Para callbacks normales, omítelo o false.",
      },
      zohoLeadId: {
        type: "string" as const,
        description:
          "ID del Lead que YA existe en Zoho (viene en el bloque '[Datos del formulario web: ... zohoLeadId ...]' cuando la conversación la inició Vicky). Si lo pasas, NO se crea un lead nuevo: se REASIGNA ese mismo lead al ejecutivo para que lo contacte (evita duplicados). Omítelo cuando el prospecto llegó solo por WhatsApp (sin lead previo).",
      },
    },
    required: ["nombre", "empresa", "telefono"],
  },
}

export type RegistrarSolicitudCallbackInput = {
  nombre: string
  empresa: string
  telefono: string
  email?: string
  necesidad?: string
  trabajadores?: string
  cargo?: string
  pais?: string
  ciudad?: string
  preferenciaHorario?: string
  seguimientoCotizacion?: boolean
  zohoLeadId?: string
}

export type RegistrarSolicitudCallbackResultado =
  | {
      ok: true
      leadId: string
      entraATombola: boolean
      ownerEmail: string
      mensajeParaProspecto: string
    }
  | {
      ok: false
      error: string
    }

export async function registrarSolicitudCallback(
  args: RegistrarSolicitudCallbackInput,
): Promise<RegistrarSolicitudCallbackResultado> {
  // Dueño por tómbola en AMBOS modos (callback explícito y fallback de
  // cotización): la regla de leads de Zoho no dispara para creaciones por API
  // y un lead con owner Vicky queda en la bandeja de nadie.
  const pais = paisDeTelefono(args.telefono)
  const ownerEmail = await vendedorPorTombola(pais)

  // Lead PRE-EXISTENTE en Zoho (outbound del formulario): NO crear duplicado.
  // Se reasigna el MISMO lead al vendedor sorteado (la tómbola de Zoho es una
  // regla de creación y no re-corre en updates).
  const existingLeadId = (args.zohoLeadId || "").trim()
  if (existingLeadId && ownerEmail) {
    const upd = await updateZohoLeadOwner(existingLeadId, ownerEmail)
    if (!upd.success) {
      console.error("[registrar_solicitud_callback] reasignación falló:", upd.error)
      return { ok: false, error: `No se pudo reasignar el lead existente: ${upd.error}` }
    }
    return {
      ok: true,
      leadId: existingLeadId,
      entraATombola: true,
      ownerEmail,
      mensajeParaProspecto:
        `¡Listo! Dejé registrado que prefieres que te contacten: nuestro ejecutivo te va a llamar al ${args.telefono}` +
        (args.preferenciaHorario ? ` (en el horario que pediste: ${args.preferenciaHorario})` : "") +
        `. ¿Hay algo más en lo que pueda ayudarte mientras tanto?`,
    }
  }

  const result = await createZohoLead({
    nombre: args.nombre,
    empresa: args.empresa,
    email: args.email,
    telefono: args.telefono,
    cargo: args.cargo,
    pais: args.pais || "Chile",
    ciudad: args.ciudad,
    trabajadores: args.trabajadores,
    necesidad: args.necesidad,
    reunionAgendada: false,
    preferenciaHorario: args.preferenciaHorario,
    contactoWA: args.telefono,
    ownerEmail,
  })

  if (!result.success) {
    console.error("[registrar_solicitud_callback] createZohoLead falló:", result.error)
    return { ok: false, error: result.error }
  }

  const mensajeParaProspecto = args.seguimientoCotizacion
    ? `¡Listo! Dejé registrados tus datos y uno de nuestros ejecutivos te va a contactar al ${args.telefono} para afinar la propuesta. ¿Hay algo más en lo que pueda ayudarte mientras tanto?`
    : `¡Listo! Tomé tus datos y un ejecutivo del equipo te contactará al ${args.telefono}` +
      (args.preferenciaHorario ? ` (te llamaremos en el horario que pediste: ${args.preferenciaHorario})` : "") +
      `. ¿Hay algo más en lo que pueda ayudarte mientras tanto?`

  return {
    ok: true,
    leadId: result.leadId,
    entraATombola: result.entraATombola,
    ownerEmail: result.ownerEmail,
    mensajeParaProspecto,
  }
}
