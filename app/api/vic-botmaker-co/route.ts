/**
 * Webhook de la línea de WhatsApp de COLOMBIA (+57 318 107 0737).
 *
 * Ruta delgada por país (decisión de arquitectura jul-2026): la URL declara el
 * país — la acción de código de la línea CO en Botmaker apunta ACÁ, la chilena
 * sigue en /api/vic-botmaker-v3. Imposible cruzar países por configuración.
 *
 * ESTADO: MODO OBSERVACIÓN. Mientras VICKY_CO_ENABLED !== "on", el endpoint
 * autentica, registra lo que llega (log estructurado) y responde 200 SIN
 * contestarle al cliente — permite validar la configuración de Botmaker de
 * punta a punta sin que Vicky CO hable antes de tener su prompt listo.
 * Cuando se encienda, delegará en el handler compartido con el PERFIL_CO
 * (prompt ensamblado mono-país + catálogo COP).
 *
 * Auth: header x-secret == BOTMAKER_SECRET_CO (secreto propio de la línea CO,
 * independiente del chileno — rotables por separado).
 */

import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const SECRET_CO = (process.env.BOTMAKER_SECRET_CO || "").trim()
const ENABLED = (process.env.VICKY_CO_ENABLED || "off").trim().toLowerCase() === "on"

type BotmakerBody = {
  contact?: string
  message?: string
  audioUrl?: string
  audioURL?: string
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const secret = request.headers.get("x-secret") || ""
    if (!SECRET_CO) {
      // Sin secreto configurado en Vercel no aceptamos tráfico: seguro por defecto.
      return NextResponse.json(
        { ok: false, error: "BOTMAKER_SECRET_CO no configurado" },
        { status: 503 },
      )
    }
    if (secret !== SECRET_CO) {
      return NextResponse.json({ reply: "Unauthorized" }, { status: 401 })
    }

    const body = (await request.json().catch(() => ({}))) as BotmakerBody
    const contact = (body.contact || "").replace(/\D/g, "")
    const message = (body.message || "").trim()
    const audioUrl = (body.audioUrl || body.audioURL || "").trim()

    if (!ENABLED) {
      // Modo observación: queda en los logs de Vercel (ruta propia = filtro
      // trivial) y NO se responde al cliente. La conversación no se persiste
      // todavía: el primer turno real debe nacer con el prompt CO listo.
      console.log(
        `[vic-co][observacion] contact=${contact} msgLen=${message.length} audio=${audioUrl ? "sí" : "no"} texto="${message.slice(0, 120)}"`,
      )
      return NextResponse.json({ ok: true, modo: "observacion", pais: "co" })
    }

    // TODO (cableado en curso): delegar en el handler compartido con PERFIL_CO.
    console.warn(`[vic-co] ENABLED=on pero el handler CO aún no está cableado; contact=${contact}`)
    return NextResponse.json({ ok: true, modo: "en_construccion", pais: "co" })
  } catch (err) {
    console.error("[vic-co] error en webhook:", err)
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
