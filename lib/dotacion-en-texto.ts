/**
 * Dotación que el CLIENTE escribió en el chat, leída sin modelo.
 *
 * CASO La Birra Chile (01-oct, reclamo de Grey y Ana López): la clienta
 * escribió "Muriel Infante, de 200 a 400 personas" y dio el RUT. El extractor
 * (Haiku) devolvió `trabajadores: null` porque era un RANGO, el hito por chat
 * corrió con `empleados=?` y el trato no nació. Diez minutos después la
 * consulta de agenda entregó el LEAD a la tómbola (Ana), la reunión quedó en
 * la agenda de Ana, y recién al agendar nació el trato (Grey). Dos ejecutivas
 * sobre la misma clienta, y la reunión en el calendario equivocado.
 *
 * Regla (la misma de parseEmpleados): de un rango se toma el PISO; "más de X"
 * cuenta como X+1. Manda la ÚLTIMA mención (el cliente puede corregirse).
 * PURO: sin red ni imports, cargable por node --test.
 */

const UNIDAD =
  "(?:personas?|trabajador(?:es|as?)|empleados?|colaborador(?:es|as?)|funcionari[oa]s?|operari[oa]s?|usuarios?|gente)"

// Número suelto: no pegado a otros dígitos ni a puntos de miles/RUT.
const NUM = "(?<![\\d.,])(\\d{1,5})(?![\\d]|[.,]\\d)"

const RE_RANGO = new RegExp(
  `(?:entre\\s+)?${NUM}\\s*(?:a|-|–|y|al|hasta)\\s*(\\d{1,5})(?![\\d]|[.,]\\d)\\s*(?:de\\s+)?${UNIDAD}`,
  "gi",
)
const RE_MAS_DE = new RegExp(`(?:m[aá]s\\s+de|sobre|arriba\\s+de|superior(?:es)?\\s+a)\\s+${NUM}\\s*${UNIDAD}`, "gi")
const RE_SIMPLE = new RegExp(`${NUM}\\s*(?:de\\s+)?${UNIDAD}`, "gi")
const RE_SOMOS = new RegExp(`\\bsomos\\s+(?:como\\s+|unos?\\s+|unas?\\s+|aprox(?:imadamente)?\\.?\\s+|alrededor\\s+de\\s+)?${NUM}`, "gi")

type Mencion = { pos: number; n: number }

function valido(n: number): boolean {
  return Number.isFinite(n) && n > 0 && n <= 100000
}

/** Dotación declarada en un texto del cliente, o undefined si no la dijo. */
export function dotacionEnTexto(texto: string): number | undefined {
  const t = String(texto || "")
  if (!t.trim()) return undefined
  const menciones: Mencion[] = []
  const ocupados: Array<[number, number]> = []
  const libre = (a: number, b: number) => !ocupados.some(([x, y]) => a < y && b > x)

  for (const m of t.matchAll(RE_RANGO)) {
    const a = Number(m[1])
    const b = Number(m[2])
    const piso = Math.min(a, b)
    if (valido(piso)) {
      menciones.push({ pos: m.index ?? 0, n: piso })
      ocupados.push([m.index ?? 0, (m.index ?? 0) + m[0].length])
    }
  }
  for (const m of t.matchAll(RE_MAS_DE)) {
    const ini = m.index ?? 0
    if (!libre(ini, ini + m[0].length)) continue
    const n = Number(m[1]) + 1
    if (valido(n)) {
      menciones.push({ pos: ini, n })
      ocupados.push([ini, ini + m[0].length])
    }
  }
  for (const re of [RE_SIMPLE, RE_SOMOS]) {
    for (const m of t.matchAll(re)) {
      const ini = m.index ?? 0
      if (!libre(ini, ini + m[0].length)) continue
      const n = Number(m[1])
      if (valido(n)) {
        menciones.push({ pos: ini, n })
        ocupados.push([ini, ini + m[0].length])
      }
    }
  }
  if (!menciones.length) return undefined
  menciones.sort((x, y) => x.pos - y.pos)
  return menciones[menciones.length - 1].n
}
