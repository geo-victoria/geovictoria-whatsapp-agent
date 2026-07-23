/**
 * Verificación de que una llamada disparada al flujo de Dapta REALMENTE se
 * creó (caso Alejandro, 21-jul): el webhook del flujo responde 200 hasta con
 * payload basura, así que "el flujo aceptó" NO significa "el teléfono sonó".
 * El agente CO no tenía número de voz asignado y las llamadas se perdían en
 * silencio con el cron reportando "disparada".
 *
 * Consulta la API MCP de Dapta (JSON-RPC, x-api-key en vic_kv.dapta_pat) por
 * las llamadas del número destino y confirma si existe una creada después del
 * momento del disparo. Best-effort: sin PAT configurado, devuelve "unknown".
 */

import { getKvValue } from "./supabase-persistence-v3"

const MCP_URL = "https://mcp.dapta.ai/mcp"

export type VerificacionLlamada = "confirmada" | "no_encontrada" | "unknown"

export async function llamadaExisteEnDapta(
  phone: string,
  desdeIso: string,
): Promise<VerificacionLlamada> {
  const pat = ((await getKvValue("dapta_pat").catch(() => "")) || "").trim()
  if (!pat) return "unknown"
  try {
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        "x-api-key": pat,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "search_calls_by_phone",
          arguments: { phone_number: phone.replace(/^\+/, "") },
        },
      }),
      cache: "no-store",
    })
    const raw = await res.text()
    // La respuesta viene como SSE o JSON directo. OJO: los frames SSE pueden
    // traer "event: message" ANTES de la línea "data:" (cambio de Dapta,
    // 23-jul) — se detecta por contenido, no solo por el inicio del texto.
    const jsonLine = raw.includes("data:")
      ? raw
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("")
      : raw
    const parsed = JSON.parse(jsonLine) as {
      result?: { content?: Array<{ type?: string; text?: string }> }
    }
    const text = (parsed?.result?.content || []).find((c) => c.type === "text")?.text || "{}"
    const data = JSON.parse(text) as {
      calls?: Array<{ created_at?: string }>
    }
    const desde = Date.parse(desdeIso) - 5 * 60 * 1000
    const hay = (data.calls || []).some((c) => {
      const t = Date.parse(String(c.created_at || ""))
      return Number.isFinite(t) && t >= desde
    })
    return hay ? "confirmada" : "no_encontrada"
  } catch (e) {
    console.error("[dapta-verify] consulta falló:", e)
    return "unknown"
  }
}
