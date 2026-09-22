/**
 * HORARIOS QUE QUEDARON EN EL AIRE (14-sep, caso Gianella / +56974310199).
 *
 * Ella pidió los horarios de su capacitación **4 segundos antes** de que su
 * implementación terminara de escribirse. Vicky contestó lo correcto en ese
 * instante ("todavía no está lista"), pero como el agente solo corre cuando el
 * cliente escribe, nadie volvió a ofrecérselos: siguió conversando, Vicky le
 * prometió dos veces que "iba revisando" sin llamar la tool (tools=0 en el log)
 * y el vigía recién la habría tocado a las 24 h HÁBILES. Una clienta que acaba
 * de pagar quedó esperando por una carrera de segundos.
 *
 * `ver_cupos_capacitacion` deja la marca `onb_pidio_cupos_<fono>` cuando se
 * niega por falta de implementación, y el job que crea la IMP llama a esto:
 * los horarios REALES del relator salen solos, en el mismo minuto, sin esperar
 * al cliente ni al vigía. Mensaje TRANSACCIONAL (regla 07-sep): es consecuencia
 * directa de algo que el cliente pidió, no proactividad comercial.
 */

import { getKvValue, setKvValue } from "./supabase-persistence-v3"
import { claveCapacitacion } from "./onboarding/fase"
import { avisarEquipoInterno } from "./alerta-interna"

const CLAVE = (c: string) => `onb_pidio_cupos_${c.replace(/\D/g, "")}`

/** ¿Este contacto pidió horarios y se quedó sin respuesta? */
export async function pidioCuposSinImplementacion(contact: string): Promise<boolean> {
  return Boolean(await getKvValue(CLAVE(contact)).catch(() => null))
}

/**
 * Manda los horarios reales del relator al contacto que los pidió antes de
 * tener implementación. Idempotente: consume la marca al primer envío.
 * Best-effort — jamás tumba al llamador.
 */
export async function ofrecerCuposPendientes(contact: string): Promise<{ enviado: boolean; motivo?: string }> {
  const c = contact.replace(/\D/g, "")
  try {
    if (!(await pidioCuposSinImplementacion(c))) return { enviado: false, motivo: "no_pidio" }

    const crudo = await getKvValue(claveCapacitacion(c)).catch(() => null)
    const cap = crudo
      ? (JSON.parse(crudo) as { relator?: { nombre: string; email: string }; bookingId?: string; numero?: string })
      : null
    if (cap?.bookingId) {
      await setKvValue(CLAVE(c), "").catch(() => {})
      return { enviado: false, motivo: "ya_agendada" }
    }
    if (!cap?.relator?.email) return { enviado: false, motivo: "sin_relator" }

    const { servicioCurso1De, staffDe, fechasAgendables, aFormatoBookings, etiquetaFechaCL } = await import(
      "./onboarding/agenda-capacitacion"
    )
    const servicioId = servicioCurso1De(cap.relator.email)
    const staffId = staffDe(cap.relator.email)
    if (!servicioId || !staffId) return { enviado: false, motivo: "sin_calendario" }

    const { fetchDisponibilidad } = await import("./zoho-bookings")
    const dias: Array<{ etiqueta: string; horas: string[] }> = []
    for (const f of fechasAgendables(new Date(), 4)) {
      const r = (await fetchDisponibilidad(servicioId, aFormatoBookings(f), staffId).catch(() => null)) as
        | { response?: { returnvalue?: { data?: unknown } } }
        | null
      const d = r?.response?.returnvalue?.data
      const lista = Array.isArray(d) ? d : d ? [d] : []
      // Bookings responde el TEXTO "Slots Not Available" cuando no hay cupo.
      const horas = lista.flat().map((x) => String(x).trim()).filter((x) => /\d{1,2}:\d{2}/.test(x))
      if (horas.length) dias.push({ etiqueta: etiquetaFechaCL(f), horas })
      if (dias.length >= 2) break
    }

    const { sendBotmakerMessage } = await import("./botmaker-push-v3")
    if (!dias.length) {
      // Sin cupos no se inventa una fecha: se le avisa al relator y al cliente
      // se le dice la verdad (la regla del 09-sep: Vicky no promete horas que
      // no existen, escala).
      await avisarEquipoInterno(
        `⏳ ${cap.relator.nombre} no tiene NINGÚN cupo en los próximos días y +${c} (${cap.numero || "sin IMP"}) pidió su capacitación tras pagar. Hay que abrirle uno.`,
      ).catch(() => {})
      const ok = await sendBotmakerMessage(
        c,
        `Ya quedó lista tu implementación 🙌 Tu implementador es ${cap.relator.nombre}.\n\n` +
          `Su agenda no tiene cupos abiertos en los próximos días, así que ya le pedí que te contacte directamente para darte hora. ` +
          `En cuanto me confirme, te la dejo agendada por aquí.`,
        undefined,
        { transaccional: true },
      ).catch(() => false)
      if (ok) await setKvValue(CLAVE(c), "").catch(() => {})
      return { enviado: Boolean(ok), motivo: "sin_cupos" }
    }

    const lineas = dias.map((d) => `• ${d.etiqueta}: ${d.horas.join(" · ")}`).join("\n")
    const ok = await sendBotmakerMessage(
      c,
      `Ya quedó lista tu implementación 🙌 Tu implementador es ${cap.relator.nombre} y estos son los horarios que tiene disponibles:\n\n` +
        `${lineas}\n\n` +
        `Dime cuál te acomoda y te lo reservo 😊`,
      undefined,
      { transaccional: true },
    ).catch(() => false)
    if (ok) await setKvValue(CLAVE(c), "").catch(() => {})
    return { enviado: Boolean(ok) }
  } catch (e) {
    console.warn(`[cupos-pendientes] ${c}:`, e instanceof Error ? e.message : String(e))
    return { enviado: false, motivo: "error" }
  }
}
