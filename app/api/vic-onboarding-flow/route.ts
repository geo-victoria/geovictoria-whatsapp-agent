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
import { getFollowupCronSecret, getKvValue, setKvValue, appendAssistantV3 } from "@/lib/supabase-persistence-v3"
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

/** GET — prellenado para pintar el Flow. Claves = nombres de campos del Flow. */
export async function GET(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const contact = (new URL(req.url).searchParams.get("contact") || "").replace(/\D/g, "")
  if (!contact) return NextResponse.json({ ok: false, error: "falta ?contact=" }, { status: 400 })
  const b = await cargar(contact)
  return NextResponse.json({
    ok: true,
    prefill: {
      razon_social: b.empresa.nombre || "",
      rut_empresa: b.empresa.identificador || "",
      admin_nombre: b.admin.nombre || "",
      admin_apellido: b.admin.apellido || "",
      admin_rut: b.admin.identificador || "",
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
}

/** POST — valida la pantalla; en ADMIN válida persiste y despierta a Vicky. */
export async function POST(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const body = (await req.json().catch(() => ({}))) as { contact?: string; pantalla?: string; campos?: CamposFlow }
  const contact = String(body.contact || "").replace(/\D/g, "")
  const pantalla = String(body.pantalla || "").toUpperCase()
  const campos = body.campos || {}
  if (!contact || !pantalla) return NextResponse.json({ ok: false, error: "faltan contact/pantalla" }, { status: 400 })

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
