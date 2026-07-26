/**
 * Procedencia de links: qué URLs salieron REALMENTE de una tool en este turno.
 *
 * POR QUÉ (26-jul): el allowlist de dominios (`DOMINIOS_VICKY`) nació para matar
 * links inventados por el modelo — el caso Transportes Viig, donde Vicky se sacó
 * de la manga una "ficha técnica" en storage.googleapis.com. Funciona, pero
 * enumera dominios a mano, y cada dominio legítimo que falta se borra del
 * mensaje dejando "(te lo hago llegar enseguida)" sin URL. Ya pasó dos veces con
 * el link de la demo (+56997018751 el 24-jul y Pablo el 25-jul, en pleno cierre).
 *
 * La regla correcta no es "¿de qué dominio es?" sino "¿DE DÓNDE SALIÓ?":
 *
 *   Si la URL aparece textual en el resultado de una tool que se ejecutó con
 *   éxito en ESTE turno, no la inventó el modelo — la produjo nuestro backend.
 *
 * Es estrictamente más seguro que el allowlist: solo puede RESCATAR links
 * legítimos, nunca dejar pasar uno alucinado (una URL inventada, por definición,
 * no está en ningún tool_result). El allowlist se mantiene como red para los
 * links que Vicky escribe de memoria desde el prompt (dt.gob.cl, wa.me).
 *
 * Con esto, un link nuevo del backend (el acceso al onboarding, un PDF, una
 * pasarela) llega al cliente sin tener que acordarse de tocar el regex.
 */

type ToolCallLike = { ok?: boolean; output?: unknown }

const URL_RE = /https?:\/\/[^\s"'<>)\]}\\]+/gi

/** Quita la puntuación final que suele pegarse a una URL dentro de una frase. */
function normalizarUrl(u: string): string {
  return u.replace(/[.,;:!?)\]}'"]+$/, "")
}

/**
 * URLs presentes en el output de las tools que corrieron OK en este turno.
 * Se serializa el output completo a JSON: da lo mismo en qué campo venga el
 * link (acceptanceUrl, pdfUrl, onboardingUrl, o embebido en mensajeParaProspecto).
 */
export function urlsDeToolsDelTurno(toolCalls: ToolCallLike[] | undefined): Set<string> {
  const urls = new Set<string>()
  for (const call of toolCalls || []) {
    if (!call || call.ok !== true || call.output == null) continue
    let serializado = ""
    try {
      serializado = JSON.stringify(call.output)
    } catch {
      continue
    }
    for (const u of serializado.match(URL_RE) || []) {
      const limpia = normalizarUrl(u)
      if (limpia) urls.add(limpia)
    }
  }
  return urls
}

/**
 * ¿Esta URL del reply proviene de una tool de este turno?
 *
 * Compara normalizado y tolera que el modelo haya recortado o extendido la cola
 * (la URL del reply puede traer puntuación pegada, o el tool_result puede traer
 * el link escapado). En ambos sentidos: cualquier coincidencia de prefijo entre
 * la URL del reply y una del backend basta — el modelo no puede "adivinar" el
 * prefijo de una URL con token que no vio.
 */
export function vieneDeUnaTool(url: string, urlsDeTools: Set<string>): boolean {
  if (urlsDeTools.size === 0) return false
  const u = normalizarUrl(url)
  if (!u) return false
  if (urlsDeTools.has(u)) return true
  for (const t of urlsDeTools) {
    if (u.startsWith(t) || t.startsWith(u)) return true
  }
  return false
}
