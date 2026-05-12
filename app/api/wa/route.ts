import { NextResponse } from "next/server"

const WA_NUMBER = (process.env.WHATSAPP_BUSINESS_NUMBER || "56967308227").trim()

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)

  const utm: Record<string, string> = {}

  const fields = [
    "utm_source", "utm_medium", "utm_campaign",
    "utm_content", "utm_term", "gclid", "fbclid", "landing_page",
  ]

  for (const field of fields) {
    const val = searchParams.get(field)
    if (val) utm[field] = val
  }

  // Capturar landing_page desde el referer si no viene explícito
  if (!utm.landing_page) {
    const referer = request.headers.get("referer")
    if (referer) utm.landing_page = referer.split("?")[0]
  }

  let text = "Hola"

  if (Object.keys(utm).length > 0) {
    const encoded = Buffer.from(JSON.stringify(utm)).toString("base64")
    text = `Hola [REF:${encoded}]`
  }

  const waUrl = `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(text)}`

  return NextResponse.redirect(waUrl, { status: 302 })
}
