/**
 * FICHA SII PÚBLICA para el formulario de facturación (Lalo 10-ago).
 *
 * Único consumidor: el pop-up de facturación de la página de aceptación del
 * cotizador. Con el RUT de la cotización pide la ficha del padrón público del
 * SII y prellena SOLO los campos que el chat dejó vacíos (lo declarado en la
 * conversación siempre gana). La conversación de Vicky no participa en nada
 * de esto — regla absoluta: el SII solo prellena o no prellena el formulario.
 *
 * GET /api/vic-sii-ficha?rut=76123456-0
 * Sin auth: la nómina del SII es información pública, y solo se responde ante
 * un RUT completo y válido (dígito verificador correcto) — lo mismo que
 * cualquiera puede consultar en sii.cl.
 */

import { NextResponse } from "next/server"
import { rutValido } from "@/lib/rut"
import { fichaEmpresaSii } from "@/lib/empresas-sii"

export const dynamic = "force-dynamic"
export const maxDuration = 10

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "public, max-age=3600",
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS })
}

export async function GET(req: Request): Promise<Response> {
  const rut = (new URL(req.url).searchParams.get("rut") || "").trim().replace(/\./g, "")
  if (!rut || !rutValido(rut)) {
    return NextResponse.json({ ok: false }, { status: 400, headers: CORS })
  }
  const ficha = await fichaEmpresaSii(rut).catch(() => null)
  if (!ficha) return NextResponse.json({ ok: false }, { headers: CORS })
  return NextResponse.json(
    {
      ok: true,
      razonSocial: ficha.razonSocial || "",
      giro: ficha.giro || "",
      comuna: ficha.comuna || "",
      region: ficha.region || "",
      direccion: ficha.direccion || "",
    },
    { headers: CORS },
  )
}
