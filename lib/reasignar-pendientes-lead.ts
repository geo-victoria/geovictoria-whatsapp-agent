/**
 * TAREAS Y LLAMADAS DEL LEAD SIGUEN A SU DUEÑO NUEVO (29-ago, orden de Lalo:
 * "puedes cambiar el owner de las tareas al traspasar el lead por tómbola?").
 *
 * EL PROBLEMA: el workflow "TASK Y CALL NO CONTACTADO" crea, al nacer el lead,
 * una tarea ("Vicky GeoVictoria recuerda llamar a X y calificar a empresa") y
 * una llamada agendada ("Call scheduled with X"). Las dos nacen a nombre del
 * usuario ROBOT Vicky (vicky@geovictoria.com, id 3525045000484500876), porque
 * en ese instante el lead es de ella. Cuando la tómbola se lo entrega a una
 * persona cinco minutos después, la tarea y la llamada SE QUEDAN con el robot:
 * no aparecen en el to-do de nadie y el pendiente muere ahí. Verificado en los
 * casos Sebastián Goic y Belén Fuentes.
 *
 * DETALLE QUE IMPORTA: estas actividades cuelgan del lead por **What_Id**, no
 * por Who_Id (Who_Id viene en null) — buscarlas solo por Who_Id no encuentra
 * nada. Se consultan por ambos campos.
 *
 * Best-effort puro: jamás lanza ni bloquea la conversación (principio 24-jul).
 */

import { getZohoAccessToken } from "./zoho-token"

/** Usuarios robot: Vicky y la cuenta de administración. Override por env. */
const IDS_ROBOT = (
  process.env.VICKY_OWNERS_ROBOT || "3525045000484500876,3525045000000200013"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

const EMAIL_ROBOT = /vicky@|info@geovictoria/i

/** Una tarea ya cerrada no le sirve a nadie: solo se mueven las pendientes. */
const ESTADO_CERRADO = /complet|cerrad|closed|cancel/i

type Actividad = { id?: string; Status?: string; Owner?: { id?: string; name?: string } }

export type PendientesReasignados = {
  tareas: number
  llamadas: number
  duenoEmail?: string
  error?: string
}

/**
 * Mueve al dueño ACTUAL del lead las tareas y llamadas que quedaron a nombre
 * del robot. Si el lead sigue en manos robot, no hace nada (no hay a quién
 * entregárselas todavía).
 */
export async function reasignarPendientesDelLead(
  leadId: string,
  opts: { ownerId?: string; ownerEmail?: string } = {},
): Promise<PendientesReasignados> {
  const vacio: PendientesReasignados = { tareas: 0, llamadas: 0 }
  if (!leadId) return { ...vacio, error: "leadId faltante" }
  try {
    const token = await getZohoAccessToken()
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }

    // A quién se las entregamos: lo que diga el llamador, o el dueño vigente.
    let destinoId = String(opts.ownerId || "").trim()
    let destinoEmail = String(opts.ownerEmail || "").trim()
    if (!destinoId || !destinoEmail) {
      const g = await fetch(`${api}/crm/v3/Leads/${leadId}?fields=Owner`, { headers: H, cache: "no-store" })
      if (g.status !== 200) return { ...vacio, error: `lead no legible (${g.status})` }
      const owner = ((await g.json().catch(() => ({}))) as {
        data?: Array<{ Owner?: { id?: string; email?: string } }>
      }).data?.[0]?.Owner
      destinoId = destinoId || String(owner?.id || "")
      destinoEmail = destinoEmail || String(owner?.email || "")
    }
    if (!destinoId) return { ...vacio, error: "el lead no tiene dueño legible" }
    if (EMAIL_ROBOT.test(destinoEmail) || IDS_ROBOT.includes(destinoId)) {
      return { ...vacio, duenoEmail: destinoEmail, error: "el lead sigue con dueño robot" }
    }

    const movidas: Record<string, number> = { Tasks: 0, Calls: 0 }
    for (const modulo of ["Tasks", "Calls"] as const) {
      // Las actividades del workflow cuelgan por What_Id (Who_Id llega null);
      // se piden por los dos campos para no depender de esa particularidad.
      const campos = modulo === "Tasks" ? "id, Owner, Status" : "id, Owner"
      const q = await fetch(`${api}/crm/v8/coql`, {
        method: "POST",
        headers: H,
        cache: "no-store",
        body: JSON.stringify({
          select_query:
            `select ${campos} from ${modulo} ` +
            `where (What_Id = '${leadId}' or Who_Id = '${leadId}') limit 50`,
        }),
      })
      // 204 = el lead no tiene actividades de ese tipo; no es un error.
      if (q.status === 204) continue
      if (!q.ok) {
        console.warn(`[pendientes-lead] COQL ${modulo} devolvió ${q.status} (lead ${leadId})`)
        continue
      }
      const filas = (((await q.json().catch(() => ({}))) as { data?: Actividad[] }).data || []).filter((a) => {
        if (!a.id) return false
        const dueno = String(a.Owner?.id || "")
        if (!IDS_ROBOT.includes(dueno)) return false // de una persona: no se toca
        if (modulo === "Tasks" && ESTADO_CERRADO.test(String(a.Status || ""))) return false
        return true
      })
      if (filas.length === 0) continue

      const put = await fetch(`${api}/crm/v3/${modulo}`, {
        method: "PUT",
        headers: H,
        cache: "no-store",
        body: JSON.stringify({ data: filas.map((a) => ({ id: a.id, Owner: { id: destinoId } })) }),
      })
      const resp = (await put.json().catch(() => ({}))) as { data?: Array<{ status?: string }> }
      const ok = (resp.data || []).filter((r) => r?.status === "success").length
      movidas[modulo] = ok
      if (ok !== filas.length) {
        console.warn(
          `[pendientes-lead] ${modulo}: ${ok}/${filas.length} movidas al dueño ${destinoEmail} (lead ${leadId})`,
        )
      }
    }

    if (movidas.Tasks || movidas.Calls) {
      console.log(
        `[pendientes-lead] lead ${leadId} → ${destinoEmail}: ${movidas.Tasks} tarea(s) y ${movidas.Calls} llamada(s)`,
      )
    }
    return { tareas: movidas.Tasks, llamadas: movidas.Calls, duenoEmail: destinoEmail }
  } catch (e) {
    return { ...vacio, error: e instanceof Error ? e.message : "excepción" }
  }
}
