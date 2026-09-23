/**
 * FICHA OPERATIVA POR PAÍS — la ÚNICA fuente de los datos de OPERACIÓN que
 * cambian de un país a otro (23-sep, orden de Lalo: "todo lo que estamos
 * haciendo apunta a que no tengamos que volver a hacerlo cuando levantemos un
 * nuevo país; me debes dar la ficha para completar y que se asuma que toda la
 * operación será igual en todos los países").
 *
 * La operación es UNA (los mismos crons, cinturones, relojes, alarmas y
 * registro de pagos para los cuatro países); lo que cambia es el DATO. Hasta
 * hoy esos datos vivían repartidos: la cuenta bancaria en lib/aviso-banco, el
 * roster de telemarketing en lib/gestion-venta, las SDR peruanas en tres
 * archivos con el mismo default, la zona horaria de cada cron en su route. Un
 * país nuevo obligaba a encontrarlos todos. Desde acá se levanta uno
 * llenando UNA ficha; lo que falte queda declarado en `pendientes` y el
 * endpoint `vic-admin-ficha-operativa` lo muestra.
 *
 * PURO: sin red, sin Supabase, sin imports. Cargable por node --test. Los
 * envs que ya existían (VICKY_TLMK_ACTIVIDAD, VIC_SDR_INBOUND_PE,
 * VICKY_ESPEJO_SESIONES_EXTRA…) siguen valiendo como OVERRIDE en cada
 * consumidor; la ficha es el default y la verdad declarada.
 *
 * QUÉ NO VA ACÁ: precios, catálogo, prompt y documento tributario del CLIENTE
 * viven en `lib/paises/<cc>/` (perfil comercial) y en `lib/prompt-nucleo`
 * (ficha del prompt). Esta es la ficha de la OPERACIÓN: nuestra entidad,
 * nuestras cuentas, los bancos que nos avisan, nuestra gente y sus sesiones
 * de espejo, la moneda en que se registra el pago, la zona horaria de los
 * toques.
 */

export type CodigoPaisOperativo = "cl" | "pe" | "co" | "mx"

export type CuentaBancaria = {
  banco: string
  tipo: string
  /** Como se le muestra al cliente (con guiones). */
  numero: string
  /** Código interbancario cuando existe (CCI en Perú, CLABE en México). */
  interbancario?: string
  moneda: string
  titular: string
}

/** Un banco que manda avisos de transferencia o aparece en comprobantes. */
export type BancoAviso = {
  /** id estable (va a la nota y al nombre del adjunto): "bancochile", "bbva"… */
  id: string
  /** Dominios del remitente del aviso. */
  dominios: RegExp
  /** Cómo se nombra en el cuerpo del correo o en la línea "Banco:" de un comprobante. */
  nombres: RegExp
}

export type PersonaEquipo = {
  email: string
  zohoId: string
  nombre: string
  /** Sesión del worker de espejos (default: parte local del correo). */
  sesion: string
  telefono?: string
}

export type FichaOperativa = {
  pais: CodigoPaisOperativo
  nombre: string
  /** Prefijo telefónico, solo dígitos. */
  prefijo: string
  /** Largo del celular sin prefijo (para reconocer un teléfono del país). */
  digitosCelular: number
  tz: string
  /** Offsets UTC posibles del país (para fechar avisos sin zona). */
  offsets: string[]
  moneda: { codigo: string; simbolo: string; decimales: number; locale: string; nombre: string }
  impuesto: { nombre: string; pct: number }
  /** Documento tributario de la EMPRESA cliente: cómo se llama y qué forma tiene. */
  documento: { etiqueta: string; patron: RegExp; ejemplo: string }
  entidad: {
    razonSocial: string
    identificador: string
    /** Solo dígitos del identificador, para saltarlo cuando un aviso lo imprime como destino. */
    identificadorDigitos: string
    /** Cómo aparece nuestro nombre en un aviso ("Victoria S.A", "GEOVICTORIA PERU"). */
    alias: RegExp
  }
  cuentas: CuentaBancaria[]
  bancos: BancoAviso[]
  /** Tolerancia del cruce monto-del-aviso vs pago inicial esperado, en moneda local. */
  toleranciaMonto: number
  equipo: {
    telemarketing: PersonaEquipo[]
    sdr: PersonaEquipo[]
    ventaAutonoma?: PersonaEquipo
    lider?: string
  }
  /** Ventana local de los toques proactivos (hora de inicio y fin). */
  horarioToques: { desde: number; hasta: number }
  /**
   * COPIA adicional del aviso interno de comprobante ("" = ninguna). NO es el
   * correo del comprobante: ese es SIEMPRE `CORREO_COMPROBANTE` (vicky@) en
   * los 4 países — Lalo 23-sep: "el correo para el comprobante siempre es el
   * de vicky, independiente el país". Chile conserva cobranza@ en copia porque
   * finanzas CL registra el pago desde ahí (03-ago).
   */
  cobranzaCc: string
  /** Lo que la ficha declara que FALTA para este país (texto para una persona). */
  pendientes: string[]
}

const persona = (email: string, zohoId: string, nombre: string, telefono?: string, sesion?: string): PersonaEquipo => ({
  email: email.toLowerCase(),
  zohoId,
  nombre,
  sesion: (sesion || email.split("@")[0]).toLowerCase(),
  ...(telefono ? { telefono } : {}),
})

const FICHA_CL: FichaOperativa = {
  pais: "cl",
  nombre: "Chile",
  prefijo: "56",
  digitosCelular: 9,
  tz: "America/Santiago",
  offsets: ["-03:00", "-04:00"],
  moneda: { codigo: "CLP", simbolo: "$", decimales: 0, locale: "es-CL", nombre: "pesos chilenos" },
  impuesto: { nombre: "IVA", pct: 19 },
  documento: { etiqueta: "RUT", patron: /^\d{7,8}-[\dkK]$/, ejemplo: "76.188.587-1" },
  entidad: {
    razonSocial: "Victoria S.A.",
    identificador: "76.188.587-1",
    identificadorDigitos: "761885871",
    alias: /victoria\s+s\.?\s*a\b|geo\s?victoria/i,
  },
  cuentas: [
    { banco: "Banco de Chile", tipo: "Cuenta corriente", numero: "8001204108", moneda: "CLP", titular: "Victoria S.A." },
  ],
  bancos: [
    { id: "bancochile", dominios: /bancochile\.cl|bancodechile\.cl|bch\./i, nombres: /banco de chile|bancochile|fonobank/i },
    { id: "bci", dominios: /\bbci\.cl/i, nombres: /\bBci\b|BancoBci|Banco de Credito e Inversiones/i },
    { id: "santander", dominios: /santander\.cl/i, nombres: /santander/i },
    { id: "bancoestado", dominios: /bancoestado\.cl/i, nombres: /banco\s*estado/i },
    { id: "scotiabank", dominios: /scotiabank\.cl/i, nombres: /scotiabank/i },
    { id: "itau", dominios: /itau\.cl/i, nombres: /ita[uú]/i },
  ],
  toleranciaMonto: 1500,
  equipo: {
    // ids verificados en Zoho el 10-sep; la sesión de espejo es la parte local del correo.
    telemarketing: [
      persona("emujica@geovictoria.com", "3525045000000211283", "Eddyluz Mujica"),
      persona("adiazg@geovictoria.com", "3525045000426432190", "Anderson Díaz"),
      persona("tmartinezq@geovictoria.com", "3525045000223766001", "Tamara Martínez"),
      persona("alopez@geovictoria.com", "3525045000126464001", "Ana Paula López"),
      persona("pdiaz@geovictoria.com", "3525045000000211651", "Paola Díaz"),
      persona("dgalvez@geovictoria.com", "3525045000124240013", "Daniela Gálvez"),
      persona("gmelendez@geovictoria.com", "3525045000146108001", "Grey Meléndez"),
    ],
    sdr: [
      persona("aaraque@geovictoria.com", "3525045000583802005", "Aleydis Araque", "+56 9 8291 6868"),
      persona("asepulveda@geovictoria.com", "", "Aracelli Sepúlveda", "+56 9 3212 5672"),
    ],
    ventaAutonoma: persona("aaraque@geovictoria.com", "3525045000583802005", "Aleydis Araque", "+56 9 8291 6868"),
    lider: "vluna@geovictoria.com",
  },
  horarioToques: { desde: 9, hasta: 21 },
  cobranzaCc: "cobranza@geovictoria.com",
  pendientes: [],
}

const FICHA_PE: FichaOperativa = {
  pais: "pe",
  nombre: "Perú",
  prefijo: "51",
  digitosCelular: 9,
  tz: "America/Lima",
  offsets: ["-05:00"],
  moneda: { codigo: "PEN", simbolo: "S/", decimales: 2, locale: "es-PE", nombre: "soles" },
  impuesto: { nombre: "IGV", pct: 18 },
  documento: { etiqueta: "RUC", patron: /^\d{11}$/, ejemplo: "20605842055" },
  entidad: {
    razonSocial: "GEOVICTORIA PERU S.A.C.",
    identificador: "20605842055",
    identificadorDigitos: "20605842055",
    alias: /geo\s?victoria\s+peru|geo\s?victoria/i,
  },
  cuentas: [
    { banco: "BBVA", tipo: "Cuenta corriente", numero: "0011-0123-0100091134-75", interbancario: "011-123-000100091134-75", moneda: "PEN", titular: "GEOVICTORIA PERU S.A.C." },
    { banco: "BBVA", tipo: "Cuenta corriente", numero: "0011-0357-0100049025-18", interbancario: "011-357-000100049025-18", moneda: "USD", titular: "GEOVICTORIA PERU S.A.C." },
    { banco: "Banco de la Nación", tipo: "Detracciones", numero: "00022055488", moneda: "PEN", titular: "GEOVICTORIA PERU S.A.C." },
  ],
  bancos: [
    { id: "bbva", dominios: /bbva\.pe|bbva\.com/i, nombres: /\bbbva\b/i },
    { id: "bcp", dominios: /viabcp\.com|bcp\.com\.pe/i, nombres: /\bbcp\b|banco de cr[eé]dito del per[uú]/i },
    { id: "interbank", dominios: /interbank\.pe|interbank\.com\.pe/i, nombres: /interbank/i },
    { id: "scotiabank_pe", dominios: /scotiabank\.com\.pe/i, nombres: /scotiabank/i },
    { id: "bancodelanacion", dominios: /bn\.com\.pe/i, nombres: /banco de la naci[oó]n/i },
    { id: "yape", dominios: /yape\.com\.pe/i, nombres: /\byape\b/i },
    { id: "plin", dominios: /plin\.pe/i, nombres: /\bplin\b/i },
  ],
  toleranciaMonto: 2,
  equipo: {
    telemarketing: [persona("mmendozav@geovictoria.com", "3525045000323383015", "Mónica Mendoza", "+51 962 277 502")],
    sdr: [
      persona("afiori@geovictoria.com", "3525045000299130001", "Ana Fiori", "+51 936 953 838"),
      persona("pquispef@geovictoria.com", "3525045000576828001", "Priscila Quispe", "+51 960 421 293"),
    ],
    ventaAutonoma: persona("cvalverde@geovictoria.com", "3525045000521799149", "Cecilia Valverde", "+51 982 446 284"),
    lider: "dbendezu@geovictoria.com",
  },
  horarioToques: { desde: 9, hasta: 21 },
  cobranzaCc: "",
  pendientes: [
    "Sesiones de espejo del equipo en el worker (WA_SESSION_IDS en Railway): mmendozav, afiori, pquispef, cvalverde.",
    "Un aviso REAL de BBVA/BCP/Interbank en la casilla vicky@ para calibrar el parser (hoy formato genérico).",
  ],
}

const FICHA_CO: FichaOperativa = {
  pais: "co",
  nombre: "Colombia",
  prefijo: "57",
  digitosCelular: 10,
  tz: "America/Bogota",
  offsets: ["-05:00"],
  moneda: { codigo: "COP", simbolo: "$", decimales: 0, locale: "es-CO", nombre: "pesos colombianos" },
  impuesto: { nombre: "IVA", pct: 19 },
  documento: { etiqueta: "NIT", patron: /^\d{9,10}(-\d)?$/, ejemplo: "901367959-1" },
  entidad: {
    razonSocial: "GEOVICTORIA COLOMBIA SAS",
    identificador: "901367959",
    identificadorDigitos: "901367959",
    alias: /geo\s?victoria\s+colombia|geo\s?victoria/i,
  },
  cuentas: [
    { banco: "Bancolombia", tipo: "Cuenta de ahorros", numero: "20200000237", moneda: "COP", titular: "GEOVICTORIA COLOMBIA SAS" },
  ],
  bancos: [
    { id: "bancolombia", dominios: /bancolombia\.com/i, nombres: /bancolombia/i },
    { id: "nequi", dominios: /nequi\.com/i, nombres: /\bnequi\b/i },
    { id: "davivienda", dominios: /davivienda\.com/i, nombres: /davivienda/i },
    { id: "bbva_co", dominios: /bbva\.com\.co/i, nombres: /\bbbva\b/i },
  ],
  toleranciaMonto: 1000,
  equipo: {
    telemarketing: [persona("agordillo@geovictoria.com", "3525045000203758005", "Alejandro Gordillo", "+57 314 267 7765")],
    sdr: [persona("egalindo@geovictoria.com", "3525045000613817111", "Eddy Galindo")],
    lider: "",
  },
  horarioToques: { desde: 9, hasta: 21 },
  cobranzaCc: "",
  pendientes: [
    "Gestor/a de la venta autónoma (quién se queda con la venta que cierra Vicky sola).",
    "Líder comercial (recibe alertas de espejos y traspasos).",
    "Sesiones de espejo del equipo en el worker (agordillo, egalindo).",
    "Confirmar que la transferencia a Bancolombia se acepta como medio de pago (hoy el cotizador CO cobra solo con tarjeta).",
  ],
}

const FICHA_MX: FichaOperativa = {
  pais: "mx",
  nombre: "México",
  prefijo: "52",
  digitosCelular: 10,
  tz: "America/Mexico_City",
  offsets: ["-06:00", "-05:00"],
  moneda: { codigo: "MXN", simbolo: "$", decimales: 2, locale: "es-MX", nombre: "pesos mexicanos" },
  impuesto: { nombre: "IVA", pct: 16 },
  documento: { etiqueta: "RFC", patron: /^[A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3}$/i, ejemplo: "CEC2005286R4" },
  entidad: {
    razonSocial: "CHECADOR, S.A. de C.V.",
    identificador: "CEC2005286R4",
    identificadorDigitos: "2005286",
    alias: /checador|geo\s?victoria/i,
  },
  cuentas: [
    { banco: "BANORTE", tipo: "Cuenta", numero: "1161438886", interbancario: "072180011614388864", moneda: "MXN", titular: "CHECADOR, S.A. de C.V." },
  ],
  bancos: [
    { id: "banorte", dominios: /banorte\.com/i, nombres: /banorte/i },
    { id: "bbva_mx", dominios: /bbva\.mx/i, nombres: /\bbbva\b/i },
    { id: "santander_mx", dominios: /santander\.com\.mx/i, nombres: /santander/i },
    { id: "banamex", dominios: /banamex\.com|citibanamex/i, nombres: /banamex/i },
  ],
  toleranciaMonto: 20,
  equipo: {
    telemarketing: [persona("ysegura@geovictoria.com", "3525045000308323003", "Yahel Segura", "+52 55 3763 6604")],
    sdr: [],
    lider: "",
  },
  horarioToques: { desde: 9, hasta: 21 },
  cobranzaCc: "",
  pendientes: [
    "Roster SDR Inbound México (emails + ids de Zoho) para la rotación de leads.",
    "Gestor/a de la venta autónoma.",
    "Líder comercial.",
    "Sesiones de espejo del equipo en el worker (ysegura).",
  ],
}

const FICHAS: Record<CodigoPaisOperativo, FichaOperativa> = { cl: FICHA_CL, pe: FICHA_PE, co: FICHA_CO, mx: FICHA_MX }

export const PAISES_OPERATIVOS: CodigoPaisOperativo[] = ["cl", "pe", "co", "mx"]

/**
 * El correo al que el cliente manda el comprobante y donde el banco avisa la
 * transferencia: UNO para los cuatro países (Lalo 23-sep, "independiente el
 * país"). Es la casilla que Power Automate lee y el agente registra solo
 * (`vic-correo-entrante`); el cotizador lo muestra en el modal de transferencia
 * (`TRANSFER_CONTACT_EMAIL`). Un país nuevo NO define correo de finanzas.
 */
export const CORREO_COMPROBANTE = "vicky@geovictoria.com"

export function fichaOperativa(pais: string | null | undefined): FichaOperativa {
  const k = String(pais || "").toLowerCase() as CodigoPaisOperativo
  return FICHAS[k] || FICHA_CL
}

export function todasLasFichas(): FichaOperativa[] {
  return PAISES_OPERATIVOS.map((p) => FICHAS[p])
}

/** País de un teléfono por prefijo (solo dígitos); null si no calza ninguno. */
export function paisDeTelefonoOperativo(fono: string | null | undefined): CodigoPaisOperativo | null {
  const d = String(fono || "").replace(/\D/g, "")
  if (!d) return null
  for (const f of todasLasFichas()) {
    if (d.startsWith(f.prefijo) && d.length === f.prefijo.length + f.digitosCelular) return f.pais
  }
  for (const f of todasLasFichas()) if (d.startsWith(f.prefijo)) return f.pais
  return null
}

/** Ficha del país de un teléfono; Chile si el prefijo no se reconoce. */
export function fichaPorTelefono(fono: string | null | undefined): FichaOperativa {
  return fichaOperativa(paisDeTelefonoOperativo(fono) || "cl")
}

function soloDigitos(s: string): string {
  return String(s || "").replace(/\D/g, "")
}

/** Todas nuestras cuentas (número e interbancario) en dígitos, con su país. */
export function cuentasNuestras(): Array<{ pais: CodigoPaisOperativo; digitos: string; cuenta: CuentaBancaria }> {
  const out: Array<{ pais: CodigoPaisOperativo; digitos: string; cuenta: CuentaBancaria }> = []
  for (const f of todasLasFichas()) {
    for (const c of f.cuentas) {
      out.push({ pais: f.pais, digitos: soloDigitos(c.numero).replace(/^0+/, ""), cuenta: c })
      if (c.interbancario) out.push({ pais: f.pais, digitos: soloDigitos(c.interbancario).replace(/^0+/, ""), cuenta: c })
    }
  }
  return out.filter((x) => x.digitos.length >= 6)
}

/** Identificadores tributarios NUESTROS (dígitos), para no tomarlos como ordenante. */
export function identificadoresNuestros(): Set<string> {
  return new Set(todasLasFichas().map((f) => f.entidad.identificadorDigitos).filter(Boolean))
}

/** Todos los bancos conocidos con su país (los de Chile primero: son los que más avisan). */
export function bancosConocidos(): Array<{ pais: CodigoPaisOperativo; banco: BancoAviso }> {
  const out: Array<{ pais: CodigoPaisOperativo; banco: BancoAviso }> = []
  for (const f of todasLasFichas()) for (const b of f.bancos) out.push({ pais: f.pais, banco: b })
  return out
}

/**
 * ¿El texto de un aviso va dirigido a NOSOTROS? Devuelve el país de la cuenta
 * que calzó (o el país de la ficha cuyo alias aparece), null si no.
 */
export function destinoNuestroEn(texto: string, cuentaDestino?: string): CodigoPaisOperativo | null {
  const t = String(texto || "")
  const dTexto = soloDigitos(t)
  const dCuenta = soloDigitos(cuentaDestino || "").replace(/^0+/, "")
  for (const c of cuentasNuestras()) {
    if ((dCuenta && dCuenta === c.digitos) || dTexto.includes(c.digitos)) return c.pais
  }
  // Alias: primero los específicos (GEOVICTORIA PERU, COLOMBIA, CHECADOR), al
  // final el genérico de Chile ("geo victoria" pelado también calza ahí).
  for (const f of [FICHA_PE, FICHA_CO, FICHA_MX]) {
    const especifico = f.entidad.alias.source.split("|")[0]
    if (new RegExp(especifico, "i").test(t)) return f.pais
  }
  if (FICHA_CL.entidad.alias.test(t)) return "cl"
  return null
}

/** País sugerido por el SÍMBOLO de moneda que acompaña al monto ("S/ 118" → pe). */
export function paisPorSimboloMoneda(montoConSimbolo: string): CodigoPaisOperativo | null {
  const s = String(montoConSimbolo || "")
  if (/S\/\.?\s*\d/i.test(s) || /\bPEN\b|\bsoles\b/i.test(s)) return "pe"
  if (/\bCOP\b/i.test(s)) return "co"
  if (/\bMXN\b|MX\$/i.test(s)) return "mx"
  if (/\bCLP\b/i.test(s)) return "cl"
  return null
}

/** Monto en la moneda del país, como se escribe en notas y avisos. */
export function formatearMontoOperativo(monto: number, pais: string | null | undefined): string {
  const f = fichaOperativa(pais)
  const n = Number(monto) || 0
  const txt = n.toLocaleString(f.moneda.locale, { minimumFractionDigits: f.moneda.decimales, maximumFractionDigits: f.moneda.decimales })
  return f.moneda.simbolo === "$" ? `$${txt}` : `${f.moneda.simbolo} ${txt}`
}

/**
 * Convierte el texto de un monto a número según el país. Chile no usa
 * decimales ("$ 36,459" son treinta y seis mil); Perú y México sí ("S/ 118.00").
 * Regla: si hay DOS separadores distintos, el último es el decimal; si hay
 * UNO y va seguido de exactamente 2 dígitos (y el país tiene decimales), es
 * decimal; si no, es de miles.
 */
export function parsearMontoOperativo(txt: string, pais: string | null | undefined): number {
  const f = fichaOperativa(pais)
  const s = String(txt || "").replace(/[^\d.,]/g, "")
  if (!s) return 0
  if (f.moneda.decimales === 0) return Number(s.replace(/\D/g, "")) || 0
  const puntos = (s.match(/\./g) || []).length
  const comas = (s.match(/,/g) || []).length
  let entero = s
  let dec = ""
  if (puntos && comas) {
    const ultimo = Math.max(s.lastIndexOf("."), s.lastIndexOf(","))
    entero = s.slice(0, ultimo)
    dec = s.slice(ultimo + 1)
  } else if (puntos + comas === 1) {
    const sep = puntos ? "." : ","
    const i = s.lastIndexOf(sep)
    const cola = s.slice(i + 1)
    if (cola.length === 2) { entero = s.slice(0, i); dec = cola }
  }
  const n = Number(`${entero.replace(/\D/g, "")}.${dec.replace(/\D/g, "") || "0"}`)
  return Number.isFinite(n) ? n : 0
}

/* ── Equipo ─────────────────────────────────────────────────────────────── */

/** Telemarketing de TODOS los países (o de uno): los únicos cuya actividad hace ASISTIDA una venta. */
export function rosterTelemarketingOperativo(pais?: string): PersonaEquipo[] {
  const fichas = pais ? [fichaOperativa(pais)] : todasLasFichas()
  return fichas.flatMap((f) => f.equipo.telemarketing)
}

export function rosterSdrOperativo(pais?: string): PersonaEquipo[] {
  const fichas = pais ? [fichaOperativa(pais)] : todasLasFichas()
  return fichas.flatMap((f) => f.equipo.sdr)
}

/** Toda la gente comercial declarada (telemarketing + SDR + venta autónoma), sin duplicar. */
export function equipoOperativo(pais?: string): Array<PersonaEquipo & { pais: CodigoPaisOperativo; rol: "telemarketing" | "sdr" | "venta_autonoma" }> {
  const fichas = pais ? [fichaOperativa(pais)] : todasLasFichas()
  const vistos = new Set<string>()
  const out: Array<PersonaEquipo & { pais: CodigoPaisOperativo; rol: "telemarketing" | "sdr" | "venta_autonoma" }> = []
  for (const f of fichas) {
    const push = (p: PersonaEquipo | undefined, rol: "telemarketing" | "sdr" | "venta_autonoma") => {
      if (!p || vistos.has(p.email)) return
      vistos.add(p.email)
      out.push({ ...p, pais: f.pais, rol })
    }
    f.equipo.telemarketing.forEach((p) => push(p, "telemarketing"))
    f.equipo.sdr.forEach((p) => push(p, "sdr"))
    push(f.equipo.ventaAutonoma, "venta_autonoma")
  }
  return out
}

/** Sesiones de espejo que DEBERÍAN existir en el worker (todo el equipo comercial declarado). */
export function sesionesEspejoOperativas(pais?: string): string[] {
  return Array.from(new Set(equipoOperativo(pais).map((p) => p.sesion).filter(Boolean)))
}

export function personaPorEmail(email: string): (PersonaEquipo & { pais: CodigoPaisOperativo }) | null {
  const e = String(email || "").toLowerCase().trim()
  if (!e) return null
  return equipoOperativo().find((p) => p.email === e) || null
}

/** Roster en el formato "email:zohoId:Nombre,…" que consumen los envs viejos. */
export function rosterComoEnv(personas: PersonaEquipo[]): string {
  return personas.map((p) => `${p.email}:${p.zohoId}:${p.nombre}`).join(",")
}

/** Foto de la ficha para una persona (endpoint admin y la plantilla que se le pasa a Lalo). */
export function resumenFicha(f: FichaOperativa): Record<string, unknown> {
  return {
    pais: f.pais,
    nombre: f.nombre,
    prefijo: `+${f.prefijo}`,
    tz: f.tz,
    moneda: `${f.moneda.codigo} (${f.moneda.simbolo}, ${f.moneda.decimales} decimales)`,
    impuesto: `${f.impuesto.nombre} ${f.impuesto.pct}%`,
    documentoCliente: `${f.documento.etiqueta} (ej. ${f.documento.ejemplo})`,
    entidad: `${f.entidad.razonSocial} · ${f.entidad.identificador}`,
    cuentas: f.cuentas.map((c) => `${c.banco} ${c.tipo} ${c.numero}${c.interbancario ? ` (${c.interbancario})` : ""} ${c.moneda}`),
    bancosQueAvisan: f.bancos.map((b) => b.id),
    toleranciaMonto: formatearMontoOperativo(f.toleranciaMonto, f.pais),
    telemarketing: f.equipo.telemarketing.map((p) => `${p.nombre} <${p.email}> espejo:${p.sesion}`),
    sdr: f.equipo.sdr.map((p) => `${p.nombre} <${p.email}> espejo:${p.sesion}`),
    ventaAutonoma: f.equipo.ventaAutonoma ? `${f.equipo.ventaAutonoma.nombre} <${f.equipo.ventaAutonoma.email}>` : "(sin definir)",
    lider: f.equipo.lider || "(sin definir)",
    horarioToques: `${f.horarioToques.desde}:00–${f.horarioToques.hasta}:00 ${f.tz}`,
    correoComprobante: CORREO_COMPROBANTE,
    copiaAvisoComprobante: f.cobranzaCc || "(ninguna)",
    pendientes: f.pendientes,
  }
}
