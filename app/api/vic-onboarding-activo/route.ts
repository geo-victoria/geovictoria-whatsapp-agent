import { NextResponse } from "next/server"
import { onboardingActivoPara } from "@/lib/onboarding-piloto"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * ¿Este contacto va por el ONBOARDING DE VICKY (alta por chat) o por el
 * wizard web? Lo pregunta el COTIZADOR al confirmar un pago con tarjeta
 * (05-sep, caso Josefa/COT1250): pago.html redirigía al cliente al
 * auto-onboarding a los 8 segundos aunque Vicky ya le estuviera mandando el
 * formulario de alta por WhatsApp — dos caminos a la vez para el mismo
 * cliente. Con esto el cotizador sabe cuál toca ANTES de generar el link.
 *
 *   GET ?contact=569XXXXXXXX   (header x-vicky-secret = VICKY_COTIZADORA_SECRET)
 *   → { ok: true, activo: boolean }
 *
 * Solo Chile: fuera de CL siempre false (CO/MX/PE siguen con wizard).
 * Fail-closed hacia el wizard: si algo falla responde activo=false, que es
 * el comportamiento de siempre.
 */
const SECRET = (process.env.VICKY_COTIZADORA_SECRET || "").trim()

export async function GET(req: Request): Promise<Response> {
  if (!SECRET || (req.headers.get("x-vicky-secret") || "").trim() !== SECRET) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  const contact = (new URL(req.url).searchParams.get("contact") || "").replace(/\D/g, "")
  if (!/^569\d{8}$/.test(contact)) return NextResponse.json({ ok: true, activo: false, motivo: "no_cl" })
  try {
    const activo = await onboardingActivoPara(contact)
    return NextResponse.json({ ok: true, activo })
  } catch (e) {
    console.warn("[onboarding-activo] falló:", e instanceof Error ? e.message : e)
    return NextResponse.json({ ok: true, activo: false, motivo: "error" })
  }
}
