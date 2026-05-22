import { NextResponse } from "next/server"

/**
 * Webhook de Meta para Vicky — DEPRECADO desde mayo 2026.
 *
 * Esta ruta ya no procesa mensajes entrantes. Todo el tráfico de WhatsApp se
 * recibe ahora a través de Botmaker (línea +56 9 6730 8227) y se procesa en
 * /api/vic-botmaker.
 *
 * Se mantiene el archivo para preservar el historial y evitar 404s en caso de
 * llamadas residuales desde Meta. Devuelve 410 Gone para que cualquier sistema
 * que aún apunte acá lo registre como recurso retirado, no como error temporal.
 *
 * El código original con la implementación completa del webhook (deduplicación,
 * extracción de leads, agendamiento, evaluación, customerProfile evolutivo,
 * markers y demás) está disponible en el historial de git previo a este commit.
 *
 * Para reactivar este canal en el futuro: revertir este archivo al commit
 * anterior y volver a apuntar la URL del webhook en Meta Business Manager.
 */

const GONE_PAYLOAD = {
  success: false,
  error: "Endpoint deprecado",
  message:
    "Este webhook ya no recibe mensajes de WhatsApp. El tráfico se procesa ahora a través de Botmaker.",
  since: "2026-05",
} as const

export async function GET() {
  return NextResponse.json(GONE_PAYLOAD, { status: 410 })
}

export async function POST() {
  return NextResponse.json(GONE_PAYLOAD, { status: 410 })
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 410, headers: { Allow: "" } })
}
