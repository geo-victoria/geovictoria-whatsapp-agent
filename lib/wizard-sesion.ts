/**
 * ADAPTADOR a la SESIÓN del wizard de auto-onboarding (F2, 25-ago).
 *
 * El riel opcional del onboarding por chat (trabajadores/turnos/
 * planificaciones) NO inventa un camino nuevo: escribe en la sesión del
 * wizard (onboarding-geovictoria) y cierra con su propio submit-to-zoho —
 * mismas planillas Excel, mismo Zoho Flow, misma Implementación aguas abajo
 * (decisión Lalo 24-ago). El vigía (vic-onboarding-vigia) ya habla este
 * contrato; acá se replica para el cierre normal del chat.
 *
 *   1. asegurarSesionWizard: token en vic_kv `onboarding_wizard_token_` o
 *      POST /api/generate-link (idempotente por id_zoho) con el prellenado
 *      de la venta. La declaración de representante viaja aceptada: el
 *      cliente confirmó el alta por chat (consentimiento conversacional).
 *   2. escribirConfiguracionWizard: PATCH /api/onboarding/{token} con los
 *      arreglos mapeados (config-mapa) — el merge del wizard acepta arreglos
 *      no vacíos en cualquier paso.
 *   3. cerrarWizard: POST /api/submit-to-zoho con el body del vigía
 *      (planillas + Flow). El candado de pendientes es responsabilidad del
 *      CALLER (confirmar_configuracion se niega antes de llegar acá).
 */

import { getKvValue, setKvValue } from "./supabase-persistence-v3"
import type { Borrador } from "./onboarding/borrador"
import type { Configuracion } from "./onboarding/configuracion"
import { wizardFormDataDesdeConfiguracion } from "./onboarding/config-mapa"

const WIZARD_URL = (process.env.VICKY_ONBOARDING_WIZARD_URL || "https://onboarding.geovictoria.com")
  .trim()
  .replace(/\/+$/, "")

const claveToken = (contact: string) => `onboarding_wizard_token_${contact}`

type ExtrasEmpresa = { giro?: string; direccion?: string; comuna?: string }

/**
 * Devuelve el token de la sesión del wizard del contacto, creándola si no
 * existe. El id_zoho ancla la idempotencia del generate-link: se usa el deal
 * si lo hay, o un id sintético estable por contacto.
 */
export async function asegurarSesionWizard(
  contact: string,
  borrador: Borrador,
  opts: { dealId?: string; extras?: ExtrasEmpresa } = {},
): Promise<{ token: string; creada: boolean } | { error: string }> {
  const guardado = await getKvValue(claveToken(contact)).catch(() => null)
  if (guardado) return { token: guardado, creada: false }

  const idZoho = (opts.dealId || "").trim() || `vicky-chat-${contact}`
  const extras = opts.extras || {}
  try {
    const res = await fetch(`${WIZARD_URL}/api/generate-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        id_zoho: idZoho,
        source_crm: "vicky_chat",
        representative_declaration_accepted: true,
        empresa: {
          razonSocial: borrador.empresa.nombre || "",
          nombreFantasia: borrador.empresa.nombre || "",
          rut: borrador.empresa.identificador || "",
          giro: extras.giro || "",
          direccion: extras.direccion || "",
          comuna: extras.comuna || "",
          emailFacturacion: borrador.admin.email || "",
          telefonoContacto: `+${contact}`,
        },
        admins: [
          {
            // OJO bug conocido del wizard (24-ago): guarda admins[].nombre
            // como nombre COMPLETO y las planillas concatenan apellido de
            // nuevo. Desde el chat se alimenta CORRECTO (nombre = solo
            // nombres) para no reproducirlo.
            nombre: borrador.admin.nombre || "",
            apellido: borrador.admin.apellido || "",
            email: borrador.admin.email || "",
            telefono: `+${contact}`,
            rut: borrador.admin.identificador || "",
          },
        ],
      }),
    })
    const data = (await res.json().catch(() => ({}))) as { success?: boolean; token?: string; link?: string; error?: string }
    const token = String(data?.token || "").trim() || (String(data?.link || "").match(/([0-9a-f-]{36})/)?.[1] ?? "")
    if (!res.ok || !token) return { error: data?.error || `generate-link ${res.status} sin token` }
    await setKvValue(claveToken(contact), token).catch(() => {})
    return { token, creada: true }
  } catch (e) {
    return { error: e instanceof Error ? e.message : "error de red creando sesión wizard" }
  }
}

/** Escribe la configuración del chat en la sesión (merge del wizard). */
export async function escribirConfiguracionWizard(
  token: string,
  cfg: Configuracion,
): Promise<{ ok: true } | { error: string }> {
  const mapa = wizardFormDataDesdeConfiguracion(cfg)
  try {
    const res = await fetch(`${WIZARD_URL}/api/onboarding/${encodeURIComponent(token)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        currentStep: 9,
        formData: {
          empresa: { grupos: mapa.empresaGrupos },
          trabajadores: mapa.trabajadores,
          turnos: mapa.turnos,
          planificaciones: mapa.planificaciones,
          asignaciones: mapa.asignaciones,
          configureNow: true,
          loadWorkersNow: true,
        },
        consentEvent: {
          subjectType: "empresa_representante",
          eventType: "privacy_notice_accepted",
          policyVersion: "v1",
          source: "vicky_chat",
          metadata: { canal: "whatsapp", agente: "vicky_onboarding" },
        },
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      return { error: `PATCH sesión ${res.status}: ${body.slice(0, 200)}` }
    }
    return { ok: true }
  } catch (e) {
    return { error: e instanceof Error ? e.message : "error de red escribiendo sesión" }
  }
}

/** Cierra la sesión: planillas + Zoho Flow (mismo body que usa el vigía). */
export async function cerrarWizard(
  token: string,
  opts: { idZoho?: string; cuentaZohoId?: string } = {},
): Promise<{ ok: true } | { error: string }> {
  try {
    // Estado real de la sesión (lo escrito por chat Y por wizard, fusionado).
    const rSes = await fetch(`${WIZARD_URL}/api/onboarding/${encodeURIComponent(token)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    })
    if (!rSes.ok) return { error: `GET sesión ${rSes.status}` }
    const ses = (await rSes.json().catch(() => ({}))) as {
      formData?: Record<string, unknown>
      navigationHistory?: unknown[]
    }
    const fd = (ses.formData || {}) as Record<string, unknown> & {
      empresa?: Record<string, unknown>
      trabajadores?: unknown[]
    }
    if (opts.cuentaZohoId && fd.empresa) fd.empresa.cuentaZohoId = opts.cuentaZohoId
    const totalTrabajadores = Array.isArray(fd.trabajadores) ? fd.trabajadores.length : 0

    const rSubmit = await fetch(`${WIZARD_URL}/api/submit-to-zoho`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        accion: "completado",
        eventType: "complete",
        fechaHoraEnvio: new Date().toISOString(),
        ...(opts.idZoho ? { id_zoho: opts.idZoho } : {}),
        onboardingId: token,
        currentStep: 11,
        navigationHistory: ses.navigationHistory || [],
        estado: "Completado",
        fecha_completado: new Date().toISOString(),
        pais: "Chile",
        totalTrabajadores,
        formData: fd,
        ...(opts.cuentaZohoId ? { cuentaZohoId: opts.cuentaZohoId } : {}),
        metadata: {
          pais: "Chile",
          ...(opts.cuentaZohoId ? { cuentaZohoId: opts.cuentaZohoId } : {}),
          empresaRut: String((fd.empresa as Record<string, unknown> | undefined)?.rut || ""),
          empresaNombre: String((fd.empresa as Record<string, unknown> | undefined)?.razonSocial || ""),
          pasoActual: 11,
          pasoNombre: "Agradecimiento",
          totalPasos: 12,
          porcentajeProgreso: 100,
          totalTrabajadores,
          decision: "Configuración completada por chat (Vicky Onboarding F2)",
        },
        excelFile: null,
      }),
    })
    if (!rSubmit.ok) {
      const body = await rSubmit.text().catch(() => "")
      return { error: `submit-to-zoho ${rSubmit.status}: ${body.slice(0, 200)}` }
    }
    return { ok: true }
  } catch (e) {
    return { error: e instanceof Error ? e.message : "error de red en el cierre" }
  }
}
