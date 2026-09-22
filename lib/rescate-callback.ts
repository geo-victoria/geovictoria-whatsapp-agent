/**
 * RESCATE DETERMINISTA DEL CALLBACK (10-sep, casos Daniela/Barría Carreño y
 * Rosa/Empresa JRV; 17 mensajes "tuve un problema técnico… ya le avisé al
 * equipo" en 30 días).
 *
 * El cinturón anti-alucinación del webhook detecta que Vicky prometió
 * contacto sin tool y reintenta forzando la tool. Cuando el reintento también
 * falla, hasta hoy salía un texto enlatado y una alerta a `equipo:alerta`
 * (una tabla que nadie mira en tiempo real): sin lead, sin traspaso, sin
 * promesa en el vigía y con el loop comercial VIVO pidiéndole la dotación a
 * alguien que pidió una llamada.
 *
 * Ahora el código hace lo que el modelo no hizo:
 *  - con traspaso ACTIVO (el cliente reclama que no lo llamaron): NO se
 *    re-sortea; se registra la promesa a nombre del vendedor vigente y se
 *    alerta con nombre y apellido;
 *  - sin traspaso: `traspasarAhora` (escalera + tómbola + vic_ptv + loop
 *    cerrado + nota) y Vicky presenta al vendedor con el texto canónico;
 *  - si tampoco se puede (cliente existente, no prospecto, roster caído):
 *    promesa `callback` pendiente para que el vigía la persiga y quede en la
 *    Cartera, loop cerrado, y el texto honesto correspondiente.
 *
 * Nada de esto toca la conversación si falla: devuelve `null` y el llamador
 * conserva su texto.
 */
import { avisarEquipoInterno } from "./alerta-interna"
import { registrarPromesa } from "./promesas"
import { mensajePresentacion } from "./ptv"

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "").trim()

function H(): Record<string, string> {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  }
}

export async function getSupabaseRows<T>(path: string, init: RequestInit = {}): Promise<T[]> {
  return supa<T>(path, init)
}

async function supa<T>(path: string, init: RequestInit = {}): Promise<T[]> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return []
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...H(), ...(init.headers || {}) }, cache: "no-store" })
  if (!r.ok) return []
  return (await r.json().catch(() => [])) as T[]
}

/** Teléfono ALTERNATIVO que el cliente escribió en el chat (caso Daniela:
 * escribió desde un número y pidió la llamada a otro). */
export function telefonoAlternativoEn(textosCliente: string[], contact: string): string | null {
  const propio = contact.replace(/\D/g, "").slice(-9)
  for (const t of textosCliente) {
    const m = t.match(/(?:\+?56\s?)?9(?:[\s.-]?\d){8}/g) || []
    for (const raw of m) {
      const d = raw.replace(/\D/g, "")
      const nueve = d.slice(-9)
      if (nueve.length === 9 && nueve.startsWith("9") && nueve !== propio) return `56${nueve}`
    }
  }
  return null
}

export type RescateCallback = {
  via: "reafirmacion" | "traspaso" | "promesa"
  reply: string | null
  vendedor?: { nombre: string; email: string; telefono?: string }
}

export async function rescatarCallback(opts: {
  contact: string
  pais: "cl" | "co" | "mx" | "pe"
  textosCliente: string[]
  motivo?: string
  /** Texto que el modelo iba a mandar (se conserva en la reafirmación). */
  replyModelo: string
}): Promise<RescateCallback | null> {
  const clean = (opts.contact || "").replace(/\D/g, "")
  if (!clean) return null
  const alt = telefonoAlternativoEn(opts.textosCliente, clean)
  const fonoTxt = alt ? ` (pidió la llamada al +${alt})` : ""

  try {
    // A. Traspaso ACTIVO: el cliente reclama. No se re-sortea (candado PTV);
    //    se le carga la promesa al vendedor vigente y se alerta con nombre.
    const activo = await supa<{ vendedor_email: string; vendedor_nombre: string | null; traspasado_at: string }>(
      `vic_ptv?contact=eq.${clean}&estado=eq.activo&select=vendedor_email,vendedor_nombre,traspasado_at&limit=1`,
    )
    if (activo.length) {
      const v = activo[0]
      await registrarPromesa({
        contact: clean,
        tipo: "llamada_ejecutivo",
        detalle: `cliente reclama contacto tras traspaso del ${v.traspasado_at.slice(0, 16)}${fonoTxt}`,
        vendedorEmail: v.vendedor_email,
        horasHabiles: 2,
      }).catch(() => false)
      await avisarEquipoInterno(
        `🚨 CLIENTE RECLAMA CONTACTO: +${clean} pide que lo llamen y sigue traspasado a ${v.vendedor_nombre || v.vendedor_email} desde ${v.traspasado_at.slice(0, 16)} sin gestión visible${fonoTxt}. Promesa registrada a su nombre (2 h hábiles).`,
      ).catch(() => {})
      return {
        via: "reafirmacion",
        reply: null,
        vendedor: { nombre: v.vendedor_nombre || v.vendedor_email.split("@")[0], email: v.vendedor_email },
      }
    }

    // B. Sin traspaso: lo hace el código (escalera, tómbola, vic_ptv, loop).
    const { traspasarAhora } = await import("@/app/api/vic-ptv-cron/route")
    const { getQuotePointer } = await import("./supabase-persistence-v3")
    const puntero = await getQuotePointer(clean).catch(() => null)
    const r = await Promise.race([
      traspasarAhora(clean, { motivo: opts.motivo || "solicitud_explicita_persona", calificado: Boolean(puntero?.quoteId) }),
      new Promise<null>((res) => setTimeout(() => res(null), 9000)),
    ])
    if (r?.ok && r.vendedor?.email) {
      await registrarPromesa({
        contact: clean,
        tipo: "llamada_ejecutivo",
        detalle: `rescate automático del callback (el modelo no ejecutó la tool)${fonoTxt}`,
        vendedorEmail: r.vendedor.email,
      }).catch(() => false)
      if (alt) {
        await avisarEquipoInterno(
          `📞 +${clean} pidió que lo llamen a OTRO número: +${alt}. Traspasado a ${r.vendedor.nombre} (${r.vendedor.email}).`,
        ).catch(() => {})
      }
      const texto = mensajePresentacion(opts.pais, r.vendedor.nombre, {
        email: r.vendedor.email,
        whatsapp: r.vendedor.telefono || undefined,
      })
      return { via: "traspaso", reply: texto, vendedor: r.vendedor }
    }

    // C. No se pudo traspasar. Motivos legítimos (cliente existente / no
    //    prospecto) ya dejaron su alerta dentro de traspasarAhora; el resto
    //    (roster caído, candado, timeout) queda como promesa PENDIENTE para
    //    que el vigía la persiga y aparezca en la Cartera.
    const motivo = r?.motivo || "timeout"
    await registrarPromesa({
      contact: clean,
      tipo: "callback",
      detalle: `callback sin registrar (${motivo})${fonoTxt}`,
      horasHabiles: 2,
    }).catch(() => false)
    await supa(`vic_loop?contact=eq.${clean}&estado=eq.activo`, {
      method: "PATCH",
      body: JSON.stringify({ estado: "cerrado", motivo_cierre: "derivado" }),
    }).catch(() => [])
    const reply = /^cliente_existente/.test(motivo)
      ? "Veo que ya eres cliente 😊 Tu solicitud quedó registrada para que el equipo que lleva tu cuenta te contacte. Si es algo operativo, también puedes escribir a soporte@geovictoria.com o al 600 914 3819."
      : /^no_prospecto/.test(motivo)
        ? null
        : "Dejé registrada tu solicitud de contacto y el equipo la tiene con tus datos; te confirmo por aquí apenas la tome un ejecutivo. No necesitas reenviarme nada 🙌"
    return { via: "promesa", reply }
  } catch (e) {
    console.error(`[rescate-callback] ${clean}:`, e instanceof Error ? e.message : e)
    return null
  }
}
