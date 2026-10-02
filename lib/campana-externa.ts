/**
 * CAMPAÑA EXTERNA: contactos que atiende una PERSONA, no Vicky (02-oct, Lalo:
 * "enviarlo desde la línea de Colombia por Botmaker… que no pasen por Vicky…
 * que todas las conversaciones queden a nombre de María Fernanda Gómez").
 *
 * La campaña la manda el equipo desde Botmaker; la respuesta del cliente llega
 * igual a nuestro webhook (los bots están unificados). Con la marca:
 *   1. Vicky NO contesta: el mensaje se guarda en el historial y nada más.
 *   2. La primera respuesta deja la conversación ASIGNADA en Botmaker a la
 *      persona dueña de la campaña (con la ventana abierta el flujo de
 *      asignación sí corre; con el chat asignado el bot deja de correr).
 *   3. Ningún mensaje proactivo nuestro (toques, traspasos, chequeos,
 *      campañas) sale a ese número: el gate de proactividad lo bloquea.
 *
 * Marca en vic_kv `campana_externa_<fono>` = {campana, agente, hasta, at}. El
 * vencimiento va DENTRO del valor (getKvValue no filtra filas vencidas), así
 * que una campaña olvidada se apaga sola. Tope 90 días.
 */
// Import dinámico: así la parte pura (marcaVigente) carga en node --test.
const kv = () => import("./supabase-persistence-v3")

export const CAMPANA_EXTERNA_MAX_DIAS = 90

export type MarcaCampanaExterna = { campana: string; agente: string; hasta: string; at: string }

const clave = (contact: string) => `campana_externa_${(contact || "").replace(/\D/g, "")}`

/** Lee y valida el valor guardado; vencida o ilegible = null. PURA. */
export function marcaVigente(valor: string | null | undefined, ahoraMs: number): MarcaCampanaExterna | null {
  if (!valor) return null
  try {
    const m = JSON.parse(valor) as Partial<MarcaCampanaExterna>
    const t = Date.parse(String(m.hasta || ""))
    if (!m.campana || !m.agente || !Number.isFinite(t) || t <= ahoraMs) return null
    return { campana: m.campana, agente: m.agente, hasta: m.hasta!, at: m.at || "" }
  } catch {
    return null
  }
}

/** ¿El contacto está en una campaña externa vigente? Fail-open: ante duda, null. */
export async function campanaExternaDe(contact: string): Promise<MarcaCampanaExterna | null> {
  try {
    return marcaVigente(await (await kv()).getKvValue(clave(contact)), Date.now())
  } catch {
    return null
  }
}

export async function marcarCampanaExterna(
  contact: string,
  campana: string,
  agente: string,
  dias: number,
): Promise<MarcaCampanaExterna> {
  const d = Math.min(Math.max(Number(dias) || 30, 1), CAMPANA_EXTERNA_MAX_DIAS)
  const marca: MarcaCampanaExterna = {
    campana,
    agente: agente.trim().toLowerCase(),
    hasta: new Date(Date.now() + d * 86400e3).toISOString(),
    at: new Date().toISOString(),
  }
  await (await kv()).setKvValue(clave(contact), JSON.stringify(marca))
  return marca
}

export async function desmarcarCampanaExterna(contact: string): Promise<void> {
  await (await kv()).setKvValue(clave(contact), "")
}

/**
 * Para los webhooks: si el contacto está en campaña externa, guarda el
 * mensaje SIN respuesta y asigna el chat a la persona dueña (una vez cada 12 h,
 * por si alguien lo desasignó). Devuelve la marca si lo atendió, null si no.
 */
export async function atenderCampanaExterna(
  contact: string,
  message: string,
  guardar: (texto: string) => Promise<unknown>,
  diferir: (fn: () => Promise<void>) => void,
): Promise<MarcaCampanaExterna | null> {
  const marca = await campanaExternaDe(contact)
  if (!marca) return null
  await guardar(`[Campaña "${marca.campana}": atiende ${marca.agente}; Vicky no responde]`).catch(() => {})
  console.log(`[campana-externa] ${contact} (${marca.campana}) — mensaje guardado sin respuesta (${message.length} chars)`)
  diferir(async () => {
    const fono = (contact || "").replace(/\D/g, "")
    const candado = `campana_externa_asig_${fono}`
    const { getKvValue, setKvValue } = await kv()
    const prev = Date.parse((await getKvValue(candado).catch(() => "")) || "")
    if (Number.isFinite(prev) && Date.now() - prev < 12 * 3600e3) return
    const { asignarConversacionAlDueno } = await import("./botmaker-agentes")
    const r = await asignarConversacionAlDueno(fono, marca.agente)
    console.log(`[campana-externa] asignación ${fono} → ${marca.agente}: ${r.motivo}`)
    if (r.asignado || /asignada/.test(r.motivo)) await setKvValue(candado, new Date().toISOString()).catch(() => {})
  })
  return marca
}
