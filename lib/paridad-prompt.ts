/**
 * PARIDAD DE PROMPTS ENTRE PAÍSES — el candado contra el drift.
 *
 * POR QUÉ EXISTE (Lalo 21-sep): "el aprendizaje de Chile no lo aplicaste
 * enseguida en Perú… deben haber muchas más brechas. Definamos cómo lograr que
 * esto sea escalable porque no queremos estar corrigiendo constantemente por
 * cada país las pequeñas brechas que hay con Chile. En Chile la tasa de cierre
 * ya se estabilizó… no es la idea estar encima de todos los países."
 *
 * El problema no era el olvido: el prompt de Perú YA tenía un bloque llamado
 * "Aprendizaje de Chile aplicado a Perú" escrito el 17-sep, y aun así el 21-sep
 * la conversación de prueba mostró 6 pasos que Chile había retirado y 8 reglas
 * que nunca llegaron. Se replicó lo que se recordaba, no lo que existía. La
 * réplica manual falla incluso con la mejor intención, así que el mecanismo
 * tiene que ser automático.
 *
 * CÓMO FUNCIONA
 *  · REGLAS_UNIVERSALES = las reglas de venta que valen en cualquier país
 *    (flujo, cierre, anti-teatro, no repreguntar). Cada una trae el ancla con
 *    que se reconoce en un prompt y una nota de por qué existe.
 *  · Lo LOCAL (moneda, documento tributario, normativa, catálogo, agenda,
 *    medios de pago, roster) NO entra acá: es legítimo que cambie por país.
 *  · DEUDA_DECLARADA congela lo que hoy falta, con fecha. El test falla solo
 *    si aparece una brecha NUEVA — así una mejora chilena no se puede desplegar
 *    sin decidir explícitamente qué pasa con los otros tres países, y la deuda
 *    vieja no deja la suite roja para siempre.
 *
 * NO entra acá lo que vive en CÓDIGO y ya es transversal por construcción: el
 * reconocimiento de la señal blanda (lib/senal-blanda), la casuística del
 * contacto (lib/casuistica-contacto), los cinturones del webhook y las guardas
 * del loop — esos no pueden quedar desalineados porque son el mismo módulo.
 *
 * Al agregar una regla al prompt chileno: súmala acá. Si no aplica a un país,
 * declara la excepción con su motivo — eso es una decisión, no un olvido.
 */

export type PaisPrompt = "cl" | "co" | "mx" | "pe"

export const PAISES_PROMPT: readonly PaisPrompt[] = ["cl", "co", "mx", "pe"]

export type ReglaUniversal = {
  /** Identificador corto y estable (se usa en la deuda declarada). */
  id: string
  /** Qué exige la regla, en una línea. */
  regla: string
  /** Cómo se reconoce en el texto de un prompt. */
  ancla: RegExp
  /** Por qué existe (cicatriz o decisión, con fecha). */
  motivo: string
  /** Países donde NO aplica, con el motivo de la excepción. */
  excepciones?: Partial<Record<PaisPrompt, string>>
}

/**
 * Reglas que un prompt de venta de Vicky debe tener en CUALQUIER país.
 * El ancla es deliberadamente laxa (una frase o un concepto), porque el texto
 * se adapta al registro local: lo que se vigila es que la REGLA esté, no que
 * el párrafo sea idéntico.
 */
export const REGLAS_UNIVERSALES: readonly ReglaUniversal[] = [
  {
    id: "consultiva_una_pregunta",
    regla: "Una sola pregunta consultiva de operación, en un solo turno",
    ancla: /cu[eé]ntame un poco de tu operaci[oó]n/i,
    motivo: "Eduardo 14-ago: el cuestionario en dos turnos se lee como examen y es fricción pura",
  },
  {
    id: "empresa_no_se_pregunta",
    regla: "El nombre de la empresa no se pide antes del precio",
    ancla: /empresa (no se pregunta|no se pide)|EMPRESA no se pregunta/i,
    motivo: "Lalo 13-ago: la razón social sale del documento tributario; pedirla antes del precio espanta",
  },
  {
    id: "puntos_no_se_preguntan",
    regla: "Los puntos o sedes no se preguntan: salen de la descripción de la operación",
    ancla: /PUNTOS F[IÍ]SICOS.{0,40}(jam[aá]s|NO SE PREGUNTAN)/i,
    motivo: "Chile 14-ago: preguntar los puntos duplica lo que el cliente ya contó",
  },
  {
    id: "reloj_modalidad_no_se_pregunta",
    regla: "El arriendo es el default del reloj y no se pregunta; la compra solo si el cliente la pide",
    ancla: /(arriendo.{0,30}(por defecto|default)|SIEMPRE en arriendo)/i,
    motivo: "Regla estricta de venta del reloj: ofrecer la compra sube el pago inicial y enfría la venta",
  },
  {
    id: "instalacion_no_se_pregunta",
    regla: "No se pregunta quién instala: auto-instalación por defecto, técnico opcional",
    ancla: /autoInstalada: true|(auto.?instalaci[oó]n|autoinstalable).{0,120}(por defecto|gratis|sin costo)/i,
    motivo: "Chile: el preform se calcula siempre con auto-instalación; preguntarlo agrega un turno inútil",
  },
  {
    id: "doble_valor",
    regla: "Con reloj se muestran SIEMPRE las dos opciones (con reloj y solo app)",
    ancla: /(DOBLE VALOR|alternativa m[aá]s econ[oó]mica|LAS DOS OPCIONES)/i,
    motivo: "Rodrigo 10-ago: aunque pidan reloj, la opción más barata se muestra igual",
  },
  {
    id: "cierre_presuntivo",
    regla: "Tras el precio se piden los datos, no el permiso (muere el micro-cierre)",
    ancla: /CIERRE PRESUNTIVO/i,
    motivo: "Lalo 24-jul: pedir el ok tras el precio es el punto de mayor fuga",
  },
  {
    id: "precio_sin_peaje",
    regla: "El precio no se condiciona a datos de identificación",
    ancla: /(PRECIO SIN PEAJE|nunca se condiciona a datos)/i,
    motivo: "Chile: retener el precio hasta tener los datos pierde al que solo quería saber cuánto sale",
  },
  {
    id: "precio_solo_de_tool",
    regla: "Ningún monto que no venga textual de una tool de ese turno",
    ancla: /(NUNCA enuncies un precio|precios? SOLO de tools|nunca calcules)/i,
    motivo: "Cicatriz permanente: un precio inventado se cobra o se desdice, y las dos salidas son malas",
  },
  {
    id: "anti_teatro",
    regla: "Prohibido afirmar una acción que no ejecutó una tool en ese turno",
    ancla: /(anti.?teatro|JAM[AÁ]S afirmes una acci[oó]n|ya te la envi[eé] al correo)/i,
    motivo: "Casos METAL ORGÁNICO y 'cuenta creada' con cero tools: el cliente queda esperando algo que no pasó",
  },
  {
    id: "no_instructivo_acceso",
    regla: "Prohibido dar instrucciones de acceso a la plataforma en la fase de venta",
    ancla: /instrucciones de acceso|instructivos? de acceso/i,
    motivo: "Caso Eduardo Guzmán 10-sep: le dictó credenciales de una cuenta que no existía",
  },
  {
    id: "pago_declarado",
    regla: "Pago declarado no es pago confirmado",
    ancla: /(pago declarado|declara que pag[oó]|ya transfer[ií])/i,
    motivo: "10-sep: 'ya está pagado' + teatro de confirmación mandó a un cliente a una cuenta inexistente",
  },
  {
    id: "no_repreguntar",
    regla: "No volver a pedir un dato que el cliente ya dio",
    ancla: /(NO REPREGUNTAR|Nunca pidas datos que ya te dieron|nunca repitas una pregunta ya respondida)/i,
    motivo: "Repreguntar delata al bot y es la queja más repetida del cliente",
  },
  {
    id: "prohibido_oye",
    regla: "Nunca dirigirse al cliente con 'Oye'",
    ancla: /"?Oye"?/,
    motivo: "Orden de Eduardo 23-jul",
  },
  {
    id: "sin_signos_apertura",
    regla: "Sin signos de apertura ni dobles asteriscos (formato WhatsApp)",
    ancla: /(sin signos de apertura|doble asterisco|\*\*negrita\*\*)/i,
    motivo: "El formato delata al bot: WhatsApp muestra el asterisco literal",
  },
  {
    id: "objeciones_que_cierran",
    regla: "Bloque de objeciones que antes se derivaban y ahora cierran",
    ancla: /(Objeciones que|objeciones.{0,40}cierran)/i,
    motivo: "Lalo 07-sep: 12 puntos levantados de 269 derivaciones que no debieron existir",
  },
  {
    id: "orden_negociacion",
    regla: "Ante objeción de precio: primero la opción sin reloj, después el pivote a arriendo, al final el descuento",
    ancla: /(opci[oó]n SIN reloj|sin reloj).{0,200}(escalera|descuento)/i,
    motivo: "El descuento es el último recurso: rebajar antes regala margen que la configuración resolvía",
  },
  {
    id: "descuento_solo_por_objecion",
    regla: "El descuento existe solo como respuesta a una objeción de precio, nunca proactivo",
    ancla: /(no se ofrece de forma proactiva|SOLO (como respuesta a )?una? objeci[oó]n|JAM[AÁ]S lo ofrezcas de entrada)/i,
    motivo: "Un descuento proactivo baja el ticket sin necesidad y enseña a negociar",
    excepciones: {
      co: "En Colombia Vicky no tiene descuentos: están prohibidos por política del equipo CO",
      mx: "En México Vicky no tiene descuentos: están prohibidos por política del equipo MX",
    },
  },
  {
    id: "entrega_una_vez",
    regla: "La cotización formal se emite y se entrega una sola vez",
    ancla: /(UNA SOLA VEZ|una sola vez)/i,
    motivo: "Repetir el link ante un 'ok' parece bot y duplica cotizaciones",
  },
  {
    id: "cliente_amplia_es_venta",
    regla: "Cliente actual que quiere ampliar es una venta, no soporte",
    ancla: /(CLIENTE ACTUAL QUE|cliente.{0,30}ampliar)/i,
    motivo: "Caso Supermercado Belén 06-ago: pidió cotizar una sucursal nueva y la conversación se cerró como soporte",
  },
  {
    id: "no_inventar_clientes",
    regla: "Nunca inventar nombres de clientes, casos ni cifras de la competencia",
    ancla: /(JAM[AÁ]S inventes nombres|NO inventes NUNCA nombres|sin inventar cifras)/i,
    motivo: "Una referencia inventada se cae en la primera pregunta del cliente",
  },
]

/**
 * Brechas VIGENTES al 21-sep-2026, con fecha. Congelan la deuda para que el
 * test vigile solo lo NUEVO. Sacar una línea de acá = cerrar esa brecha.
 */
export const DEUDA_DECLARADA: Partial<Record<PaisPrompt, Record<string, string>>> = {
  // Medición del 21-sep-2026 (test de paridad): CL 21/21 · PE 21/21 · CO 9/21 ·
  // MX 9/21. Colombia y México están en la generación de julio de Chile: el
  // prompt de MX es un fork del de CO, así que arrastran las mismas
  // deprecaciones. Cada línea que se borre de acá es una brecha cerrada.
  co: {
    consultiva_una_pregunta: "medido 21-sep-2026",
    empresa_no_se_pregunta: "medido 21-sep-2026",
    puntos_no_se_preguntan: "medido 21-sep-2026",
    instalacion_no_se_pregunta: "medido 21-sep-2026",
    doble_valor: "medido 21-sep-2026",
    cierre_presuntivo: "medido 21-sep-2026",
    anti_teatro: "medido 21-sep-2026",
    no_instructivo_acceso: "medido 21-sep-2026",
    objeciones_que_cierran: "medido 21-sep-2026",
    orden_negociacion: "medido 21-sep-2026",
    cliente_amplia_es_venta: "medido 21-sep-2026",
  },
  mx: {
    consultiva_una_pregunta: "medido 21-sep-2026",
    empresa_no_se_pregunta: "medido 21-sep-2026",
    puntos_no_se_preguntan: "medido 21-sep-2026",
    reloj_modalidad_no_se_pregunta: "medido 21-sep-2026",
    doble_valor: "medido 21-sep-2026",
    cierre_presuntivo: "medido 21-sep-2026",
    anti_teatro: "medido 21-sep-2026",
    no_instructivo_acceso: "medido 21-sep-2026",
    objeciones_que_cierran: "medido 21-sep-2026",
    orden_negociacion: "medido 21-sep-2026",
    cliente_amplia_es_venta: "medido 21-sep-2026",
  },
}

/** Reglas que un país debe cumplir (las universales menos sus excepciones). */
export function reglasExigidas(pais: PaisPrompt): ReglaUniversal[] {
  return REGLAS_UNIVERSALES.filter((r) => !r.excepciones?.[pais])
}

export type Brecha = { pais: PaisPrompt; id: string; regla: string; motivo: string; declarada: boolean }

/** Brechas de un prompt: reglas exigidas cuyo ancla no aparece en el texto. */
export function brechasDe(pais: PaisPrompt, texto: string): Brecha[] {
  const t = String(texto || "")
  return reglasExigidas(pais)
    .filter((r) => !r.ancla.test(t))
    .map((r) => ({
      pais,
      id: r.id,
      regla: r.regla,
      motivo: r.motivo,
      declarada: Boolean(DEUDA_DECLARADA[pais]?.[r.id]),
    }))
}
