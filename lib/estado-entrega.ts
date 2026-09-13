/**
 * HISTÓRICO DE ESTADOS DE ENTREGA DE META (13-sep).
 *
 * `vic-botmaker-status` ya recibía los estados y REACCIONABA a los dos códigos
 * conocidos (131049 cap de frecuencia de plantillas MARKETING por receptor,
 * 131026 número sin WhatsApp), pero solo dejaba el ÚLTIMO payload en
 * `debug_last_status_payload`. Sin histórico no se puede responder la pregunta
 * de Lalo: **qué plantillas fallan, con qué código y con qué frecuencia**.
 *
 * Cada fallo queda en vic_kv `estado_fallido_<ts>_<contacto>` (30 d). El
 * nombre de la plantilla NO viaja en el payload de estado —solo `messageId`—
 * así que se resuelve después cruzando contra la API de mensajes de Botmaker,
 * que sí trae `content.whatsAppTemplateName`. Esa API solo alcanza ~72 h
 * atrás, de modo que la resolución tiene que correr pronto.
 */

import { setKvValue } from "./supabase-persistence-v3"

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

export type EstadoFallido = {
  at: string
  contacto: string
  linea?: string
  status?: string
  /** Código de Meta (131049, 131026, …) si viene en el payload. */
  codigo?: string
  razon?: string
  messageId?: string
  /** Se rellena después cruzando messageId contra la API de mensajes. */
  tpl?: string
}

/** Todos los códigos de Meta que aparezcan en el payload, en orden. */
export function codigosDeMeta(body: unknown): string[] {
  const txt = JSON.stringify(body ?? {})
  const out: string[] = []
  for (const m of txt.matchAll(/\b(1\d{5})(?:\.0)?\b/g)) if (!out.includes(m[1])) out.push(m[1])
  return out
}

/** Glosa de los códigos que ya nos han mordido. El resto se reporta crudo. */
export function glosaCodigo(codigo: string): string {
  const mapa: Record<string, string> = {
    "131049": "Meta frenó el envío por su cap de frecuencia de plantillas MARKETING por receptor",
    "131026": "el número no puede recibir WhatsApp (no tiene cuenta o está bloqueado)",
    "131047": "ventana de 24 h vencida: fuera de sesión solo entra una plantilla",
    "131split": "",
    "132000": "la plantilla no calza con el número de variables enviadas",
    "132001": "la plantilla no existe o no está aprobada para esa línea",
    "132015": "la plantilla está PAUSADA por baja calidad (cuarentena de Meta)",
    "132016": "la plantilla está DESHABILITADA por calidad",
    "133010": "la línea no está registrada",
    "130429": "límite de velocidad de la línea",
  }
  return mapa[codigo] || ""
}

export async function registrarEstadoFallido(e: EstadoFallido): Promise<void> {
  const ts = Date.now()
  // setKvValue no acepta expiración acá; la ventana la aplica la lectura.
  await setKvValue(`estado_fallido_${ts}_${e.contacto}`, JSON.stringify(e)).catch(() => {})
}

export async function leerEstadosFallidos(dias = 7): Promise<EstadoFallido[]> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return []
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_kv?key=like.estado_fallido_*&select=key,value&limit=2000`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store" },
  ).catch(() => null)
  if (!r || !r.ok) return []
  const filas = ((await r.json().catch(() => [])) as Array<{ key: string; value: string }>) || []
  const corte = Date.now() - dias * 86_400_000
  const out: EstadoFallido[] = []
  for (const f of filas) {
    try {
      const e = JSON.parse(f.value) as EstadoFallido
      if (Date.parse(e.at || "") >= corte) out.push(e)
    } catch { /* fila ilegible */ }
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)))
}
