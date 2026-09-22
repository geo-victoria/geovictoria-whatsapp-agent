/**
 * BARRIDO DE BOTONES DE CAMPAÑA (26-ago, prueba en vivo con Lalo).
 *
 * Los QUICK_REPLY de una plantilla llegan a Botmaker como mensaje del usuario
 * con texto JSON `{"button":"Quiero el descuento","templateName":""}` pero NO
 * pasan por la acción de código del bot, así que el webhook jamás los ve
 * (toque de las 16:16Z registrado en el feed de Botmaker y CERO POST en
 * nuestro endpoint). Este barrido corre en el latido de 2 minutos
 * (vic-callback-cron): lee el feed /v2.0/messages de la última hora, caza los
 * botones de campaña y los procesa con el MISMO handler determinista del
 * webhook. Dedupe por id de mensaje en vic_kv — la ventana ancha con solape es
 * inocua y no necesita marca de agua.
 */

import { getKvValue, setKvValue, appendTurnV3 } from "./supabase-persistence-v3"
import { procesarRespuestaCampana } from "./campana-descuento"

const BM_TOKEN = (process.env.BOTMAKER_ACCESS_TOKEN || "").trim()
const VENTANA_MIN = 60
const MAX_PAGINAS = 4

type BmItem = {
  id?: string
  creationTime?: string
  from?: string
  content?: { type?: string; text?: string }
  chat?: { contactId?: string }
}

/** Extrae el texto del botón si el mensaje ES un toque de botón de plantilla. */
export function botonDeMensaje(texto: string): string | null {
  const t = String(texto || "").trim()
  if (!t.startsWith("{")) return null
  try {
    const j = JSON.parse(t) as { button?: unknown }
    if (j && typeof j.button === "string" && j.button.trim()) return j.button.trim()
  } catch {
    /* no era JSON */
  }
  return null
}

function paisDePrefijo(fono: string): string {
  if (fono.startsWith("57")) return "co"
  if (fono.startsWith("52")) return "mx"
  if (fono.startsWith("51")) return "pe"
  return "cl"
}

export async function barrerBotonesCampana(): Promise<{ vistos: number; procesados: number }> {
  if (!BM_TOKEN) return { vistos: 0, procesados: 0 }

  const desde = new Date(Date.now() - VENTANA_MIN * 60_000).toISOString()
  let url = `https://api.botmaker.com/v2.0/messages?limit=250&from=${encodeURIComponent(desde)}`
  let vistos = 0
  let procesados = 0

  for (let pagina = 0; pagina < MAX_PAGINAS && url; pagina++) {
    const r = await fetch(url, {
      headers: { "access-token": BM_TOKEN, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    }).catch(() => null)
    if (!r || !r.ok) break
    const d = (await r.json().catch(() => ({}))) as { items?: BmItem[]; nextPage?: string }
    const items = Array.isArray(d.items) ? d.items : []

    for (const it of items) {
      if (String(it.from || "").toLowerCase() !== "user") continue
      const boton = botonDeMensaje(it.content?.text || "")
      if (!boton) continue
      vistos++

      const contact = String(it.chat?.contactId || "").replace(/\D/g, "")
      const msgId = String(it.id || "").trim()
      if (!contact || !msgId) continue

      // Dedupe por id de mensaje: la marca se escribe ANTES de procesar para
      // que un tick solapado no dispare el handler dos veces.
      const clave = `campana_btn_${msgId}`
      const yaVisto = await getKvValue(clave).catch(() => null)
      if (yaVisto) continue
      await setKvValue(clave, new Date().toISOString()).catch(() => {})

      try {
        const res = await procesarRespuestaCampana(contact, boton)
        if (res.atendida && res.respuesta) {
          const { sendBotmakerMessage } = await import("./botmaker-push-v3")
          await sendBotmakerMessage(contact, res.respuesta)
          await appendTurnV3(contact, boton, res.respuesta, paisDePrefijo(contact)).catch(() => {})
          procesados++
          console.log(`[campana-botones] ${contact} botón "${boton}" atendido (msg ${msgId})`)
        }
      } catch (e) {
        console.error(`[campana-botones] fallo procesando ${contact}/${msgId}:`, e instanceof Error ? e.message : e)
      }
    }

    url = typeof d.nextPage === "string" && d.nextPage ? d.nextPage : ""
  }

  return { vistos, procesados }
}
