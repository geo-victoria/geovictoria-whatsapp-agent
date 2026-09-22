/**
 * VIGÍA DE PARIDAD DE PROMPTS — que la brecha con Chile no vuelva a aparecer
 * en silencio (Lalo 21-sep: "que esa brecha no aparezca nunca más" · "no es la
 * idea estar encima de todos los países").
 *
 * El test de tests/paridad-prompt.test.ts es el candado del desarrollo: frena
 * un cambio que deje un país atrás. Este cron es el candado de la OPERACIÓN:
 * mide el prompt REAL que ve el cliente (no el archivo fuente) y avisa cuando
 * aparece una brecha no declarada. Dos razones para medir el prompt armado:
 * los bloques que se inyectan por país (umbral, directivas) cambian el texto
 * final, y así el vigía no depende de que alguien corra la suite.
 *
 * GET ?key=<cron> → JSON con la paridad por país.
 *     &avisar=1   → además manda aviso interno si hay brechas NO declaradas.
 * Despachado por JOBS_HUERFANOS una vez al día.
 */

import { NextResponse } from "next/server"
import { REGLAS_UNIVERSALES, PAISES_PROMPT, brechasDe, reglasExigidas, type PaisPrompt } from "@/lib/paridad-prompt"
import { avisarEquipoInterno } from "@/lib/alerta-interna"
import { getKvValue, setKvValue, getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const maxDuration = 60

async function autorizado(req: Request): Promise<boolean> {
  const url = new URL(req.url)
  const key = (url.searchParams.get("key") || req.headers.get("x-cron-secret") || "").trim()
  if (!key) return false
  const env = (process.env.CRON_SECRET || process.env.FOLLOWUP_CRON_SECRET || "").trim()
  if (env && key === env) return true
  const kv = (await getFollowupCronSecret().catch(() => "")) || ""
  return Boolean(kv) && key === kv
}

/** Contacto de ejemplo por país: el prompt se arma igual que en una conversación real. */
const EJEMPLO: Record<PaisPrompt, string> = {
  cl: "56900000000",
  co: "573000000000",
  mx: "5215500000000",
  pe: "51900000000",
}

/** El país corre sobre el NÚCLEO (kv prompt_nucleo_<pais>="on" o env VICKY_PROMPT_NUCLEO_<CC>): la medición es sobre lo que ve el cliente. */
async function sobreNucleo(pais: PaisPrompt): Promise<boolean> {
  const env = (process.env[`VICKY_PROMPT_NUCLEO_${pais.toUpperCase()}`] || "").trim().toLowerCase()
  if (env === "on" || env === "1") return true
  if (env === "off" || env === "0") return false
  const kv = ((await getKvValue(`prompt_nucleo_${pais}`).catch(() => null)) || "").trim().toLowerCase()
  return kv === "on" || kv === "1"
}

async function promptDe(pais: PaisPrompt): Promise<string> {
  const c = EJEMPLO[pais]
  if (pais === "cl") return (await import("@/app/api/vic-sales-agent-v3/prompt")).getSystemPromptV3(c, 20)
  if (pais === "co") {
    if (await sobreNucleo("co")) return (await import("@/lib/paises/co/prompt-nucleo")).getSystemPromptCONucleo(c, 20)
    return (await import("@/lib/paises/co/prompt")).getSystemPromptCO(c, 20)
  }
  if (pais === "mx") return (await import("@/lib/paises/mx/prompt")).getSystemPromptMX(c, 20)
  if (await sobreNucleo("pe")) return (await import("@/lib/paises/pe/prompt-nucleo")).getSystemPromptPENucleo(c, 20)
  return (await import("@/lib/paises/pe/prompt")).getSystemPromptPE(c, 20)
}

export async function GET(req: Request) {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  // TEXTO RENDERIZADO (21-sep, partición del prompt en núcleo + ficha): la
  // prueba de identidad de Chile compara el núcleo armado contra el prompt
  // REAL de producción, carácter por carácter. Este modo entrega esa verdad
  // (base = SYSTEM_PROMPT_V3 con el catálogo ya interpolado; catalogo = el
  // bloque generado; base20 = con el umbral 20 aplicado) para congelarla
  // como fixture del test. Solo lectura, solo admin.
  if (new URL(req.url).searchParams.get("texto") === "1") {
    const mod = await import("@/app/api/vic-sales-agent-v3/prompt")
    return NextResponse.json({
      ok: true,
      pais: "cl",
      base: mod.SYSTEM_PROMPT_V3,
      catalogo: mod.formatCatalogoParaPrompt(),
      base20: mod.getSystemPromptV3("56900000000", 20),
    })
  }
  const url = new URL(req.url)
  const avisar = url.searchParams.get("avisar") === "1"

  const porPais: Record<string, unknown> = {}
  const nuevasTotales: Array<{ pais: string; id: string; regla: string }> = []
  const fallos: string[] = []

  for (const pais of PAISES_PROMPT) {
    try {
      const texto = await promptDe(pais)
      const todas = brechasDe(pais, texto)
      const nuevas = todas.filter((b) => !b.declarada)
      const exigidas = reglasExigidas(pais).length
      porPais[pais] = {
        cumple: exigidas - todas.length,
        de: exigidas,
        brechasNuevas: nuevas.map((b) => b.id),
        deudaDeclarada: todas.filter((b) => b.declarada).map((b) => b.id),
      }
      for (const b of nuevas) nuevasTotales.push({ pais, id: b.id, regla: b.regla })
    } catch (e) {
      // Un prompt que no se puede armar es peor que una brecha: se avisa igual
      // y NUNCA se reporta como "sin brechas" (la regla del 13-sep: la
      // ausencia de datos no es un hallazgo negativo).
      fallos.push(`${pais}: ${e instanceof Error ? e.message : String(e)}`)
      porPais[pais] = { error: "no se pudo armar el prompt" }
    }
  }

  const hayProblema = nuevasTotales.length > 0 || fallos.length > 0
  if (avisar && hayProblema) {
    const hoy = new Date().toISOString().slice(0, 10)
    const candado = `paridad_aviso_${hoy}`
    const yaAvisado = await getKvValue(candado).catch(() => null)
    if (!yaAvisado) {
      const lineas = [
        "PARIDAD DE PROMPTS — apareció una brecha nueva con Chile",
        "",
        ...nuevasTotales.map((b) => `· ${b.pais.toUpperCase()}: ${b.id} — ${b.regla}`),
        ...(fallos.length ? ["", "Prompts que no se pudieron armar:", ...fallos.map((f) => `· ${f}`)] : []),
        "",
        "Qué hacer: llevar la regla al prompt del país, o declarar la excepción con su motivo en DEUDA_DECLARADA (lib/paridad-prompt.ts). Una regla de venta nueva vale en los cuatro países salvo que haya una razón local escrita.",
      ]
      await avisarEquipoInterno(lineas.join("\n")).catch(() => {})
      await setKvValue(candado, "1").catch(() => {})
    }
  }

  return NextResponse.json({
    ok: !hayProblema,
    reglasGlobales: REGLAS_UNIVERSALES.length,
    porPais,
    brechasNuevas: nuevasTotales,
    fallos,
  })
}
