/**
 * Ruteo por país a partir del número del contacto.
 *
 * POR QUÉ EXISTE (26-jul): el Master Bot de Botmaker rutea por ID DEL CANAL —
 * la línea a la que el cliente escribió—, no por el prefijo de su número. Eso
 * es lo correcto para RESPONDER (se contesta por la línea donde escribió), pero
 * significa que cualquier número puede aterrizar en cualquier webhook:
 *
 *   - un +57 que escribe a la línea chilena → bot "Vicky Chile" → webhook CL
 *   - un +56 que escribe a la línea colombiana → bot "Vicky Colombia" → webhook CO
 *
 * El webhook CL ya reenviaba los +57 y +52 al webhook que corresponde, pero los
 * de CO y MX no tenían ruta de retorno: atendían a quien llegara. Un chileno que
 * escribiera al número colombiano recibía prompt colombiano, precios en COP y la
 * pregunta por el NIT en vez del RUT — falla silenciosa.
 *
 * La cabecera de esos webhooks decía "imposible cruzar países por config", y era
 * cierto cuando solo existía la línea chilena. Dejó de serlo al abrir CO y MX.
 *
 * DECISIÓN DE CONTENIDO vs CANAL — son dos cosas distintas y no se mezclan:
 *   - QUÉ Vicky atiende (prompt, moneda, identificador tributario) = el PREFIJO
 *     del número del cliente. Es esto.
 *   - POR QUÉ LÍNEA se responde = el canal de origen (`canal_origen_*` en KV).
 *     Eso lo resuelve botmaker-push-v3 y no se toca acá.
 *
 * Sin ciclos posibles: cada webhook reenvía solo los prefijos que NO son suyos,
 * y siempre al webhook que sí se queda con ese prefijo.
 */

export type PaisContacto = "cl" | "co" | "mx" | "desconocido"

/**
 * País del contacto según su prefijo internacional.
 *
 * Formatos (el contacto llega sin `+` y sin separadores):
 *   CL → 56  + 9 dígitos  = 11
 *   CO → 57  + 10 dígitos = 12
 *   MX → 521 + 10 dígitos = 13  (WhatsApp antepone el 1; a veces llega 52 pelado = 12)
 *
 * Los criterios son los MISMOS que ya usaba el webhook chileno inline, para no
 * cambiar el comportamiento probado en producción — solo se centralizan.
 */
export function paisDeContacto(contactRaw: string): PaisContacto {
  // Marcador de línea "CO."/"MX."/"CL." (25-ago, caso GRANIPACK): los
  // contactos LID de WhatsApp no tienen prefijo telefónico — el país lo dice
  // el marcador que les puso el webhook de su línea.
  const marca = /^\s*(CL|CO|MX)\./i.exec(String(contactRaw || ""))?.[1]?.toLowerCase()
  if (marca === "cl" || marca === "co" || marca === "mx") return marca
  const c = String(contactRaw || "").replace(/\D/g, "")
  if (!c) return "desconocido"
  if (c.startsWith("521") && c.length >= 13) return "mx"
  if (c.startsWith("52") && !c.startsWith("521") && c.length === 12) return "mx"
  if (c.startsWith("57") && c.length >= 12) return "co"
  if (c.startsWith("56") && c.length >= 11) return "cl"
  return "desconocido"
}

/** Webhook interno que atiende cada país. */
export const WEBHOOK_POR_PAIS: Record<"cl" | "co" | "mx", string> = {
  cl: "/api/vic-botmaker-v3",
  co: "/api/vic-botmaker-co",
  mx: "/api/vic-botmaker-mx",
}

/** Nombre de la env var con el secret de cada webhook. */
export const SECRET_ENV_POR_PAIS: Record<"cl" | "co" | "mx", string> = {
  cl: "BOTMAKER_SECRET",
  co: "BOTMAKER_SECRET_CO",
  mx: "BOTMAKER_SECRET_MX",
}

export type ReenvioResultado =
  | { reenviado: false }
  | { reenviado: true; status: number; data: unknown }
  | { reenviado: true; status: 0; data: null; fallo: true }

/**
 * Si el contacto NO pertenece al país de este webhook, reenvía el body CRUDO
 * (conserva audio, imagen y documento) al webhook que corresponde y devuelve su
 * respuesta tal cual.
 *
 * Ante un fallo del reenvío NO se atiende con el flujo local: cotizar en la
 * moneda equivocada y pedir el identificador tributario de otro país es peor
 * que un reintento del cliente. Se devuelve `fallo: true` para que el llamador
 * corte con reply vacío.
 */
export async function reenviarSiNoEsDeEstePais(params: {
  contact: string
  paisLocal: "cl" | "co" | "mx"
  requestUrl: string
  body: unknown
  etiquetaLog: string
}): Promise<ReenvioResultado> {
  const { contact, paisLocal, requestUrl, body, etiquetaLog } = params
  const pais = paisDeContacto(contact)

  // Prefijo propio o país no reconocido → lo atiende este webhook.
  if (pais === paisLocal || pais === "desconocido") return { reenviado: false }

  const destino = WEBHOOK_POR_PAIS[pais]
  const secret = (process.env[SECRET_ENV_POR_PAIS[pais]] || "").trim()
  if (!secret) {
    console.error(
      `${etiquetaLog} contact=${contact} es ${pais.toUpperCase()} pero ${SECRET_ENV_POR_PAIS[pais]} no está configurado — no se puede reenviar.`,
    )
    return { reenviado: true, status: 0, data: null, fallo: true }
  }

  const origin = new URL(requestUrl).origin
  const r = await fetch(`${origin}${destino}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-secret": secret },
    body: JSON.stringify(body),
    cache: "no-store",
  }).catch(() => null)

  if (!r) {
    console.error(
      `${etiquetaLog} contact=${contact} es ${pais.toUpperCase()} y el reenvío a ${destino} falló — NO se atiende con el flujo ${paisLocal.toUpperCase()} (queda para reintento del cliente).`,
    )
    return { reenviado: true, status: 0, data: null, fallo: true }
  }

  const data = await r.json().catch(() => ({ reply: "" }))
  console.log(
    `${etiquetaLog} contact=${contact} es ${pais.toUpperCase()} → reenviado a ${destino} (${r.status})`,
  )
  return { reenviado: true, status: r.status, data }
}
