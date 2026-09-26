/**
 * DOCUMENTO DEL CLIENTE EN PERÚ: RUC o DNI (Lalo 26-sep: "deberíamos cotizar si
 * dan DNI y no quieren dar RUC, y deberíamos validarlo").
 *
 * Casos reales que lo destaparon (24-25 sep): Fernando pidió boleta con su DNI
 * 06576356 ("actualmente no estamos tributando") y Vicky le dijo que "el
 * sistema espera 11 dígitos"; a Ana le pidió siete veces un "DNI de 11
 * dígitos", que no existe. En Perú la boleta de venta se emite con DNI.
 *
 *   - RUC: 11 dígitos con dígito verificador SUNAT.
 *   - DNI: 8 dígitos (se valida contra RENIEC en `fichaDniReniec`).
 *
 * Módulo PURO.
 */
import { rucValido } from "../../rut.ts"

export type DocumentoPE = { tipo: "RUC" | "DNI"; numero: string }

export function normalizarDocumentoPE(raw: unknown): DocumentoPE | null {
  const d = String(raw || "").replace(/\D/g, "")
  if (d.length === 11 && rucValido(d)) return { tipo: "RUC", numero: d }
  if (d.length === 8) return { tipo: "DNI", numero: d }
  return null
}

export type FichaDni = { dni: string; nombre: string; nombres?: string; apellidos?: string }

/** Parser PURO de apis.net.pe v1 /dni. "APELLIDO APELLIDO NOMBRES" → "Nombres Apellido Apellido". */
export function parsearFichaDni(dni: string, json: unknown): FichaDni | null {
  const j = (json || {}) as Record<string, unknown>
  const nombres = String(j.nombres || "").trim()
  const apP = String(j.apellidoPaterno || "").trim()
  const apM = String(j.apellidoMaterno || "").trim()
  const crudo = String(j.nombre || "").trim()
  if (!nombres && !crudo) return null
  const titulo = (s: string) => s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase())
  const apellidos = [apP, apM].filter(Boolean).join(" ")
  const nombre = nombres ? titulo(`${nombres} ${apellidos}`.trim()) : titulo(crudo)
  return { dni, nombre, nombres: nombres ? titulo(nombres) : undefined, apellidos: apellidos ? titulo(apellidos) : undefined }
}
