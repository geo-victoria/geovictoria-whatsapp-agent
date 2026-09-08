/**
 * CASUÍSTICA DEL CONTACTO (Lalo 08-sep, "estamos fallando al crear leads que
 * son usuarios… necesito que Vicky entienda bien todas las casuísticas").
 *
 * MÓDULO PURO (sin red, sin Supabase): clasifica una conversación por lo que
 * escribió el CLIENTE y dice si es un PROSPECTO (se vende) o alguien que NO
 * debe entrar al circuito comercial (no nace lead, no se traspasa, no hay
 * toques) y cómo debe tratarlo Vicky.
 *
 * Calibrado contra la data real (jun-sep 2026): de 136 leads de Vicky que el
 * equipo marcó "No Calificado", 46 eran "Es un usuario" y solo 9 de ellos
 * tenían el número en una cuenta cliente de Zoho — los otros 37 eran
 * TRABAJADORES escribiendo desde su celular personal ("no puedo marcar",
 * "no me llega el correo de recuperación", "soy colaborador") o
 * administradores con un problema de uso. La única señal que existe para
 * ellos es el CHAT. Por eso este clasificador es determinista y corre sobre
 * los mensajes del cliente; la señal de CUENTA (lib/cliente-existente) es
 * complementaria.
 *
 * Tipos:
 *  - prospecto                → venta normal (default)
 *  - cliente_ampliacion       → cliente actual que quiere comprar más: SE VENDE con precio al tiro (Lalo 07-sep)
 *  - trabajador_cliente       → trabajador de una empresa cliente con un problema de uso
 *  - cliente_soporte          → admin/RRHH de una empresa cliente con problema operativo
 *  - cliente_administrativo   → baja del servicio, factura/cobranza, contrato, NDA, API
 *  - cliente_capacitacion     → cliente actual pidiendo capacitación
 *  - busca_empleo             → busca trabajo
 *  - ex_empleado              → ex trabajador de GeoVictoria (finiquito, etc.)
 *  - consulta_ajena           → pregunta laboral/legal sin relación con comprar
 *  - otro_hardware            → quiere algo que no vendemos (tarjetas para otro sistema, comedor…)
 *  - spam                     → publicidad, links ajenos, juegos
 */

export type TipoCasuistica =
  | "prospecto"
  | "cliente_ampliacion"
  | "trabajador_cliente"
  | "cliente_soporte"
  | "cliente_administrativo"
  | "cliente_capacitacion"
  | "busca_empleo"
  | "ex_empleado"
  | "consulta_ajena"
  | "otro_hardware"
  | "spam"

export type Casuistica = {
  tipo: TipoCasuistica
  /** true = entra al circuito comercial (lead, traspaso, toques). */
  esProspecto: boolean
  /** true = Vicky puede cotizar/vender en esta conversación. */
  vende: boolean
  /** Motivo_No_calificado de Zoho que corresponde si ya existe un lead. */
  motivoZoho: string | null
  evidencia: string[]
}

const PROSPECTO: Casuistica = { tipo: "prospecto", esProspecto: true, vende: true, motivoZoho: null, evidencia: [] }

export function normalizarTexto(s: string): string {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

type Regla = { re: RegExp; tag: string }
const R = (tag: string, re: RegExp): Regla => ({ re, tag })

/** El que escribe ya es cliente / usuario de GeoVictoria (empresa con el servicio contratado). */
const SENAL_CLIENTE: Regla[] = [
  R("ya soy cliente", /\b(ya )?(soy|somos) (cliente|clientes|usuari[oa]s?)( de geovictoria| de ustedes)?\b/),
  R("ya trabajamos con ustedes", /\b(ya|actualmente) (trabajamos|trabajo|contamos|cuento) con (ustedes|geovictoria|su (producto|servicio|plataforma|sistema))/),
  R("tenemos geovictoria", /\b(tenemos|tienen|tengo|usamos|utilizamos|manejamos|contratamos|contrate) (geovictoria|geo victoria|su (plataforma|sistema|servicio|app|producto)|el (sistema|servicio) (de ustedes|contratado))/),
  R("geovictoria implementado", /\b(geovictoria|geo victoria) (implementad[oa]|contratad[oa]|instalad[oa]|activ[oa])\b/),
  R("convenio vigente", /\b(convenio|contrato) (vigente|activo|con ustedes|pactado)\b/),
  R("nuestra empresa tiene contratado", /\b(nuestra|mi) empresa (ya )?(tiene|tenemos) (contratad[oa]s?|geovictoria)\b/),
  R("mi/nuestra cuenta", /\b(mi|nuestra) cuenta (de (empleador|geovictoria|la plataforma)|en geovictoria)\b/),
  R("aun estamos implementando", /\b(aun|todavia) (estamos|seguimos) implementando\b/),
  R("nombre de la empresa con geovictoria", /\bempresa con geovictoria\b/),
  R("ticket levantado", /\bticket (levantado|numero|n°|nº|abierto)\b|\bnumeracion\b.*\bticket\b|\bticket\b.*\bnumeracion\b/),
]

/** El que escribe es un TRABAJADOR (no el que compra). */
const SENAL_TRABAJADOR: Regla[] = [
  R("soy trabajador/colaborador", /\b(soy|como) (un |una )?(trabajador|trabajadora|colaborador|colaboradora|emplead[oa]|operari[oa]|funcionari[oa]|miembro de equipo|usuario final)\b/),
  R("solo trabajo y marco", /\b(solo|solamente) trabajo\b/),
  R("marcar mi asistencia", /\b(marcar|registrar|hacer) mi (asistencia|marcacion|entrada|salida|hora|ingreso)\b/),
  R("mi marcación", /\b(mi|mis) (marcacion|marcaciones|marcas|marcaje|asistencia|nomina|ingreso)\b/),
  R("no puedo marcar", /\bno (puedo|pude|logro|me deja|me permite|he podido|podido) (marcar|hacer (la|mi) marca|realizar mi ingreso|registrar mi)\b|\bno (puedo|pude|he podido)\b.{0,40}\b(marc\w*|mccam|la entrada|la salida|mi ingreso)\b/),
  R("mi jefe dice", /\bmi (jefe|jefa|supervisor|supervisora|encargad[oa])\b/),
  R("cambié de número", /\bcambie de (numero|celular|telefono)\b/),
  R("no me renovaron/planilla", /\bmi (liquidacion|sueldo|planilla)\b/),
  R("rol: usuario/colaborador", /^(usuario|usuaria|colaborador|colaboradora|trabajador|trabajadora|empleado|empleada|operario|operaria)\.?$/),
]

/** Problema operativo con la plataforma (acceso, clave, app, reloj, marcaciones). */
const SENAL_SOPORTE: Regla[] = [
  R("no puedo entrar", /\bno (puedo|pude|logro|me deja|me permite|podemos|he podido) (entrar|ingresar|acceder|abrir|iniciar sesion)\b/),
  R("contraseña/clave", /\b(contrasena|clave|password)\b/),
  R("recuperar acceso", /\b(recuperar|recuperacion|restablecer|resetear|desbloquear|habilitar|habilitacion|reactivar) (mi |la |el )?(acceso|cuenta|usuario|clave|contrasena|correo)?\b/),
  R("sin acceso", /\b(sin|no tengo|perdi el) acceso\b/),
  R("no recibo el correo", /\bno (me )?(llega|llegan|recibo|reciben) (el|los) correo/),
  R("necesito soporte", /\b(necesito|quiero|busco) (soporte|ayuda tecnica|asistencia tecnica)\b|\bnumero de soporte\b|\bcon soporte\b/),
  R("ayuda con geovictoria", /\b(ayuda|ayudar|colabore|colaborar) (con|en) (geovictoria|geo victoria|mi cuenta|la cuenta|la app|la aplicacion|la plataforma|el reloj|el sistema)\b/),
  R("problema con la plataforma", /\b(problema|problemas|falla|fallas|error|inconveniente) (con|en) (la|el|mi|los|las) (marcacion|marcaciones|app|aplicacion|plataforma|sistema|reloj|dispositivo|ingreso|registro|marcaje)\b/),
  R("no funciona", /\bno (esta|estan) funcionando\b|\bno funciona\b|\bse cayo\b|\bno se registran\b|\bno registra\b/),
  R("ticket", /\bticket\b/),
  R("reporte de marcaciones", /\breporte de (marca|marcaciones|asistencia)\b/),
  R("cambiar de red wifi", /\bcambiarlo de red\b|\bcambiar(lo)? de wifi\b|\bred wifi\b/),
  R("no me aparece / no me deja", /\bno me (aparece|deja|carga|abre|reconoce)\b/),
  R("manual de usuario", /\bmanual (de|para) (usuario|uso)\b|\bpaso a paso\b/),
  R("actualizar datos para desbloquear", /\bdesbloquear\b/),
]

/** Gestión administrativa de un cliente: baja, cobranza, contrato, datos, API. */
const SENAL_ADMINISTRATIVA: Regla[] = [
  R("dar de baja", /\b(dar|darnos|darme|dar(le)?) de baja\b|\bbaja del servicio\b|\bcancelar (el )?(servicio|contrato|suscripcion)\b/),
  R("término de contrato con ustedes", /\b(poner |dar )?termino (al|del) contrato\b.{0,40}\b(ustedes|geo ?victoria|el servicio)\b|\bterminar (el |nuestro )?contrato con (ustedes|geo ?victoria)\b|\bterminamos contrato\b/),
  R("cobranza", /\b(cobranza|nos estan cobrando|me estan cobrando|cobro indebido|deuda|pago pendiente|nota de credito)\b/),
  R("factura (débil)", /\b(factura|facturas|facturacion|cobro)\b/),
  R("copia del contrato", /\bcopia del contrato\b|\bcontrato pactado\b/),
  R("NDA / datos personales (cliente)", /\b(confidencialidad|nda|proteccion (de|y) (los )?datos|politica de privacidad)\b/),
  R("API / integración (cliente)", /\bapi (publica|de integracion|de ustedes|rest)\b|\bconectarme a sus servicios\b|\binfo de la api\b/),
  R("contacto de ejecutivo de cuenta", /\b(ejecutivo|ejecutiva) de (cuentas?|cobranza)\b|\bkam\b|\bquien lleva (nuestra|mi) cuenta\b/),
]

const SENAL_CAPACITACION: Regla[] = [R("capacitación", /\bcapacitacion|capacitar|induccion|curso\b/)]

/** Cliente actual que quiere comprar/agregar algo: ES VENTA. */
const SENAL_AMPLIACION: Regla[] = [
  R("más usuarios / otro reloj", /\b(mas|otro|otros|nuevo|nuevos|agregar|sumar|ampliar|adicional|adicionales) (usuarios?|personas|trabajadores|reloj|relojes|equipos?|licencias?|sucursal|sucursales)\b/),
  R("instalación de equipo", /\binstalacion (de|del) (equipo|reloj)\b|\bque lo instalen\b|\bpara que lo instalen\b/),
  R("tarjetas / impresora", /\b(tarjetas?|llaveros?|impresora)\b/),
  R("quiere cotizar", /\b(cotizar|cotizacion|precio|precios|valor|valores|cuanto (sale|cuesta|vale)|contratar|comprar|retomar)\b/),
  R("volver a contratar", /\b(volver a (retomar|contratar|trabajar)|retomarlo|reactivar el servicio)\b/),
]

const SENAL_NO_PROSPECTO: Array<{ tipo: TipoCasuistica; reglas: Regla[] }> = [
  {
    tipo: "busca_empleo",
    reglas: [
      R("necesito trabajar", /\bnecesito (urgente )?trabajar\b|\bbusco (trabajo|empleo|pega)\b|\bbuscando (trabajo|empleo)\b/),
      R("vacante / postular", /\b(vacante|vacantes|postular|postulacion|curriculum|cv|reclutar|reclutamiento|me contraten|oferta laboral|hay trabajo)\b/),
      R("no me renovaron el contrato", /\bno me renovaron\b/),
    ],
  },
  {
    tipo: "ex_empleado",
    reglas: [
      R("trabajé para GeoVictoria", /\b(trabaje|trabajaba|trabajando) (para|en) geo ?victoria\b/),
      R("finiquito", /\bfiniquito\b/),
    ],
  },
  {
    tipo: "otro_hardware",
    reglas: [
      R("ya tienen otro sistema instalado", /\bya tenemos (el |un )?(sistema|biometrico|reloj) instalado\b|\btenemos otro (sistema|proveedor)\b|\bno (es )?el sistema de ustedes\b/),
      R("tarjeta/llavero para su biométrico", /\b(tarjeta|tarjetas|llavero|llaveros) (para|del|de) (el )?(biometrico|acceso de propietarios|portal)\b/),
      R("consumo de comedor", /\b(comedor|casino) .*(consumos?|checadas)\b|\bchecadas en comedor\b/),
    ],
  },
  {
    tipo: "consulta_ajena",
    reglas: [
      R("cuánto se paga el domingo", /\bcuanto (sale|se paga|deberian pagar|nos deberian pagar|me deben)\b.*\b(domingo|feriado|hora extra|horas extras|recargo|dominical)\b/),
      R("recargo dominical / sueldo mínimo", /\b(recargo dominical|sueldo minimo|salario minimo)\b/),
    ],
  },
  {
    tipo: "spam",
    reglas: [
      R("pitch de vendedor", /\ble saluda [a-z ]{2,40} (vendedor|vendedora|ejecutiv[oa]|asesor|asesora)\b|\bestamos a su disposicion para\b/),
      R("juegos / cadenas", /\bfree fire\b|\bpegar rojos\b/),
      R("link ajeno", /https?:\/\/(?!(www\.)?(geovictoria|cotizacion\.geovictoria|wa\.me|api\.whatsapp))[a-z0-9.-]+\.[a-z]{2,}\S*/),
    ],
  },
]

/** Intención de compra explícita (anula lecturas de soporte cuando no hay señal de cliente). */
const INTENCION_COMPRA = /\b(cotizar|cotizacion|cotizaciones|presupuesto|precio|precios|valor|valores|cuanto (sale|cuesta|vale)|contratar|comprar|me interesa|quiero (el|un) (plan|servicio|reloj|control)|control de asistencia para|implementar)\b/

function hits(reglas: Regla[], texto: string, mensajes: string[]): string[] {
  const out: string[] = []
  for (const r of reglas) {
    if (r.re.source.startsWith("^")) {
      if (mensajes.some((m) => r.re.test(m))) out.push(r.tag)
    } else if (r.re.test(texto)) out.push(r.tag)
  }
  return out
}

/**
 * Clasifica a partir de los mensajes del CLIENTE (en orden). Determinista.
 */
export function clasificarCasuistica(mensajesCliente: string[]): Casuistica {
  const msgs = (mensajesCliente || [])
    .map((m) => normalizarTexto(m))
    // Las descripciones de imágenes van como mensaje del cliente: se leen igual.
    .filter((m) => m && m !== "__image__")
  if (!msgs.length) return PROSPECTO
  const texto = msgs.join(" \n ")

  // 1) Quien claramente NO es prospecto (empleo, ex empleado, spam, consulta ajena, otro hardware).
  for (const bloque of SENAL_NO_PROSPECTO) {
    const h = hits(bloque.reglas, texto, msgs)
    if (!h.length) continue
    // Una consulta laboral suelta de alguien que además quiere cotizar es pre-venta.
    if (bloque.tipo === "consulta_ajena" && /\b(cotizar|cotizacion|presupuesto|contratar|control de asistencia|marcaje|marcacion)\b/.test(texto)) continue
    return { tipo: bloque.tipo, esProspecto: false, vende: false, motivoZoho: MOTIVO_ZOHO[bloque.tipo], evidencia: h }
  }

  const cliente = hits(SENAL_CLIENTE, texto, msgs)
  const trabajador = hits(SENAL_TRABAJADOR, texto, msgs)
  const soporte = hits(SENAL_SOPORTE, texto, msgs)
  const admin = hits(SENAL_ADMINISTRATIVA, texto, msgs)
  const capacitacion = hits(SENAL_CAPACITACION, texto, msgs)
  const ampliacion = hits(SENAL_AMPLIACION, texto, msgs)

  // 2) Trabajador de una empresa cliente: jamás es venta.
  const trabajadorFuerte = trabajador.filter((t) => !/jefe|numero/.test(t))
  if (trabajador.length && (cliente.length || soporte.length || trabajador.length >= 2 || (trabajadorFuerte.length && !INTENCION_COMPRA.test(texto)) || /\b(geovictoria|geo victoria|victoria)\b/.test(texto))) {
    return { tipo: "trabajador_cliente", esProspecto: false, vende: false, motivoZoho: MOTIVO_ZOHO.trabajador_cliente, evidencia: [...trabajador, ...soporte] }
  }

  // 3) Gestión administrativa: baja, factura, contrato, NDA, API. Estas frases
  //    solo las dice alguien que YA tiene el servicio (aunque no lo declare).
  const adminFuerte = admin.filter((t) => /baja|contrato|cobranza|copia|ejecutivo/.test(t))
  if (adminFuerte.length || (admin.length && cliente.length)) {
    return { tipo: "cliente_administrativo", esProspecto: false, vende: false, motivoZoho: MOTIVO_ZOHO.cliente_administrativo, evidencia: [...cliente, ...admin] }
  }

  if (cliente.length) {
    // 4) Cliente que quiere comprar más: VENTA (precio al tiro, Lalo 07-sep).
    const soporteFuerteCliente = soporte.filter((t) => !/manual|ticket/.test(t))
    if (ampliacion.length && (!soporteFuerteCliente.length || INTENCION_COMPRA.test(texto))) {
      return { tipo: "cliente_ampliacion", esProspecto: true, vende: true, motivoZoho: null, evidencia: [...cliente, ...ampliacion] }
    }
    if (capacitacion.length && !soporte.length) {
      return { tipo: "cliente_capacitacion", esProspecto: false, vende: false, motivoZoho: MOTIVO_ZOHO.cliente_capacitacion, evidencia: [...cliente, ...capacitacion] }
    }
    return { tipo: "cliente_soporte", esProspecto: false, vende: false, motivoZoho: MOTIVO_ZOHO.cliente_soporte, evidencia: [...cliente, ...soporte] }
  }

  // 5) Sin declararse cliente pero con problema de uso claro y sin intención de
  //    compra: es alguien que ya usa la plataforma (trabajador o admin).
  const soporteFuerte = soporte.filter((t) => !/manual|ticket/.test(t))
  if (soporteFuerte.length && !INTENCION_COMPRA.test(texto)) {
    const tipo: TipoCasuistica = trabajador.length ? "trabajador_cliente" : "cliente_soporte"
    return { tipo, esProspecto: false, vende: false, motivoZoho: MOTIVO_ZOHO[tipo], evidencia: [...trabajador, ...soporte] }
  }
  if (soporte.length >= 2 && !INTENCION_COMPRA.test(texto)) {
    return { tipo: "cliente_soporte", esProspecto: false, vende: false, motivoZoho: MOTIVO_ZOHO.cliente_soporte, evidencia: soporte }
  }

  return PROSPECTO
}

export const MOTIVO_ZOHO: Record<TipoCasuistica, string | null> = {
  prospecto: null,
  cliente_ampliacion: null,
  trabajador_cliente: "Es un usuario",
  cliente_soporte: "Es un usuario",
  cliente_administrativo: "Es un usuario",
  cliente_capacitacion: "Es un usuario",
  busca_empleo: "Busca empleo",
  ex_empleado: "Otro",
  consulta_ajena: "Otro",
  otro_hardware: "Quiere otro tipo de hardware (que no vendemos)",
  spam: "SPAM (Publicidad-Virus)",
}

/** Motivo de cierre del loop / etiqueta corta para logs. */
export function motivoCierreLoop(c: Casuistica): string {
  if (c.esProspecto) return ""
  return c.tipo === "spam" || c.tipo === "busca_empleo" || c.tipo === "ex_empleado" || c.tipo === "consulta_ajena" || c.tipo === "otro_hardware"
    ? "no_prospecto"
    : "cliente_existente"
}

/**
 * Directiva para el prompt de Vicky según la casuística (va al FINAL del
 * system prompt, en el contexto inmediato — la regla general del prompt
 * pierde contra la inercia del historial).
 */
export function directivaCasuistica(c: Casuistica): string {
  const base = "\n\n[CASUÍSTICA DEL CONTACTO — obligatoria] "
  switch (c.tipo) {
    case "trabajador_cliente":
      return (
        base +
        "Quien escribe es un TRABAJADOR de una empresa que ya usa GeoVictoria y tiene un problema de uso (marcación, acceso, clave, app). NO es una venta: " +
        "no le pidas nombre/empresa/correo \"para registrarlo\", no cotices, no lo derives a un ejecutivo comercial ni prometas que \"un ejecutivo lo llamará\". " +
        "Tu única acción es consultar_agente_soporte con su mensaje literal y entregar lo que devuelva; si el problema es de habilitación, clave o correo, " +
        "explícale además que el ADMINISTRADOR de su empresa en GeoVictoria es quien lo habilita o corrige sus datos. Trátalo con calidez y sin vender."
      )
    case "cliente_soporte":
      return (
        base +
        "Quien escribe ya es CLIENTE (o usa la plataforma) y trae un problema operativo. NO es venta: no cotices, no pidas datos para registrarlo, " +
        "no lo derives a calificación ni a un ejecutivo comercial. Invoca consultar_agente_soporte con su mensaje literal y pega la respuesta; si el agente escala, " +
        "entrega los canales oficiales que devuelva. Solo si pide EXPLÍCITAMENTE comprar más (usuarios, otro reloj, tarjetas) cotízalo como cliente actual."
      )
    case "cliente_administrativo":
      return (
        base +
        "Quien escribe ya es CLIENTE y trae una gestión ADMINISTRATIVA (baja del servicio, factura/cobranza, copia de contrato, confidencialidad de datos, API). " +
        "NO es venta y NO es prospecto: no cotices, no pidas datos \"para registrarlo\", no ofrezcas descuentos ni lo derives a un ejecutivo comercial. " +
        "Invoca consultar_agente_soporte con su mensaje literal para que el equipo de postventa lo tome y entrega los canales que devuelva; toma nota de su razón social y RUT si los da. " +
        "Sé breve y cordial; jamás intentes retenerlo con argumentos de venta."
      )
    case "cliente_capacitacion":
      return (
        base +
        "Quien escribe ya es CLIENTE y pide CAPACITACIÓN sobre la plataforma. NO es venta: no cotices ni lo trates como prospecto. " +
        "Invoca consultar_agente_soporte con su mensaje literal (el equipo de soporte/implementación coordina las capacitaciones) y entrega lo que devuelva."
      )
    case "cliente_ampliacion":
      return (
        base +
        "Quien escribe ya es CLIENTE y quiere AMPLIAR o comprar algo más (más usuarios, otro reloj, tarjetas, instalación). ES VENTA: dale el precio de inmediato con la tool " +
        "y luego pasa el caso al equipo con el precio ya dicho (Lalo 07-sep). No lo mandes a soporte ni le pidas datos antes de darle el valor."
      )
    case "busca_empleo":
      return (
        base +
        "Quien escribe BUSCA TRABAJO, no es un cliente ni un prospecto. Responde una sola vez, con amabilidad: este canal es comercial y no gestiona postulaciones; " +
        "sugiérele revisar las ofertas de GeoVictoria en LinkedIn o el sitio web. No pidas datos, no cotices, no derives, no prometas contacto."
      )
    case "ex_empleado":
      return (
        base +
        "Quien escribe es un EX TRABAJADOR de GeoVictoria con un tema laboral propio (finiquito u otro). No es cliente ni prospecto: responde una vez, cordial, " +
        "que este canal es comercial y que su tema debe verlo directamente con Recursos Humanos de GeoVictoria por correo. No pidas datos ni cotices."
      )
    case "consulta_ajena":
      return (
        base +
        "Quien escribe hace una consulta LABORAL o legal ajena a comprar (cuánto se paga un domingo, recargos, sueldo mínimo). No es prospecto: responde breve y honesta " +
        "que no puedes asesorar en eso y que lo confirme con un contador o la autoridad laboral; menciona en UNA línea que si algún día necesita control de asistencia " +
        "aquí estás. No pidas datos ni derives."
      )
    case "otro_hardware":
      return (
        base +
        "Quien escribe busca algo que NO vendemos (accesorios para un sistema de otro proveedor, control de consumos de comedor u otro producto ajeno). " +
        "Dilo derecho y con amabilidad, sin inventar alternativas ni prometer que \"un ejecutivo lo evaluará\". No pidas datos ni cotices."
      )
    case "spam":
      return base + "Este contacto es publicidad, cadena o contenido ajeno. Responde con una línea cortés y cierra; no pidas datos, no cotices, no derives."
    default:
      return ""
  }
}
