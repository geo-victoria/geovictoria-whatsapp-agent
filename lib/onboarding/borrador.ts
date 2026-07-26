/**
 * Borrador de onboarding: lo que Vicky va juntando por chat después del pago,
 * antes de crear la empresa.
 *
 * ES EL MODELO INTERNO, A PROPÓSITO. No copia el payload de la API de alta —
 * la traducción vive en un adaptador aparte (`payload.ts`). Motivo: el esquema
 * que pasó desarrollo (26-jul) es un boceto de chat y el endpoint todavía no
 * existe; cuando exista, los campos se van a mover. Con esta separación un
 * cambio de allá toca una función de mapeo y nada más — ni el prompt, ni las
 * tools, ni lo que Vicky ya le preguntó al cliente.
 *
 * Alcance deliberadamente chico: EMPRESA + UN ADMINISTRADOR. Es lo que crea la
 * cuenta. Trabajadores, turnos, planificaciones y asignaciones NO van acá —
 * son configuración, van después en el wizard web, y meterlos al chat sería
 * peor que el formulario (son colecciones N-a-N y una matriz visual).
 *
 * Módulo puro: sin red, sin Supabase, sin env. Todo lo de acá es testeable.
 */

import { rutValido, formatearRut } from "../rut.ts"
import { nitValido, normalizarNit } from "../paises/co/nit.ts"
import { rfcValido, normalizarRfc } from "../paises/mx/rfc.ts"

export type PaisOnboarding = "cl" | "co" | "mx"

/** Cómo se llama el identificador tributario en cada país, para hablarle al cliente. */
export const NOMBRE_IDENTIFICADOR: Record<PaisOnboarding, string> = {
  cl: "RUT",
  co: "NIT",
  mx: "RFC",
}

export type Borrador = {
  pais: PaisOnboarding
  empresa: {
    /** Razón social. */
    nombre?: string
    /** RUT / NIT / RFC según el país. */
    identificador?: string
  }
  admin: {
    nombre?: string
    apellido?: string
    /** Identificador personal del admin (en CL es su RUT). */
    identificador?: string
    email?: string
    /**
     * Código interno del cliente (SAP u otro). OPCIONAL de verdad: desarrollo
     * lo describió como "a veces tienen SAP o algo para manejar ids internos".
     * Vicky NO lo pregunta en el camino crítico — solo lo recoge si el cliente
     * menciona que maneja códigos propios.
     */
    idInterno?: string
  }
}

export function borradorVacio(pais: PaisOnboarding): Borrador {
  return { pais, empresa: {}, admin: {} }
}

// ── Validación ──────────────────────────────────────────────────────────────

export type Campo =
  | "empresa.nombre"
  | "empresa.identificador"
  | "admin.nombre"
  | "admin.apellido"
  | "admin.identificador"
  | "admin.email"

export type Problema = {
  campo: Campo
  /** Texto para que Vicky sepa qué repreguntar. No es para mostrar tal cual. */
  detalle: string
}

/** Etiquetas en español para armarle la pregunta al cliente. */
export const ETIQUETA: Record<Campo, string> = {
  "empresa.nombre": "razón social de la empresa",
  "empresa.identificador": "identificador de la empresa",
  "admin.nombre": "nombre del administrador",
  "admin.apellido": "apellido del administrador",
  "admin.identificador": "identificador del administrador",
  "admin.email": "correo del administrador",
}

// Validación de correo a propósito LAXA: exige estructura, no existencia. Un
// regex estricto rechaza direcciones reales (subdominios, TLD largos, guiones)
// y frena un alta legítima — la misma lección del NIT colombiano.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/

export function emailValido(email: string): boolean {
  const e = String(email || "").trim()
  return e.length <= 254 && EMAIL_RE.test(e)
}

/** true si el identificador es válido para el país (RUT / NIT / RFC). */
export function identificadorValido(valor: string, pais: PaisOnboarding): boolean {
  if (pais === "cl") return rutValido(valor)
  if (pais === "co") return nitValido(valor)
  return rfcValido(valor)
}

/** Identificador en el formato canónico del país; "" si no es válido. */
export function normalizarIdentificador(valor: string, pais: PaisOnboarding): string {
  if (!identificadorValido(valor, pais)) return ""
  if (pais === "cl") return formatearRut(valor)
  if (pais === "co") return normalizarNit(valor)
  return normalizarRfc(valor)
}

const vacio = (v?: string) => !String(v || "").trim()

/**
 * Todos los problemas del borrador: campos que faltan y campos presentes pero
 * mal. Se devuelven JUNTOS y en orden de conversación, para que Vicky pueda
 * pedir lo que falta de una vez en lugar de arrancarle un dato por mensaje.
 */
export function problemas(b: Borrador): Problema[] {
  const out: Problema[] = []
  const nombreId = NOMBRE_IDENTIFICADOR[b.pais]

  if (vacio(b.empresa.nombre)) out.push({ campo: "empresa.nombre", detalle: "falta" })

  if (vacio(b.empresa.identificador))
    out.push({ campo: "empresa.identificador", detalle: `falta el ${nombreId} de la empresa` })
  else if (!identificadorValido(b.empresa.identificador!, b.pais))
    out.push({ campo: "empresa.identificador", detalle: `${nombreId} inválido` })

  if (vacio(b.admin.nombre)) out.push({ campo: "admin.nombre", detalle: "falta" })
  // Apellido separado del nombre desde el origen: la API pide FirstName y
  // LastName aparte, y partir "María del Carmen Soto Vera" por espacios es
  // adivinar. Ese nombre es el que le aparece al cliente en su plataforma.
  if (vacio(b.admin.apellido)) out.push({ campo: "admin.apellido", detalle: "falta" })

  if (vacio(b.admin.identificador))
    out.push({ campo: "admin.identificador", detalle: `falta el ${nombreId} del administrador` })
  else if (!identificadorValido(b.admin.identificador!, b.pais))
    out.push({ campo: "admin.identificador", detalle: `${nombreId} inválido` })

  if (vacio(b.admin.email)) out.push({ campo: "admin.email", detalle: "falta" })
  else if (!emailValido(b.admin.email!))
    out.push({ campo: "admin.email", detalle: "correo con formato inválido" })

  return out
}

/** Campos que Vicky todavía tiene que pedir o corregir. */
export function camposPendientes(b: Borrador): Campo[] {
  return problemas(b).map((p) => p.campo)
}

export function borradorCompleto(b: Borrador): boolean {
  return problemas(b).length === 0
}

// ── Actualización desde las tools ───────────────────────────────────────────

export type DatosParciales = {
  empresa?: Partial<Borrador["empresa"]>
  admin?: Partial<Borrador["admin"]>
}

/**
 * Merge de lo que la tool extrajo del mensaje del cliente. Inmutable (devuelve
 * un borrador nuevo). Reglas:
 *  - un string con contenido SIEMPRE pisa el valor anterior (el cliente
 *    corrige: "no, el RUT es otro")
 *  - vacío, espacios o cualquier cosa que no sea string se IGNORA — un
 *    descuido del modelo no puede borrar un dato ya juntado
 */
// Allowlist de campos EN RUNTIME: Partial<T> no restringe nada una vez
// compilado, y el patch puede venir de JSON ajeno (vic_kv, la tool del modelo).
// Sin esto, una llave desconocida con valor string se colaría al borrador.
const CAMPOS_EMPRESA = ["nombre", "identificador"] as const
const CAMPOS_ADMIN = ["nombre", "apellido", "identificador", "email", "idInterno"] as const

export function aplicarDatos(b: Borrador, datos: DatosParciales): Borrador {
  const merge = <T extends Record<string, string | undefined>>(
    base: T,
    campos: readonly (keyof T)[],
    patch?: Partial<T>,
  ): T => {
    const out = { ...base }
    for (const k of campos) {
      const v = (patch as Record<string, unknown> | undefined)?.[k as string]
      if (typeof v === "string" && v.trim()) out[k] = v.trim() as T[keyof T]
    }
    return out
  }
  return {
    pais: b.pais,
    empresa: merge(b.empresa, CAMPOS_EMPRESA, datos.empresa),
    admin: merge(b.admin, CAMPOS_ADMIN, datos.admin),
  }
}

/**
 * Rehidrata un borrador guardado en vic_kv. Ante CUALQUIER cosa que no sea un
 * borrador bien formado (JSON roto, país desconocido, campos con tipos raros)
 * devuelve null y el canal arranca uno nuevo — un kv corrupto no puede tumbar
 * el webhook ni colar datos basura al alta. Pasa por aplicarDatos, así que
 * solo sobreviven los campos conocidos, como strings recortados.
 */
export function parsearBorrador(json: string | null | undefined): Borrador | null {
  if (!json) return null
  try {
    const raw = JSON.parse(json) as { pais?: unknown; empresa?: unknown; admin?: unknown }
    if (!raw || typeof raw !== "object") return null
    if (raw.pais !== "cl" && raw.pais !== "co" && raw.pais !== "mx") return null
    return aplicarDatos(borradorVacio(raw.pais), {
      empresa: (raw.empresa || {}) as DatosParciales["empresa"],
      admin: (raw.admin || {}) as DatosParciales["admin"],
    })
  } catch {
    return null
  }
}

/**
 * Borrador inicial de la fase: la SEMILLA con lo que la venta ya sabe (razón
 * social y RUT de la cotización pagada) por debajo, y lo que el cliente haya
 * dicho en la propia fase (`previo`) POR ENCIMA — el cliente siempre gana.
 * Regla de Eduardo (26-jul): no volver a preguntar lo que el cliente ya dio;
 * solo confirmarlo, actualizarlo o cambiarlo si él quiere usar otros datos.
 */
export function sembrarBorrador(
  previo: Borrador | null,
  semilla: DatosParciales,
  pais: PaisOnboarding,
): Borrador {
  const base = aplicarDatos(borradorVacio(pais), semilla)
  if (!previo) return base
  return aplicarDatos(base, { empresa: previo.empresa, admin: previo.admin })
}

// ── Confirmación con el cliente ─────────────────────────────────────────────

/**
 * Resumen que Vicky muestra ANTES de crear la empresa. El alta no se deshace
 * sola: si la razón social o el identificador salen mal, alguien lo arregla a
 * mano en la plataforma del cliente. Por eso la confirmación es explícita y
 * repite los datos tal como se van a enviar (ya normalizados), no como los
 * tecleó el cliente.
 *
 * Sin negritas ni signos de apertura: el formato de Vicky lo impone
 * normalizarFormatoWhatsApp, y este texto ya sale listo.
 */
export function resumenParaConfirmar(b: Borrador): string {
  if (!borradorCompleto(b)) return ""
  const nombreId = NOMBRE_IDENTIFICADOR[b.pais]
  const idEmpresa = normalizarIdentificador(b.empresa.identificador!, b.pais)
  const idAdmin = normalizarIdentificador(b.admin.identificador!, b.pais)

  const lineas = [
    "Con esto creo la cuenta:",
    "",
    `Empresa: ${b.empresa.nombre!.trim()}`,
    `${nombreId}: ${idEmpresa}`,
    "",
    `Administrador: ${b.admin.nombre!.trim()} ${b.admin.apellido!.trim()}`,
    `${nombreId}: ${idAdmin}`,
    `Correo: ${b.admin.email!.trim()}`,
  ]
  if (!vacio(b.admin.idInterno)) lineas.push(`Código interno: ${b.admin.idInterno!.trim()}`)
  lineas.push("", "Lo confirmas y lo dejo andando?")
  return lineas.join("\n")
}
