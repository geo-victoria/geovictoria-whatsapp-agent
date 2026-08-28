/**
 * PUENTE del WhatsApp FLOW de alta (24-ago, "vamos desde ya con validación y
 * prellenado"). Lo llama la ACCIÓN DE CÓDIGO de Botmaker que respalda el Flow
 * dinámico `alta_cuenta_v1` — Botmaker descifra el data_exchange de Meta y
 * nos pega acá con los datos planos.
 *
 * GET  ?contact=<fono>                    → PRELLENADO: lo sembrado de la
 *      venta (empresa + admin candidato), listo para pintar en el Flow.
 * POST { contact, pantalla, campos }      → VALIDACIÓN por pantalla con las
 *      MISMAS reglas del chat (rutValido, correo, etc.). Devuelve `errores`
 *      por campo (vacío = pasa). En pantalla ADMIN válida además PERSISTE el
 *      borrador completo y despierta a Vicky en el chat con el resumen para
 *      la confirmación final — el alta irreversible sigue siendo conversada.
 *
 * Auth: mismo secreto de cron (la acción de código lo lleva embebido; las
 * acciones de Botmaker son privadas).
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret, getKvValue, setKvValue, appendAssistantV3, getQuotePointer } from "@/lib/supabase-persistence-v3"
import { fichaEmpresaSii } from "@/lib/empresas-sii"
import { rutValido } from "@/lib/rut"
import { claveFase, claveBorrador } from "@/lib/onboarding/fase"
import {
  parsearBorrador,
  borradorVacio,
  aplicarDatos,
  problemas,
  borradorCompleto,
  resumenParaConfirmar,
  type Borrador,
} from "@/lib/onboarding/borrador"
import { sendBotmakerMessage } from "@/lib/botmaker-push-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 30

async function autorizado(req: Request): Promise<boolean> {
  const secreto = await getFollowupCronSecret().catch(() => "")
  const cron = (process.env.CRON_SECRET || "").trim()
  const url = new URL(req.url)
  const auth = req.headers.get("authorization") || ""
  const entregado =
    req.headers.get("x-cron-secret") || (auth.startsWith("Bearer ") ? auth.slice(7) : "") || url.searchParams.get("key") || ""
  return Boolean(entregado) && (entregado === secreto || (Boolean(cron) && entregado === cron))
}

async function cargar(contact: string): Promise<Borrador> {
  const json = await getKvValue(claveBorrador(contact)).catch(() => null)
  return parsearBorrador(json) ?? borradorVacio("cl")
}

/**
 * Giro/dirección/comuna para el prellenado (Lalo 25-ago): cadena de fuentes,
 * campo por campo, primera no vacía gana:
 *   1. lo que el cliente ya tipeó en el propio Flow (kv extras);
 *   2. lo declarado en el POP-UP de facturación al aceptar/pagar — el handoff
 *      del cotizador lo deja en Autoservicio_Onboarding (Giro/Direcci_n/
 *      Comuna, con su propia cascada aceptación > cotización > cuenta);
 *   3. el padrón SII (hoy solo entrega razón social — las tablas de domicilio
 *      y giro murieron en el incidente del 10-ago; la pata queda cableada y
 *      se enciende sola cuando el padrón se reconstruya).
 * Todo best-effort con timeout corto: el prellenado jamás bota el Flow.
 */
async function extrasParaPrefill(
  contact: string,
  rutEmpresa: string,
): Promise<{ giro: string; direccion: string; comuna: string }> {
  const out = { giro: "", direccion: "", comuna: "" }
  const toma = (src: Partial<typeof out>) => {
    if (!out.giro && src.giro) out.giro = String(src.giro).trim()
    if (!out.direccion && src.direccion) out.direccion = String(src.direccion).trim()
    if (!out.comuna && src.comuna) out.comuna = String(src.comuna).trim()
  }
  // 1. Lo tipeado antes en el Flow.
  try {
    const kv = await getKvValue(`onboarding_flow_extras_${contact}`)
    if (kv) toma(JSON.parse(kv) as Partial<typeof out>)
  } catch {}
  // 2. El pop-up de facturación, vía el registro de Autoservicio_Onboarding
  //    colgado de la cotización más reciente del contacto.
  if (!out.giro || !out.direccion || !out.comuna) {
    try {
      const puntero = await getQuotePointer(contact)
      if (puntero?.quoteId) {
        const { getZohoAccessToken } = await import("@/lib/zoho-token")
        const token = await getZohoAccessToken()
        const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").replace(/\/$/, "")
        const modulo = (process.env.ZOHO_ONBOARDING_MODULE || "Autoservicio_Onboarding").trim()
        const r = await fetch(
          `${api}/crm/v3/${modulo}/search?criteria=(Cotizacion_Asociada:equals:${puntero.quoteId})&fields=Giro,Direcci_n,Comuna`,
          { headers: { Authorization: `Zoho-oauthtoken ${token}` }, cache: "no-store", signal: AbortSignal.timeout(6000) },
        )
        if (r.status === 200) {
          const data = (await r.json().catch(() => null)) as {
            data?: Array<{ Giro?: string; Direcci_n?: string; Comuna?: string }>
          } | null
          const fila = data?.data?.[0]
          if (fila) toma({ giro: fila.Giro || "", direccion: fila.Direcci_n || "", comuna: fila.Comuna || "" })
        }
      }
    } catch {}
  }
  // 3. Padrón SII por el RUT de la empresa.
  if ((!out.giro || !out.direccion || !out.comuna) && rutEmpresa && rutValido(rutEmpresa)) {
    try {
      const ficha = await fichaEmpresaSii(rutEmpresa)
      if (ficha) toma({ giro: ficha.giro || "", direccion: ficha.direccion || "", comuna: ficha.comuna || "" })
    } catch {}
  }
  // Giro sin fuente → "Otro" (Lalo 25-ago: "no debe ser un stopper; si no lo
  // tenemos, no lo pidamos o un giro Otro"). Dirección/comuna no se inventan:
  // van vacías y el Flow las tiene como opcionales.
  if (!out.giro) out.giro = "Otro"
  return out
}

/**
 * PERSONA NATURAL (Lalo 27-ago, misma regla del cotizador): RUT chileno con
 * parte numérica bajo 50.000.000 = persona, no empresa. A la boleta no le
 * aplican giro/dirección/comuna — el giro viaja "Persona Natural" (la misma
 * convención de quote-acceptance) y el Flow recibe el flag para ocultar los
 * campos que no necesita llenar (visibilidad condicional en el JSON del Flow).
 */
function esPersonaNaturalCl(rut: string): boolean {
  const limpio = String(rut || "").replace(/[^0-9kK]/g, "")
  if (limpio.length < 7) return false
  const num = parseInt(limpio.slice(0, -1), 10)
  return Number.isFinite(num) && num > 0 && num < 50_000_000
}

/** GET — prellenado para pintar el Flow. Claves = nombres de campos del Flow. */
export async function GET(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const contact = (new URL(req.url).searchParams.get("contact") || "").replace(/\D/g, "")
  // Sin contacto (chat frío: la Code Action no logró resolver el teléfono —
  // caso Diego 25-ago) el Flow igual debe abrir: prefill vacío, nunca 400.
  const b = await cargar(contact || "sin-contacto")
  const extras = await extrasParaPrefill(contact, b.empresa.identificador || "")
  // Persona natural: giro "Persona Natural" (si ninguna fuente dio uno mejor)
  // y flags para que el Flow oculte giro/dirección/comuna — no aplican a la
  // boleta. `mostrar_campos_empresa` va en positivo para bindear `visible`
  // directo en el JSON del Flow sin negaciones.
  const natural = b.pais === "cl" && esPersonaNaturalCl(b.empresa.identificador || "")
  if (natural && (!extras.giro || extras.giro === "Otro")) extras.giro = "Persona Natural"
  return NextResponse.json({
    ok: true,
    prefill: {
      es_persona_natural: natural,
      mostrar_campos_empresa: !natural,
      razon_social: b.empresa.nombre || "",
      rut_empresa: b.empresa.identificador || "",
      giro: extras.giro,
      direccion: extras.direccion,
      comuna: extras.comuna,
      admin_nombre: b.admin.nombre || "",
      admin_apellido: b.admin.apellido || "",
      // Persona natural sin RUT de admin: es LA MISMA persona — su RUT
      // personal ya vino como identificador (Lalo 28-ago, "por qué no se
      // prellenó"). No se pide dos veces; editable igual en el Flow.
      admin_rut: b.admin.identificador || (natural ? b.empresa.identificador || "" : ""),
      admin_email: b.admin.email || "",
    },
  })
}

type CamposFlow = {
  razon_social?: string
  rut_empresa?: string
  giro?: string
  direccion?: string
  comuna?: string
  admin_nombre?: string
  admin_apellido?: string
  admin_rut?: string
  admin_email?: string
  /** Identificación de RESPALDO (27-ago): cuando Botmaker no resuelve el
   * teléfono (chat frío / sesión vencida), el Flow muestra un campo y el
   * cliente lo escribe. Viaja en los campos y acá se vuelve el contact. */
  telefono_wsp?: string
}

/** POST — valida la pantalla; en ADMIN válida persiste y despierta a Vicky. */
export async function POST(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const body = (await req.json().catch(() => ({}))) as { contact?: string; pantalla?: string; campos?: CamposFlow }
  const pantalla = String(body.pantalla || "").toUpperCase()
  const campos = body.campos || {}
  // Identificación de respaldo: sin contact de Botmaker, vale el teléfono que
  // el cliente escribió en el Flow (campo telefono_wsp, visible solo cuando
  // el INIT no lo identificó). Solo dígitos, largo de fono real.
  let contact = String(body.contact || "").replace(/\D/g, "")
  if (!contact) {
    const tipeado = String(campos.telefono_wsp || "").replace(/\D/g, "")
    if (tipeado.length >= 10 && tipeado.length <= 15) contact = tipeado
  }
  if (!pantalla) return NextResponse.json({ ok: false, error: "falta pantalla" }, { status: 400 })
  // CHAT FRÍO (caso Diego 25-ago): la Code Action puede no resolver el
  // teléfono en chats nacidos de la plantilla, sin mensaje entrante previo.
  // Antes esto era 400 → la Code Action pintaba "⚠️ " mudo. Ahora: se validan
  // igual los campos (la validación no necesita identidad) para devolver
  // errores legibles; y si los campos están BIEN, se responde inválido con
  // instrucción clara — sin contacto no hay dónde persistir el avance.
  const sinContacto = !contact

  // Aplicar SOLO los campos de la pantalla al borrador en memoria y validar
  // con las reglas del cerebro. giro/direccion/comuna no viven en el borrador
  // (el alta no los exige) — se validan livianos y se guardan aparte.
  const previo = await cargar(contact)
  const datos =
    pantalla === "EMPRESA"
      ? { empresa: { nombre: campos.razon_social, identificador: campos.rut_empresa } }
      : {
          admin: {
            nombre: campos.admin_nombre,
            apellido: campos.admin_apellido,
            identificador: campos.admin_rut,
            email: campos.admin_email,
          },
        }
  const actualizado = aplicarDatos(previo, datos)
  const errores: Record<string, string> = {}
  for (const p of problemas(actualizado)) {
    if (p.detalle === "falta") continue
    // campo del cerebro → nombre del campo en el Flow
    const mapa: Record<string, string> = {
      "empresa.nombre": "razon_social",
      "empresa.identificador": "rut_empresa",
      "admin.nombre": "admin_nombre",
      "admin.apellido": "admin_apellido",
      "admin.identificador": "admin_rut",
      "admin.email": "admin_email",
    }
    const campoFlow = mapa[p.campo]
    // Solo errores de la pantalla que se está validando.
    if (!campoFlow) continue
    if (pantalla === "EMPRESA" && !campoFlow.startsWith("admin_") ) errores[campoFlow] = mensajeError(p.campo)
    if (pantalla === "ADMIN" && campoFlow.startsWith("admin_")) errores[campoFlow] = mensajeError(p.campo)
  }

  if (Object.keys(errores).length > 0) {
    return NextResponse.json({ ok: true, valido: false, errores })
  }

  // Campos OK pero sin identidad: no hay dónde guardar el avance ni chat que
  // despertar. Instrucción accionable en vez del ⚠️ mudo.
  if (sinContacto) {
    return NextResponse.json({
      ok: true,
      valido: false,
      errores: { _general: 'No pudimos identificar tu WhatsApp. Escríbele un mensaje a Vicky en este chat (un "hola" basta) y vuelve a tocar el botón.' },
    })
  }

  // Pantalla válida → persistir el avance.
  await setKvValue(claveBorrador(contact), JSON.stringify(actualizado)).catch(() => {})
  if (pantalla === "EMPRESA") {
    // giro/dirección/comuna: para la planilla/registro, no para el alta.
    const extras = { giro: campos.giro || "", direccion: campos.direccion || "", comuna: campos.comuna || "" }
    await setKvValue(`onboarding_flow_extras_${contact}`, JSON.stringify(extras)).catch(() => {})
    return NextResponse.json({ ok: true, valido: true })
  }

  // ADMIN válida = formulario COMPLETO → Vicky retoma en el chat con el
  // resumen y pide la confirmación (el sí explícito sigue siendo requisito
  // del alta — confirmar_alta_empresa, paso irreversible).
  let mensaje = ""
  if (borradorCompleto(actualizado)) {
    await setKvValue(claveFase(contact), "onboarding").catch(() => {})
    mensaje =
      `Recibí tu formulario, gracias! 🙌\n\n${resumenParaConfirmar(actualizado)}`
    const enviado = await sendBotmakerMessage(contact, mensaje).catch(() => false)
    if (enviado) await appendAssistantV3(contact, mensaje, "cl").catch(() => {})
    else {
      // Chat frío (ej. designado que nunca nos escribió): el texto libre muere
      // y Vicky no puede retomar — que un humano lo tome, jamás se pierde.
      try {
        const { avisarEquipoInterno } = await import("@/lib/alerta-interna")
        await avisarEquipoInterno(
          `📝 Formulario de ALTA completado por +${contact} pero no pude retomarle el chat (posible chat frío/fuera de ventana). ` +
            `Datos guardados en su borrador — contactarlo para la confirmación final del alta.`,
        )
      } catch {}
    }
  }
  return NextResponse.json({ ok: true, valido: true, completo: borradorCompleto(actualizado), resumenEnviado: Boolean(mensaje) })
}

function mensajeError(campo: string): string {
  switch (campo) {
    case "empresa.identificador":
      return "RUT inválido — revisa el dígito verificador"
    case "admin.identificador":
      return "RUT inválido — revisa el dígito verificador"
    case "admin.email":
      return "Correo inválido — revísalo"
    default:
      return "Dato inválido — revísalo"
  }
}
