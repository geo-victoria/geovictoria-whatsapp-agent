/**
 * REPARACIÓN DE MOJIBAKE (14-sep, caso COTEL / NDV-31863).
 *
 * El padrón SII local (`vic_empresas_cl`) guarda razones sociales con la
 * codificación rota: "TECNOLOGÍA" está almacenada como "TECNOLOGÃA" —
 * los bytes UTF-8 de la Í (C3 8D) leídos como Latin-1 y vueltos a codificar.
 * Como la emisión toma la razón social de ahí, el nombre roto viajaba a la
 * cuenta y la cotización de Zoho, de ahí al espejo de Creator, y ahí el
 * generador de PDF de la nota de venta se colgaba con el carácter de control
 * (U+008D) que la doble codificación deja adentro: 7 horas sin PDF, la nota
 * imposible de confirmar y 188 reintentos mudos del job.
 *
 * Medido el 14-sep: 8 cuentas, 18 deals y 21 cotizaciones desde el 20-ago con
 * el mismo defecto (NEUMÁTICOS COFRÉ, CLÍNICA LYON, PATIÑO JARAMILLO, CGO
 * ADMINISTRACIÓN, SOLDADURA Y FABRICACIÓN…). Todas nacen de Vicky.
 *
 * La reparación es PURA y va POR TRAMO: solo se decodifica cada pareja con la
 * firma inequívoca del defecto (Ã o Â seguidos del byte de continuación), y
 * el resto del texto queda como está. Así una cadena mezclada —parte sana,
 * parte rota, como "Navegación AÃ©rea"— se arregla sin tocar lo sano, y un
 * texto correcto pasa intacto, tilde incluida.
 */

/** Restos típicos de cp1252 cuando el paso intermedio no fue Latin-1 puro:
 * el byte 0x80-0x9F se convirtió en un carácter de puntuación tipográfica.
 * Se devuelven a su byte para que la decodificación cierre. */
const CP1252_A_BYTE: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87,
  "ˆ": 0x88, "‰": 0x89, "Š": 0x8A, "‹": 0x8B, "Œ": 0x8C, "Ž": 0x8E,
  "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97,
  "˜": 0x98, "™": 0x99, "š": 0x9A, "›": 0x9B, "œ": 0x9C, "ž": 0x9E, "Ÿ": 0x9F,
}
const CONTINUACIONES = "-¿" + Object.keys(CP1252_A_BYTE).join("")

/** Firma del mojibake UTF-8→Latin-1→UTF-8: Ã (0xC3) o Â (0xC2) seguidos de lo
 * que fue un byte de continuación (0x80-0xBF, o su disfraz cp1252). Cubre
 * todo U+0080–U+00FF: tildes, Ñ, º, ª, ü — lo que aparece en una razón social. */
const PAREJA = new RegExp(`[ÃÂ][${CONTINUACIONES}]`, "g")

const decoder = new TextDecoder("utf-8", { fatal: true })

function byteDe(ch: string): number {
  const code = ch.codePointAt(0) ?? 0
  return code <= 0xff ? code : CP1252_A_BYTE[ch] ?? -1
}

/** ¿Tiene la firma del defecto? Sirve para contar sin reparar. */
export function pareceMojibake(s: string): boolean {
  PAREJA.lastIndex = 0
  return PAREJA.test(String(s ?? ""))
}

/**
 * Devuelve el texto con cada pareja rota decodificada; lo que no calza con
 * la firma no se toca, y una pareja que no decodifica limpio se deja tal cual
 * (jamás devuelve algo peor que la entrada).
 */
export function repararMojibake(s: string): string {
  const texto = String(s ?? "")
  if (!pareceMojibake(texto)) return texto
  return texto.replace(PAREJA, (pareja) => {
    const b1 = byteDe(pareja[0])
    const b2 = byteDe(pareja[1])
    if (b1 < 0 || b2 < 0) return pareja
    try {
      const out = decoder.decode(Uint8Array.from([b1, b2]))
      // Un control C1 no es una reparación (sería el mismo defecto de nuevo).
      return /[-�]/.test(out) ? pareja : out
    } catch {
      return pareja
    }
  })
}

/** Reparación sobre cada campo string de un objeto plano (fichas, filas). */
export function repararCampos<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = { ...obj }
  for (const [k, v] of Object.entries(out)) if (typeof v === "string") out[k] = repararMojibake(v)
  return out as T
}
