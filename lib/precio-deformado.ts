/**
 * EL MENSAJE DE PRECIO ES EL DE LA TOOL, NO UNA SUGERENCIA.
 *
 * POR QUÉ EXISTE (21-sep, prueba de Rodrigo en la línea de Perú): con el
 * prompt correcto desplegado y la tool nueva corriendo —el plan salió a
 * S/5,5 por persona y el arriendo al dólar SUNAT del día, o sea el motor
 * estaba bien— el modelo REESCRIBIÓ el `mensajeParaProspecto` en vez de
 * copiarlo: perdió el DOBLE VALOR (la opción solo-app desapareció), le
 * agregó la aritmética del impuesto ("S/180 + IGV (18%) = S/212.40") y un
 * "Pago inicial" que repetía la mensualidad. Veinticinco minutos después, con
 * el MISMO build, la misma conversación salió perfecta. Es intermitente, y
 * por eso el prompt no alcanza: la regla "copia su mensajeParaProspecto tal
 * cual" está escrita en los cuatro prompts y se cumple a veces.
 *
 * Este módulo NO juzga el precio (eso es lib/precio-sin-tool, que caza montos
 * sin respaldo). Juzga la FORMA: si la tool ya escribió el mensaje del
 * cliente, un reply que le quita opciones o le agrega aritmética es una
 * deformación, y el texto canónico gana.
 *
 * PURO: sin red, sin Supabase. Lo cablean los cuatro webhooks.
 */

/** Tools que devuelven un `mensajeParaProspecto` ya redactado para el cliente. */
export const TOOLS_CON_MENSAJE_CANONICO = new Set([
  "cotizar_referencial",
  "generar_link_cotizadora",
  "actualizar_cotizacion",
  "consultar_descuento_referencial",
  "aplicar_siguiente_descuento",
  "anualizar_cotizacion",
])

export type LlamadaTool = { name: string; ok: boolean; output?: unknown }

/** Marcadores de que el mensaje trae las DOS opciones (con equipo y solo app). */
const MARCA_DOBLE_VALOR = /(2\.-|alternativa m[aá]s econ[oó]mica|qu[eé] opci[oó]n prefieres|LAS DOS OPCIONES)/i
/** La aritmética del impuesto que el cliente no tiene por qué ver. */
const ARITMETICA_IMPUESTO = /\+\s*(IVA|IGV)\s*\(?\s*\d{1,2}\s*%?\s*\)?\s*=/i
/** Bloque de pago al aceptar. */
const PAGO_INICIAL = /(pago inicial|pago [uú]nico|a pagar ahora)/i

export type Deformacion = {
  deformado: boolean
  /** Ids de lo que se deformó, para el aviso interno y la medición. */
  motivos: string[]
}

/**
 * El último `mensajeParaProspecto` de una tool de precio que salió OK en este
 * turno. Es el texto que el prompt manda copiar tal cual.
 *
 * Devuelve "" cuando la tool trae `_descuentoAcordado`: ahí el prompt chileno
 * ORDENA no pegar el bloque de la tool (sus números no llevan el descuento ya
 * negociado y contradirían el total), así que el cinturón no opina.
 */
export function mensajeCanonicoDe(calls: readonly LlamadaTool[] | undefined): string {
  let canonico = ""
  for (const c of calls || []) {
    if (!c?.ok || !TOOLS_CON_MENSAJE_CANONICO.has(c.name)) continue
    const out = (c.output || {}) as Record<string, unknown>
    if (out._descuentoAcordado) return ""
    const m = out.mensajeParaProspecto
    if (typeof m === "string" && m.trim().length > 40) canonico = m.trim()
  }
  return canonico
}

/**
 * ¿El reply deformó el mensaje canónico? Solo mira lo que le QUITA o le AGREGA
 * al texto de la tool — nunca el estilo ni el orden, que el modelo puede
 * adaptar sin daño.
 */
export function precioDeformado(reply: string, canonico: string): Deformacion {
  const r = String(reply || "")
  const c = String(canonico || "")
  const motivos: string[] = []
  if (!r.trim() || !c.trim()) return { deformado: false, motivos }

  // (1) La opción más barata desapareció. Es la que Rodrigo no vio, y la regla
  // de Rodrigo del 10-ago es que se muestra SIEMPRE, incluso si piden el reloj.
  if (MARCA_DOBLE_VALOR.test(c) && !MARCA_DOBLE_VALOR.test(r)) motivos.push("perdio_doble_valor")

  // (2) Aritmética del impuesto que la tool no escribió: el cliente compara
  // totales, no sumas. "no aritmética del IVA" es regla de la casa.
  if (ARITMETICA_IMPUESTO.test(r) && !ARITMETICA_IMPUESTO.test(c)) motivos.push("aritmetica_impuesto")

  // (3) Un pago al aceptar que la tool no calculó. Sin pagos únicos no existe
  // pago inicial, y repetir la mensualidad como "pago inicial" asusta.
  if (PAGO_INICIAL.test(r) && !PAGO_INICIAL.test(c)) motivos.push("pago_inicial_inventado")

  return { deformado: motivos.length > 0, motivos }
}
