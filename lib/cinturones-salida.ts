/**
 * LOS CINTURONES DE CHILE, EN LOS CUATRO PAÍSES (21-sep, orden de Lalo: "los
 * cinturones de Chile también hay que usarlos en los países" · "Chile es el
 * modelo a seguir para el comportamiento").
 *
 * EL HALLAZGO QUE LO MOTIVA: el inventario de imports de los cuatro webhooks
 * mostró que `precio-sin-tool` —el cinturón que impide afirmar un precio que
 * ninguna tool calculó— corría SOLO en Chile. En Perú, Colombia y México nada
 * frenaba un precio inventado, y el mismo día vimos al modelo reescribir el
 * mensaje de la tool en la línea peruana.
 *
 * POR QUÉ UN MÓDULO Y NO TRES COPIAS: un cinturón copiado en cuatro webhooks
 * se desalinea igual que un prompt copiado — es la misma enfermedad que nos
 * dejó a Colombia y México en la generación de julio. Lo que vive en UN módulo
 * compartido no puede quedar desalineado: es el mismo código. Los cuatro
 * webhooks llaman `revisarSalida` en un punto y ejecutan su veredicto.
 *
 * QUÉ NO VA ACÁ: los cinturones que dependen del ESTADO del contacto (pago
 * declarado, casuística, cliente existente, soporte inventado) siguen en su
 * módulo y se cablean aparte — este archivo es solo lo que se juzga mirando el
 * TEXTO SALIENTE del turno.
 *
 * PURO: sin red, sin Supabase. El reintento lo ejecuta el webhook, que es el
 * único que conoce su propio system prompt.
 */

import { chequearPreciosDelReply } from "./precio-sin-tool.ts"
import { mensajeCanonicoDe, precioDeformado, type LlamadaTool } from "./precio-deformado.ts"
import { preguntasProhibidasEn, directivaSinPreguntasProhibidas } from "./pregunta-prohibida.ts"

export type PaisCinturon = "cl" | "co" | "mx" | "pe"

export type Veredicto = {
  /** ok = el borrador sale tal cual. */
  accion: "ok" | "reemplazo" | "reintento"
  /** Con `reemplazo`: el texto que debe salir (determinista, sin reintento). */
  reply?: string
  /** Con `reintento`: la instrucción de sistema que se suma al prompt. */
  directiva?: string
  /** Qué hacer si el reintento vuelve igual de mal. */
  siFallaReintento?: "contener" | "dejar_pasar"
  /** Texto de contención (solo cuando siFallaReintento = "contener"). */
  contencion?: string
  /** Para el log y el aviso interno. */
  motivos: string[]
  /** Identificador del cinturón que disparó, para medir cuál actúa más. */
  cinturon?: "precio_deformado" | "precio_sin_tool" | "pregunta_prohibida"
}

const OK: Veredicto = { accion: "ok", motivos: [] }

/**
 * Contención cuando ni el reintento consigue un precio con respaldo. Un precio
 * equivocado a alguien que está por pagar es peor que una demora (criterio del
 * cinturón de URLs, 03-sep).
 */
const CONTENCION: Record<PaisCinturon, string> = {
  cl: "Déjame confirmarte el valor exacto con el sistema para no darte una cifra equivocada — te lo digo en un momento 🙌",
  co: "Déjame confirmarte el valor exacto con el sistema para no darte una cifra equivocada — te cuento en un momento 🙌",
  mx: "Déjame confirmarte el valor exacto con el sistema para no darte una cifra equivocada — te digo en un momento 🙌",
  pe: "Déjame confirmarte el valor exacto con el sistema para no darte una cifra equivocada — te digo en un momento 🙌",
}

const FORZAR_TOOL_PRECIO =
  "\n\n# Instrucción de sistema (este turno)\n" +
  "Tu borrador anterior AFIRMÓ un precio que ninguna tool calculó en este turno y que " +
  "tú nunca le habías dicho a este cliente. PROHIBIDO componer, estimar o extrapolar " +
  "precios: el motor es la única fuente. Si el cliente pregunta por un valor nuevo " +
  "(otra dotación, otra configuración), llama AHORA la tool que corresponde y entrega su " +
  "cifra tal cual. Si el precio no cambió, dilo sin inventar una cifra nueva."

export type EntradaSalida = {
  reply: string
  toolCalls: readonly LlamadaTool[] | undefined
  /** Textos que Vicky YA le envió a este contacto (respaldan repetir un precio). */
  historialAsistente: string[]
  pais: PaisCinturon
  /** En la fase de onboarding no hay venta: estos cinturones no aplican. */
  enOnboarding?: boolean
}

/**
 * Un solo veredicto, por prioridad de daño: primero el precio deformado (que
 * se arregla sin reintento porque el texto bueno ya existe), después el precio
 * sin respaldo, y al final las preguntas que el flujo retiró.
 */
export function revisarSalida(e: EntradaSalida): Veredicto {
  const reply = String(e.reply || "")
  if (!reply.trim() || e.enOnboarding) return OK

  // (1) La tool escribió el mensaje y el modelo lo deformó. No hace falta
  // reintento: el texto correcto es el de la tool.
  const canonico = mensajeCanonicoDe(e.toolCalls)
  if (canonico) {
    const d = precioDeformado(reply, canonico)
    if (d.deformado) {
      return {
        accion: "reemplazo",
        reply: canonico,
        motivos: d.motivos,
        cinturon: "precio_deformado",
      }
    }
  }

  // (2) Un monto que nadie calculó. Lo trae Chile desde el caso del tramo fijo
  // (un cliente bajó de 6 personas a 5 por una cifra que el modelo compuso).
  const toolsOk = (e.toolCalls || []).filter((c) => c?.ok).map((c) => c.name)
  const cp = chequearPreciosDelReply(reply, toolsOk, e.historialAsistente)
  if (cp.hayInventado) {
    return {
      accion: "reintento",
      directiva: FORZAR_TOOL_PRECIO,
      siFallaReintento: "contener",
      contencion: CONTENCION[e.pais] || CONTENCION.cl,
      motivos: cp.inventados.map(String),
      cinturon: "precio_sin_tool",
    }
  }

  // (3) Preguntas que el flujo chileno retiró. Si el reintento tampoco las
  // saca, el mensaje original SALE: dejar al cliente sin respuesta por una
  // pregunta de más es peor que la pregunta de más. Queda el aviso para medir.
  const pp = preguntasProhibidasEn(reply)
  if (pp.length) {
    return {
      accion: "reintento",
      directiva: directivaSinPreguntasProhibidas(pp),
      siFallaReintento: "dejar_pasar",
      motivos: pp.map((h) => h.id),
      cinturon: "pregunta_prohibida",
    }
  }

  return OK
}

/** ¿El reintento quedó bien? Se re-evalúa con el MISMO juez. */
export function reintentoQuedoBien(e: EntradaSalida): boolean {
  return revisarSalida(e).accion === "ok"
}
