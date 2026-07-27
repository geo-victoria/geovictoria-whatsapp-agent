/**
 * GET /api/vic-prompt-doc?key=<VIC_FUNNEL_KEY>
 *
 * Página HTML con el prompt de Vicky TAL CUAL está desplegado — para que el
 * equipo comercial revise cómo vende y proponga mejoras. Se renderiza en vivo
 * desde el módulo del prompt en cada visita: siempre muestra la última versión
 * (misma clave que el dashboard del embudo).
 */

import { NextResponse } from "next/server"
import { SYSTEM_PROMPT_V3 } from "@/app/api/vic-sales-agent-v3/prompt"

export const dynamic = "force-dynamic"

const FUNNEL_KEY = (process.env.VIC_FUNNEL_KEY || "").trim()

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

const RESUMEN = `
<h2>Qué es esta página</h2>
<p>Vicky es la vendedora virtual de GeoVictoria por WhatsApp. Todo su comportamiento
comercial está definido en el "prompt" de abajo: un manual de instrucciones que ella
lee completo antes de responder cada mensaje. <b>Esta página se genera en vivo desde
el sistema en producción — lo que lees es exactamente lo que rige a Vicky ahora mismo.</b></p>
<p>Objetivo comercial vigente (Rodrigo, jul-2026): subir la tasa de cierre end-to-end
hacia el 30%, aceptando sacrificar ticket promedio si es necesario.</p>
<h2>El método en 10 puntos</h2>
<ol>
<li><b>El cliente lleva la conversación</b>: Vicky responde a la intención declarada, nunca empuja.</li>
<li><b>Su cancha: 1 a 50 trabajadores</b>; sobre 50 captura el lead y deriva a ejecutivo.</li>
<li><b>"Menos es más"</b>: nombre y empresa se captan temprano conversando; al cierre solo pide RUT + email. Comuna y rubro no se preguntan nunca.</li>
<li><b>El precio lo calcula siempre el sistema</b>: Vicky no puede inventar montos, porcentajes ni regalar nada.</li>
<li><b>Transparencia de costo</b>: deja claro qué marcajes son gratis (app, web, call, cuadrilla) y cuál tiene costo (reloj). Equipos ≤10 con reloj ven ambos valores.</li>
<li><b>Micro-cierre</b>: tras mostrar precio valida interés antes de pedir datos.</li>
<li><b>Negociación por escalones del servidor</b>: ante objeción con reloj, primero la alternativa gratis; después la escalera de descuento, tramo a tramo.</li>
<li><b>La cotización se emite siempre que hay interés real</b>; si faltan datos, el lead queda registrado para Eddyluz Mujica (relevo 27-jul; los deals anteriores siguen con Anderson).</li>
<li><b>Traspaso con nombre</b>: el pago cierra presentando al DUEÑO real del deal (Eddyluz en las cotizaciones nuevas; Anderson en las anteriores al 27-jul).</li>
<li><b>Respeto absoluto al no</b>: opt-out inmediato; pérdida declarada = una retención y cierre elegante.</li>
</ol>
<p><b>Lo que NO está en este manual</b> (vive en el motor, no en el prompt): las escaleras
exactas de descuento y sus plazos; el seguimiento automático (2 toques en 24h) y la
reactivación con oferta (47h / 7 días / 15 días); la cadencia de prospección para leads
del formulario web; y las salvaguardas técnicas (anti-duplicados, exclusión de números
internos, etc.).</p>
<p><b>Cómo proponer mejoras</b>: cualquier cambio de texto cambia el comportamiento de
Vicky en minutos. Anota la sección y qué cambiarías, y canalízalo con Eduardo — los
cambios se prueban en un simulador antes de salir a clientes.</p>
<h2>Nota sobre los bloques dinámicos</h2>
<p>Antes de este texto, el sistema inyecta en cada conversación la fecha/hora actual de
Chile, el teléfono del cliente y —si existe— su cotización previa para retomarla. El
catálogo con precios que aparece más abajo también se genera desde la lista oficial.</p>
`

export async function GET(req: Request): Promise<Response> {
  const key = (new URL(req.url).searchParams.get("key") || "").trim()
  if (!FUNNEL_KEY || key !== FUNNEL_KEY) {
    return new NextResponse("<h1>No autorizado</h1><p>Falta o es incorrecto el parámetro <code>?key=</code>.</p>", {
      status: 401,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })
  }
  const generado = new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" })
  const html = `<!DOCTYPE html><html lang="es"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex, nofollow"/>
<title>Cómo vende Vicky — prompt en vivo</title>
<style>
  body{font-family:Segoe UI,Arial,sans-serif;color:#2d3748;max-width:900px;margin:0 auto;padding:24px;line-height:1.55;background:#f7fafc;}
  h1{color:#0d47a1;margin-bottom:4px;} h2{color:#0d47a1;margin-top:28px;}
  .meta{color:#718096;font-size:13px;margin-bottom:18px;}
  .resumen{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:8px 22px 18px;}
  pre{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:22px;white-space:pre-wrap;word-wrap:break-word;font-family:Segoe UI,Arial,sans-serif;font-size:14.5px;line-height:1.5;}
  .aviso{background:#fefcbf;border:1px solid #f6e05e;border-radius:8px;padding:10px 14px;font-size:13px;margin:16px 0;}
</style></head><body>
<h1>Cómo vende Vicky</h1>
<div class="meta">Prompt en producción, renderizado en vivo · generado el ${esc(generado)} (Chile) · documento interno — no compartir fuera de GeoVictoria</div>
<div class="resumen">${RESUMEN}</div>
<h2>El prompt completo (textual, versión vigente)</h2>
<div class="aviso">⚠️ Incluye información comercial interna (tarifas por tramo, escalones). Uso interno.</div>
<pre>${esc(SYSTEM_PROMPT_V3)}</pre>
</body></html>`
  return new NextResponse(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })
}
