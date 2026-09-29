/**
 * FICHA DEL PADRÓN PÚBLICO para el formulario de facturación (Lalo 10-ago;
 * multi-país 29-sep, tarea "prellenar con el padrón del país, no solo SII").
 *
 * Único consumidor: el pop-up de facturación de la página de aceptación del
 * cotizador. Con el documento tributario de la cotización pide la ficha del
 * padrón público del país y prellena SOLO los campos que el chat dejó vacíos
 * (lo declarado en la conversación siempre gana). La conversación de Vicky
 * no participa en nada de esto — regla absoluta: el padrón solo prellena o
 * no prellena el formulario.
 *
 * GET /api/vic-sii-ficha?rut=76123456-0            (Chile, SII: razón social, giro, comuna, dirección)
 * GET /api/vic-sii-ficha?pais=pe&rut=20123456781   (Perú, SUNAT: razón social, dirección, distrito)
 * GET /api/vic-sii-ficha?pais=co&rut=900123456-8   (Colombia, RUES: razón social, CIIU como giro)
 * México no tiene padrón público consultable: responde ok:false.
 *
 * Sin auth: los tres padrones son información pública, y solo se responde
 * ante un documento completo y válido (dígito verificador correcto) — lo
 * mismo que cualquiera puede consultar en sii.cl / sunat.gob.pe / rues.org.co.
 */

import { NextResponse } from "next/server"
import { rutValido, rucValido } from "@/lib/rut"
import { nitValido, normalizarNit } from "@/lib/paises/co/nit"
import { fichaEmpresaSii } from "@/lib/empresas-sii"
import { fichaRucSunat } from "@/lib/paises/pe/sunat-ruc"
import { fichaNitRues } from "@/lib/paises/co/rues-nit"

export const dynamic = "force-dynamic"
export const maxDuration = 10

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "public, max-age=3600",
}

type Ficha = { razonSocial: string; giro: string; comuna: string; region: string; direccion: string; fuente: string }

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS })
}

async function fichaPorPais(pais: string, doc: string): Promise<Ficha | null | "invalido"> {
  if (pais === "pe") {
    const ruc = doc.replace(/\D/g, "")
    if (!rucValido(ruc)) return "invalido"
    const f = await fichaRucSunat(ruc).catch(() => null)
    if (!f?.razonSocial) return null
    return {
      razonSocial: f.razonSocial,
      giro: "",
      comuna: f.distrito || "",
      region: f.departamento || "",
      direccion: f.direccion || "",
      fuente: "sunat",
    }
  }
  if (pais === "co") {
    if (!nitValido(doc)) return "invalido"
    const f = await fichaNitRues(normalizarNit(doc)).catch(() => null)
    if (!f?.razonSocial) return null
    return {
      razonSocial: f.razonSocial,
      // El RUES no trae la glosa de la actividad, solo el código CIIU; se
      // entrega como referencia para que finanzas la reconozca.
      giro: f.ciiu ? `CIIU ${f.ciiu}` : "",
      comuna: "",
      region: "",
      direccion: "",
      fuente: "rues",
    }
  }
  if (pais === "mx") return null
  const rut = doc.replace(/\./g, "")
  if (!rutValido(rut)) return "invalido"
  const f = await fichaEmpresaSii(rut).catch(() => null)
  if (!f) return null
  return {
    razonSocial: f.razonSocial || "",
    giro: f.giro || "",
    comuna: f.comuna || "",
    region: f.region || "",
    direccion: f.direccion || "",
    fuente: "sii",
  }
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const doc = (url.searchParams.get("rut") || "").trim()
  const pais = (url.searchParams.get("pais") || "cl").trim().toLowerCase()
  if (!doc) return NextResponse.json({ ok: false }, { status: 400, headers: CORS })
  const ficha = await fichaPorPais(pais, doc)
  if (ficha === "invalido") return NextResponse.json({ ok: false }, { status: 400, headers: CORS })
  if (!ficha) return NextResponse.json({ ok: false, pais }, { headers: CORS })
  return NextResponse.json({ ok: true, pais, ...ficha }, { headers: CORS })
}
