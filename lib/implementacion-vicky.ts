/**
 * IMPLEMENTACIÓN AUTOMÁTICA DEL ALTA POR CHAT (Lalo, 03-sep).
 *
 * "La empresa se crea automáticamente y además se desprende una
 * implementación. Creémosla nosotros, no por Zoho Flow: no habrá duplicidad
 * porque en este caso no hay wizard de auto-onboarding."
 *
 * DOS CAMINOS QUE NO SE PISAN. Las ventas que pasan por el WIZARD generan su
 * implementación desde el Zoho Flow, nacen como `GV Portal` y se reparten
 * solas entre el equipo de ese pipeline (Ortega / González / Bahamondes).
 * El alta POR CHAT no pasa por el wizard, así que ahí no nace nada: esta
 * función llena ese hueco creando la implementación `GV Avanzado`, que es la
 * que llevan Diego Alegre e Ignacio Salinas.
 *
 * TÓMBOLA. Las 11 GV Avanzado del mes se crearon a mano y quedaron 8 para
 * Ignacio y 3 para Diego. Acá se reparten por turno alternado en vic_kv.
 * OJO con la cuenta de Ignacio: `productmanager@geovictoria.pro` es
 * COMPARTIDA y hace de default del módulo, así que el Owner por sí solo no
 * distingue "le tocó a Ignacio" de "no la tomó nadie". Por eso se escribe
 * SIEMPRE `Jefe_de_Proyectos` + `Correo_Jefe_de_Proyectos`: ese par es lo que
 * hace la asignación legible, y es justo lo que hoy el humano pone a mano.
 *
 * Todo best-effort: si Zoho falla, el alta de la empresa NO se cae — el
 * cliente ya pagó y ya tiene su cuenta. Queda aviso interno para crearla a
 * mano.
 */

import { getZohoAccessToken } from "./zoho-token"
import { getKvValue, setKvValue } from "./supabase-persistence-v3"

const API = () => (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()

/** Relatores de GV Avanzado. La cuenta de Ignacio es compartida a propósito. */
export const RELATORES_GV_AVANZADO = [
  { nombre: "Diego Alegre", email: "dalegre@geovictoria.com", zohoId: "3525045000451232212" },
  { nombre: "Ignacio Salinas", email: "isalinas@geovictoria.com", zohoId: "3525045000440597415" },
] as const

/** Turno alternado, persistido — sobrevive a los reinicios de instancia. */
export async function siguienteRelator(): Promise<(typeof RELATORES_GV_AVANZADO)[number]> {
  try {
    const raw = (await getKvValue("tombola_implementacion_rr")) || ""
    const idx = (Number(raw) || 0) % RELATORES_GV_AVANZADO.length
    await setKvValue("tombola_implementacion_rr", String(idx + 1)).catch(() => {})
    return RELATORES_GV_AVANZADO[idx]
  } catch {
    return RELATORES_GV_AVANZADO[0]
  }
}

export type DatosImplementacion = {
  razonSocial: string
  rut?: string
  accountId?: string
  contactId?: string
  dealId?: string
  quoteId?: string
  ndvId?: string
  usuarios?: number
  equipos?: number
  metodoMarcaje?: string[]
  correoSolicitante?: string
  ejComercialId?: string
  comentarios?: string
}

/**
 * Crea la implementación en Zoho. Devuelve el id, o "" si no se pudo (el
 * llamador avisa al equipo, nunca rompe el alta).
 *
 * Los campos son los que el humano llena AL CREAR (verificados contra
 * IMP-11320); todo lo de ejecución —fechas y relatores de capacitación,
 * semáforo, avances, `Confirmo_Creación_Empresa`— se llena DESPUÉS y va nulo.
 */
export async function crearImplementacionGvAvanzado(
  d: DatosImplementacion,
): Promise<{ id: string; numero?: string; relator: { nombre: string; email: string } } | null> {
  if (!d.razonSocial) return null
  const relator = await siguienteRelator()
  const registro: Record<string, unknown> = {
    Name: `ASISTENCIA - ${d.razonSocial}`.slice(0, 120),
    Plataforma: "GV Avanzado",
    Tipo_de_Ingreso: "Telemarketing",
    Tipo_de_Cliente: "SMB",
    Tipo_de_Implementaci_n: "Standard",
    Servicios_a_Impementar: ["Asistencia"],
    Pa_s: "Chile",
    Territorio_Cliente: "Chile",
    Es_un_ingreso_nuevo: "Sí",
    Se_debe_realizar_capacitaci_n: "Sí",
    // El alta por chat crea la empresa en la plataforma en el mismo acto, así
    // que esto ya está resuelto cuando nace la implementación.
    Se_debe_crear_empresa: "No",
    // OJO: el Owner NO se puede fijar al CREAR — un workflow del módulo lo
    // pisa y todo cae en la cuenta compartida (verificado 03-sep: IMP-11377
    // nació con Owner=Diego en el payload y quedó en productmanager@). Se
    // asigna en un PUT posterior con trigger ["blueprint"], que sí lo
    // respeta. Por eso las 8 implementaciones "de Ignacio" del mes están en
    // esa cuenta: no se las asignaron, el workflow las mandó ahí.
    Jefe_de_Proyectos: relator.nombre,
    Correo_Jefe_de_Proyectos: relator.email,
  }
  // RUT_Empresa_Account NO se escribe: es derivado de la Cuenta (probado
  // 03-sep, quedó null aunque se mandara). Llega solo al asociar el Cliente.
  if (d.accountId) registro.Cliente = { id: d.accountId }
  if (d.contactId) registro.Contacto = { id: d.contactId }
  if (d.ndvId) registro.Nota_de_Venta_Asociada = { id: d.ndvId }
  if (d.usuarios && d.usuarios > 0) registro.Cantidad_de_Usuarios_a_Implementar = d.usuarios
  if (typeof d.equipos === "number") registro.Cantidad_de_equipos = d.equipos
  if (d.metodoMarcaje?.length) registro.M_doto_Marcaje = d.metodoMarcaje
  if (d.correoSolicitante) registro.Correo_solicitante = d.correoSolicitante
  if (d.ejComercialId) registro.Ej_Comercial = { id: d.ejComercialId }
  registro.Comentarios = d.comentarios || "Alta creada por Vicky (chat, sin wizard). Empresa ya creada en la plataforma."

  try {
    const token = await getZohoAccessToken()
    const r = await fetch(`${API()}/crm/v3/Implementaciones`, {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      cache: "no-store",
      // trigger con blueprint: sin él los registros quedan desenganchados de
      // la banda de etapas (regla del 21-ago, reclamo de Aleydis).
      body: JSON.stringify({ data: [registro], trigger: ["workflow", "blueprint"] }),
    })
    const body = (await r.json().catch(() => ({}))) as {
      data?: Array<{ code?: string; details?: { id?: string }; message?: string }>
    }
    const fila = body?.data?.[0]
    if (!r.ok || fila?.code !== "SUCCESS" || !fila?.details?.id) {
      console.warn(`[implementacion] no se creó: ${JSON.stringify(body).slice(0, 300)}`)
      return null
    }
    // Segundo paso: el dueño. Sin esto la tómbola no se ve en el Owner y todo
    // queda con cara de "sin asignar".
    const dueno = await fetch(`${API()}/crm/v3/Implementaciones/${fila.details.id}`, {
      method: "PUT",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        data: [{ Owner: { id: relator.zohoId } }],
        trigger: ["blueprint"],
        skip_feature_execution: [{ name: "assignment_rules" }],
      }),
    }).catch(() => null)
    if (!dueno?.ok) {
      console.warn(`[implementacion] ${fila.details.id}: no se pudo asignar a ${relator.email} — queda en la cuenta compartida`)
    }
    // El NÚMERO (IMP-xxxxx) lo genera Zoho al crear y no viene en la
    // respuesta: hay que releerlo. Lo necesita el formulario de Bookings, que
    // exige "Numero de implementacion" como campo obligatorio — sin él la
    // reserva de la capacitación se rechaza. Best-effort: si la relectura
    // falla, la implementación igual quedó creada.
    let numero = ""
    try {
      const rr = await fetch(`${API()}/crm/v3/Implementaciones/${fila.details.id}?fields=N_Implementacion`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        cache: "no-store",
      })
      if (rr.ok) {
        const jj = (await rr.json()) as { data?: Array<{ N_Implementacion?: string }> }
        numero = String(jj?.data?.[0]?.N_Implementacion || "")
      }
    } catch {
      /* sin número: el agendamiento lo pedirá por otra vía */
    }
    console.log(`[implementacion] creada ${fila.details.id}${numero ? ` (${numero})` : ""} para ${d.razonSocial} → ${relator.nombre}`)
    return {
      id: fila.details.id,
      numero: numero || undefined,
      relator: { nombre: relator.nombre, email: relator.email },
    }
  } catch (e) {
    console.warn("[implementacion] excepción:", e instanceof Error ? e.message : e)
    return null
  }
}

/**
 * Deja la capacitación agendada ESCRITA en la implementación, con la misma
 * convención que usa el auto-onboarding: `Estado_Curso_1_SMB` en
 * "Autoagendamiento" (verificado en IMP-11366 del wizard, 03-sep). Así el
 * equipo de implementación ve las capacitaciones que agenda Vicky exactamente
 * igual que las que agenda el formulario, sin aprender nada nuevo.
 *
 * Best-effort: la cita YA está tomada en Bookings y el cliente ya la tiene
 * confirmada — si el CRM falla, lo que se pierde es el reflejo, no la hora.
 */
export async function registrarCurso1Agendado(
  implementacionId: string,
  d: { desdeBookings: string; relator: string },
): Promise<boolean> {
  try {
    const token = await getZohoAccessToken()
    // "10-Sep-2026 16:00:00" → "2026-09-10T16:00:00-04:00" (hora de Chile).
    const MESES: Record<string, string> = {
      Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
      Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
    }
    const m = d.desdeBookings.match(/^(\d{2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}:\d{2}):\d{2}$/)
    const iso = m ? `${m[3]}-${MESES[m[2]] || "01"}-${m[1]}T${m[4]}:00-04:00` : null
    if (!iso) return false
    const r = await fetch(`${API()}/crm/v3/Implementaciones/${implementacionId}`, {
      method: "PUT",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        data: [
          {
            Fecha_y_Hora_Curso_1: iso,
            Relator_Curso_1: d.relator,
            Estado_Curso_1_SMB: "Autoagendamiento",
            // Zoho rechaza el ISO con milisegundos y "Z" ("2026-09-05T03:15:00.123Z"
            // → 400 INVALID_DATA). Descubierto en la prueba E2E del 05-sep: la
            // reserva en Bookings salía bien y el reflejo en la Implementación
            // moría acá. Formato aceptado: sin milisegundos y con offset.
            Fecha_hora_agendamiento_Curso_1: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
          },
        ],
        trigger: ["blueprint"],
      }),
    })
    if (!r.ok) {
      const cuerpo = await r.text().catch(() => "")
      console.warn(`[implementacion] no se pudo escribir el Curso 1 en ${implementacionId}: ${r.status} ${cuerpo.slice(0, 300)}`)
      return false
    }
    return true
  } catch (e) {
    console.warn("[implementacion] excepción escribiendo el Curso 1:", e instanceof Error ? e.message : e)
    return false
  }
}
