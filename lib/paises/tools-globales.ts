/**
 * TOOLS GLOBALES — la implementación de CHILE para Perú, Colombia y México
 * (27-sep, orden de Lalo: "todas las tools deben ser UNA implementación
 * global: la de Chile").
 *
 * Hasta hoy cada país tenía un adaptador (lib/paises/<cc>/tools-unificadas.ts)
 * que, para estas tools, reescribía el mensaje al cliente, traía su propia
 * copia del saneador de soporte, su propio resolvedor de la formal vigente o
 * derivaba a una tool propia (`derivar_a_ejecutivo`). Tres copias casi iguales
 * que se separaban solas — de ahí las brechas de país.
 *
 * Ahora las tools de esta lista corren SOLO acá, y acá solo se llama a la
 * implementación chilena de `lib/tools/*` con los DATOS del país: la ficha
 * operativa (nombre, zona horaria, tarjeta de soporte, reglas de Zoho), el
 * evento de Cal del país y los ítems de su motor de cotización. Ningún país
 * reescribe un mensaje: los textos al cliente los arma la tool chilena.
 * `tests/tools-globales.test.ts` falla si un adaptador vuelve a atender una
 * de estas tools por su cuenta.
 *
 * Imports estáticos solo a módulos PUROS (los adaptadores y este archivo los
 * cargan los tests con node --test); todo lo que toca red va por import
 * dinámico dentro del despacho.
 */
import { fichaOperativa } from "./ficha-operativa.ts"
import { rucValido } from "../rut.ts"

export type PaisGlobal = "pe" | "co" | "mx"

/** Tools cuya implementación es UNA sola (la chilena) para los cuatro países. */
export const TOOLS_GLOBALES = [
  "consultar_agente_soporte",
  "registrar_comprobante_transferencia",
  "marcar_no_contactar",
  "programar_seguimiento",
  "reenviar_cotizacion_correo",
  "enviar_cotizacion_whatsapp",
  "enviar_ficha_reloj",
  "buscar_prospect_en_zoho",
  "consultar_disponibilidad_horario",
  "agendar_reunion",
  "reagendar_reunion",
  "consultar_siguiente_descuento",
  "aplicar_siguiente_descuento",
  "actualizar_cotizacion",
  "derivar_a_soporte",
  "registrar_solicitud_callback",
] as const

export type ToolGlobal = (typeof TOOLS_GLOBALES)[number]

export function esToolGlobal(name: string): name is ToolGlobal {
  return (TOOLS_GLOBALES as readonly string[]).includes(name)
}

/** Configuración de una formal (lo que el modelo manda en actualizar_cotizacion). */
export type ConfigFormal = {
  userCount: number
  hardware?: unknown[]
  puntosInstalacion?: unknown[]
}

/** Lo ÚNICO que el país aporta: datos y su motor de precios. */
export type ContextoGlobal = {
  pais: PaisGlobal
  contact: string
  /** Event type de Cal.com del país ("" = el país no tiene agenda en línea). */
  eventoAgenda: () => Promise<string>
  /**
   * Ítems de la formal a precio de LISTA con el motor del país (la edición en
   * sitio la hace la tool chilena actualizar_cotizacion con `_itemsPais`).
   */
  itemsFormal: (cfg: ConfigFormal) => Promise<{ ok: true; items: unknown[] } | { ok: false; error: string }>
}

/** Memoria del ÚLTIMO estimado del contacto (vic_kv `<pais>_pref_<contacto>`). */
export type PrefPais = { userCount: number; hardware?: unknown[]; puntosInstalacion?: unknown[]; escalon: number }

export async function leerPrefPais(pais: PaisGlobal, contact: string): Promise<PrefPais | null> {
  try {
    const { getKvValue } = await import("../supabase-persistence-v3.ts")
    const raw = await getKvValue(`${pais}_pref_${contact}`)
    return raw ? (JSON.parse(raw) as PrefPais) : null
  } catch {
    return null
  }
}

export async function guardarPrefPais(pais: PaisGlobal, contact: string, p: PrefPais): Promise<void> {
  try {
    const { setKvValue } = await import("../supabase-persistence-v3.ts")
    await setKvValue(`${pais}_pref_${contact}`, JSON.stringify(p))
  } catch {
    /* la memoria del estimado es best-effort */
  }
}

/**
 * La cotización FORMAL sobre la que se trabaja: la que pasó el modelo o, si
 * no, la vigente del contacto (puntero). Se niega si ya está Pagada o si es
 * de otro teléfono. Es el mapeo del `quote_id` que en Chile trae el modelo;
 * la edición la hace la tool chilena.
 */
export async function formalVigentePais(
  contact: string,
  quoteId?: string,
): Promise<{ quoteId: string; escalon: number } | { error: string }> {
  let qid = String(quoteId || "").trim()
  if (!qid) {
    try {
      const { getQuotePointer } = await import("../supabase-persistence-v3.ts")
      qid = (await getQuotePointer(contact))?.quoteId || ""
    } catch {
      /* sin puntero */
    }
  }
  if (!qid) return { error: "No hay una cotización formal vigente en esta conversación: emítela primero con generar_link_cotizadora." }
  try {
    const { fetchZoho } = await import("../zoho-token.ts")
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const mod = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
    const res = await fetchZoho(`${api}/crm/v8/${mod}/${qid}?fields=Estado_Cotizacion,Escalon_Descuento,Tel_fono_Contacto`)
    if (res.status !== 200) return { quoteId: qid, escalon: 0 } // sin lectura: la tool chilena vuelve a validar
    const q = ((await res.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>> }).data?.[0]
    if (!q) return { error: `La cotización ${qid} no existe en el CRM.` }
    if (/pagad/i.test(String(q.Estado_Cotizacion || ""))) {
      return { error: "Esa cotización ya está PAGADA: no se modifica. Si el cliente quiere cambios, el ejecutivo los coordina (derivar_a_soporte)." }
    }
    const tel = String(q.Tel_fono_Contacto || "").replace(/\D/g, "")
    if (tel && contact && !tel.endsWith(contact.replace(/\D/g, "").slice(-9))) {
      return { error: "Esa cotización no es de este contacto." }
    }
    return { quoteId: qid, escalon: Math.max(0, Math.min(2, Number(q.Escalon_Descuento || 0) || 0)) }
  } catch {
    return { quoteId: qid, escalon: 0 }
  }
}

function sinAgenda(pais: PaisGlobal) {
  return {
    ok: false as const,
    error: `La agenda de ${fichaOperativa(pais).nombre} no está configurada. Usa derivar_a_soporte (motivo solicitud_explicita_persona) con la preferencia de horario en el contexto.`,
  }
}

/**
 * Despacha una tool global: la implementación chilena con los datos del país.
 * Solo mapea parámetros (país, contacto, evento, quote_id vigente, ítems del
 * motor del país); jamás arma un texto al cliente.
 */
export async function despacharToolGlobal(ctx: ContextoGlobal, name: ToolGlobal, input: unknown): Promise<unknown> {
  const { pais, contact } = ctx
  const ficha = fichaOperativa(pais)
  const i = (input || {}) as Record<string, unknown>
  switch (name) {
    case "consultar_agente_soporte": {
      const { consultarAgenteSoporte } = await import("../tools/consultar-agente-soporte.ts")
      return consultarAgenteSoporte({ ...(i as object), _pais: pais } as never)
    }
    case "registrar_comprobante_transferencia": {
      const { registrarComprobanteTransferencia } = await import("../tools/registrar-comprobante-transferencia.ts")
      return registrarComprobanteTransferencia(contact, i as never, pais)
    }
    case "marcar_no_contactar": {
      const { marcarNoContactar } = await import("../tools/marcar-no-contactar.ts")
      return marcarNoContactar(i as never)
    }
    case "programar_seguimiento": {
      const { programarSeguimiento } = await import("../tools/programar-seguimiento.ts")
      return programarSeguimiento(i as never)
    }
    case "reenviar_cotizacion_correo": {
      const { reenviarCotizacionCorreo } = await import("../tools/reenviar-cotizacion-correo.ts")
      return reenviarCotizacionCorreo(i as never)
    }
    case "enviar_cotizacion_whatsapp": {
      const { enviarCotizacionWhatsapp } = await import("../tools/enviar-cotizacion-whatsapp.ts")
      return enviarCotizacionWhatsapp({ ...(i as object), _contact: contact } as never)
    }
    case "enviar_ficha_reloj": {
      const { enviarFichaReloj } = await import("../tools/enviar-ficha-reloj.ts")
      return enviarFichaReloj({ pais })
    }
    case "buscar_prospect_en_zoho": {
      const { buscarProspectEnZoho } = await import("../tools/buscar-prospect-en-zoho.ts")
      return buscarProspectEnZoho(i as never)
    }
    // ── Agenda: el evento de Cal del país (el agent-loop inyecta el del dueño
    //    cuando lo tiene); la zona y la confirmación las pone la tool chilena. ──
    case "consultar_disponibilidad_horario": {
      const evento = String(i.eventTypeId || "").trim() || (await ctx.eventoAgenda())
      if (!evento) return sinAgenda(pais)
      const { consultarDisponibilidadHorario } = await import("../tools/consultar-disponibilidad-horario.ts")
      return consultarDisponibilidadHorario({ fechaPropuesta: String(i.fechaPropuesta || ""), country: ficha.nombre, eventTypeId: evento })
    }
    case "agendar_reunion": {
      const evento = String(i.eventTypeId || "").trim() || (await ctx.eventoAgenda())
      if (!evento) return sinAgenda(pais)
      const { agendarReunion } = await import("../tools/agendar-reunion.ts")
      const r = await agendarReunion({
        ...(i as object),
        // Teléfono del canal si el modelo no lo pasó: sin él el Lead queda sin Phone.
        telefono: String(i.telefono || "").trim() || contact,
        country: ficha.nombre,
        eventTypeId: evento,
      } as never)
      // El agent-loop persiste la reunión con esta zona (recordatorios).
      return r.ok ? { ...r, timezone: ficha.tz } : r
    }
    case "reagendar_reunion": {
      if (!(await ctx.eventoAgenda()) && !String(i.eventTypeId || "").trim()) return sinAgenda(pais)
      const { reagendarReunion } = await import("../tools/reagendar-reunion.ts")
      return reagendarReunion({ ...(i as object), country: ficha.nombre, _contact: contact } as never)
    }
    // ── Negociación y edición sobre la formal vigente (tools chilenas) ──
    case "consultar_siguiente_descuento": {
      const f = await formalVigentePais(contact, i.quote_id as string | undefined)
      if ("error" in f) return { ok: false, error: f.error }
      const { consultarSiguienteDescuento } = await import("../tools/consultar-siguiente-descuento.ts")
      const r = await consultarSiguienteDescuento({ quote_id: f.quoteId })
      return { ...r, quoteId: f.quoteId }
    }
    case "aplicar_siguiente_descuento": {
      const f = await formalVigentePais(contact, i.quote_id as string | undefined)
      if ("error" in f) return { ok: false, error: f.error }
      const { aplicarSiguienteDescuento } = await import("../tools/aplicar-siguiente-descuento.ts")
      const r = await aplicarSiguienteDescuento({ quote_id: f.quoteId, pct_ofrecido: Number(i.pct_ofrecido) || undefined })
      if (r.ok) {
        // La memoria del estimado sigue al % comiteado (10 → 1, 20 → 2).
        const pref = await leerPrefPais(pais, contact)
        const pct = Number((r as { ultimoEscalon?: { pct?: number } }).ultimoEscalon?.pct || 0)
        const escalon = pct >= 20 ? 2 : pct >= 10 ? 1 : pref?.escalon || 0
        if (pref) await guardarPrefPais(pais, contact, { ...pref, escalon })
      }
      return { ...r, quoteId: f.quoteId }
    }
    case "actualizar_cotizacion": {
      const f = await formalVigentePais(contact, i.quote_id as string | undefined)
      if ("error" in f) return { ok: false, error: f.error }
      // Como Chile: la configuración nueva es la que manda el MODELO, completa
      // (sin hardware en el input = sin hardware). Jamás la memoria del estimado:
      // con el doble valor el último estimado siempre trae el equipo.
      const cfg: ConfigFormal = {
        userCount: Number(i.userCount || 0),
        hardware: i.hardware as unknown[] | undefined,
        puntosInstalacion: (i.hardware as unknown[] | undefined)?.length ? (i.puntosInstalacion as unknown[] | undefined) : undefined,
      }
      if (!cfg.userCount) {
        return { ok: false, error: "Pásame la configuración COMPLETA nueva (userCount, y hardware/puntos si lleva equipo)." }
      }
      const it = await ctx.itemsFormal(cfg)
      if (!it.ok) return { ok: false, error: it.error }
      const { actualizarCotizacion } = await import("../tools/actualizar-cotizacion.ts")
      const r = await actualizarCotizacion({
        quote_id: f.quoteId,
        userCount: cfg.userCount,
        modulos: ["asistencia"],
        resumen_cambio: String(i.resumen_cambio || "cambio de configuración").slice(0, 200),
        _itemsPais: { pais, items: it.items },
      })
      if (r.ok) {
        const pref = await leerPrefPais(pais, contact)
        await guardarPrefPais(pais, contact, {
          userCount: cfg.userCount,
          hardware: cfg.hardware,
          puntosInstalacion: cfg.puntosInstalacion,
          escalon: Math.max(f.escalon, pref?.escalon || 0),
        })
      }
      return { ...r, quoteId: f.quoteId }
    }
    // ── Derivación y callback: las tools chilenas. El registro en Zoho (hito,
    //    traspaso, tómbola de la ficha) lo hace el agent-loop, igual en los
    //    cuatro países. ──
    case "derivar_a_soporte": {
      // DOCUMENTO MAL FORMADO → la tool se niega y el modelo lo pide de nuevo
      // (29-sep, caso Dariel/NATALY PERU: "2060778786", 10 dígitos, aceptado
      // con un "ya quedó el RUC" y guardado en Zoho con formato chileno).
      const doc = String(i.rutEmpresa || "").replace(/[.\s-]/g, "")
      if (pais === "pe" && doc && !/^\d{8}$/.test(doc) && !rucValido(doc)) {
        return {
          ok: false,
          error: `El documento "${i.rutEmpresa}" no es un RUC válido: el RUC peruano tiene 11 dígitos y empieza en 10 o 20 (el DNI tiene 8). Pídele al cliente que lo revise antes de derivar; no lo des por registrado.`,
        }
      }
      const { derivarASoporte } = await import("../tools/derivar-a-soporte.ts")
      return derivarASoporte({ ...(i as object), _pais: pais } as never)
    }
    case "registrar_solicitud_callback": {
      const { registrarSolicitudCallback } = await import("../tools/registrar-solicitud-callback.ts")
      return registrarSolicitudCallback({
        ...(i as object),
        nombre: String(i.nombre || "Prospecto WhatsApp"),
        empresa: String(i.empresa || ""),
        telefono: String(i.telefono || "").trim() || contact,
        trabajadores: i.trabajadores != null && i.trabajadores !== "" ? String(i.trabajadores) : undefined,
        _pais: pais,
      } as never)
    }
  }
}
