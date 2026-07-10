/**
 * Contrato del PERFIL DE PAÍS — la unidad de escalamiento internacional de Vicky.
 *
 * Principios (decisión de arquitectura, jul-2026):
 *   1. El país de una conversación lo define la LÍNEA de WhatsApp por la que
 *      llegó (cada línea Botmaker apunta a su propia ruta HTTP), NUNCA el
 *      prefijo del teléfono del cliente. El prefijo solo asesora (guard de
 *      outbound, señal para derivar).
 *   2. Un solo código, N perfiles: el handler del webhook, las tools y los
 *      crons son compartidos; TODO lo país-específico vive acá como datos.
 *   3. El prompt se ensambla por conversación con el bloque de UN solo país:
 *      el modelo nunca ve catálogos/monedas de otros países en su contexto
 *      (anti-alucinación estructural, no conductual).
 *   4. Los precios siempre salen de tools que leen el catálogo del perfil —
 *      nunca de la memoria del modelo (regla dura ya vigente en Chile).
 *
 * País nuevo = una carpeta `lib/paises/<codigo>/` + una ruta delgada
 * `app/api/vic-botmaker-<codigo>/` + flow y acción de código propios en
 * Botmaker + (si vende online) config del país en el cotizador.
 */

import type { ModuloSoftware, Hardware, Servicio } from "../catalogo/tipos"

export type CodigoPais = "cl" | "co" | "mx" | "pe"

/** Resultado de validar un identificador tributario (RUT, NIT, RFC, RUC…). */
export type ValidacionTributaria = {
  valido: boolean
  /** Identificador normalizado para persistir (ej. "76340729-2", "900123456-7"). */
  normalizado: string
  /** Nombre local del identificador para hablarle al cliente ("RUT", "NIT"…). */
  etiqueta: string
}

export type MonedaPais = {
  /** Código ISO ("CLP", "COP"). */
  codigo: string
  /** Cómo se enuncia un monto al cliente (ej. 315000 → "$315.000 COP"). */
  formatear: (monto: number) => string
  /**
   * Unidad indexada de cotización, si existe (Chile: UF). null = los precios
   * del catálogo están directamente en la moneda local y no se convierten.
   */
  unidadIndexada: null | {
    nombre: string
    /** Valor actual de la unidad en moneda local (ej. UF del día). */
    obtenerValor: () => Promise<number>
  }
}

export type CanalBotmaker = {
  /** channelId del canal en Botmaker (ej. "GeoVictoriaEspaol-whatsapp-56967308227"). */
  channelId: string
  /** Número de la línea, solo dígitos (para plantillas HSM / chatChannelNumber). */
  numeroLinea: string
  /** Plantillas HSM aprobadas para esta línea, por propósito. */
  templates: {
    leadApertura?: string
    leadNudge?: string
    leadCierre?: string
    reactivacionPreform?: string
    reactivacionCotizacion?: string
  }
}

export type EquipoComercial = {
  /** SDRs para round-robin de reasignación (email:zohoUserId). */
  sdrInbound: Array<{ email: string; zohoUserId: string }>
  /** Ejecutivo post-venta que acompaña las cotizaciones (sale en PDF/mails). */
  ejecutivo: { nombre: string; email: string; telefono: string }
}

export type PerfilPais = {
  codigo: CodigoPais
  nombre: string
  /** Prefijo telefónico del país, solo dígitos (guard de outbound). "56", "57". */
  prefijoTelefono: string
  /** Zona horaria IANA de referencia comercial ("America/Santiago", "America/Bogota"). */
  timezone: string

  moneda: MonedaPais
  validarTributario: (input: string) => ValidacionTributaria

  catalogo: {
    modulos: ModuloSoftware[]
    hardware: Hardware[]
    servicios: Servicio[]
  }

  /**
   * Bloques país-específicos que se INYECTAN al prompt compartido. El núcleo
   * (metodología de venta, guardrails, estilo, tools) es común a todos los
   * países; estos bloques son la única fuente de identidad/moneda/legal/geo.
   */
  promptBlocks: {
    /** Identidad: "Eres Vicky de GeoVictoria Colombia… precios en pesos colombianos…". */
    identidad: string
    /** Cómo se enuncian los precios (moneda, con/sin unidad indexada, IVA). */
    reglasDePrecio: string
    /** Geografía/zonas para envío-instalación, si el país vende hardware. */
    geografia: string
    /** Conocimiento legal/normativo local (Chile: certificación DT; CO: por definir). */
    legal: string
    /** Ajustes de registro/lenguaje local (qué evitar, cómo tratar al cliente). */
    lenguaje: string
  }

  /** Entidad legal local que emite las cotizaciones (encabezado del PDF). */
  entidadLegal: {
    razonSocial: string
    /** Identificador tributario con su etiqueta local (ej. "R.U.T: 76.188.587-1", "NIT: 901.367.959-1"). */
    idTributario: string
    direccion: string
    ciudad: string
  }

  canal: CanalBotmaker
  equipo: EquipoComercial

  /** true cuando el país puede generar cotización formal online (cotizador listo). */
  cotizadorHabilitado: boolean
}
