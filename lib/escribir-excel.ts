/**
 * Escritor MÍNIMO de .xlsx sin dependencias (gemelo de lib/leer-excel.ts):
 * una hoja, celdas como texto (inline strings), zip armado a mano con
 * deflateRawSync. Suficiente para la "planilla de ingreso" de usuarios que
 * el equipo de implementación carga en la plataforma (mismas columnas que
 * genera el wizard de auto-onboarding).
 */
import { deflateRawSync } from "node:zlib"

function xmlEsc(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function colName(i: number): string {
  let n = i + 1
  let s = ""
  while (n > 0) {
    const m = (n - 1) % 26
    s = String.fromCharCode(65 + m) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

function hojaXml(filas: Array<Array<string | number | null | undefined>>): string {
  const rows = filas
    .map((fila, r) => {
      const cells = fila
        .map((v, c) => {
          if (v === null || v === undefined || v === "") return ""
          const ref = `${colName(c)}${r + 1}`
          if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(String(v))}</t></is></c>`
        })
        .join("")
      return `<row r="${r + 1}">${cells}</row>`
    })
    .join("")
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`
  )
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Zip "store/deflate" mínimo: entradas locales + directorio central + EOCD. */
function zip(entradas: Array<{ nombre: string; datos: Buffer }>): Buffer {
  const locales: Buffer[] = []
  const centrales: Buffer[] = []
  let offset = 0
  for (const e of entradas) {
    const nombre = Buffer.from(e.nombre, "utf8")
    const comprimido = deflateRawSync(e.datos)
    const crc = crc32(e.datos)
    const loc = Buffer.alloc(30)
    loc.writeUInt32LE(0x04034b50, 0)
    loc.writeUInt16LE(20, 4)
    loc.writeUInt16LE(0x0800, 6)
    loc.writeUInt16LE(8, 8)
    loc.writeUInt16LE(0, 10)
    loc.writeUInt16LE(0x21, 12)
    loc.writeUInt32LE(crc, 14)
    loc.writeUInt32LE(comprimido.length, 18)
    loc.writeUInt32LE(e.datos.length, 22)
    loc.writeUInt16LE(nombre.length, 26)
    loc.writeUInt16LE(0, 28)
    locales.push(loc, nombre, comprimido)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0x0800, 8)
    cen.writeUInt16LE(8, 10)
    cen.writeUInt16LE(0, 12)
    cen.writeUInt16LE(0x21, 14)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(comprimido.length, 20)
    cen.writeUInt32LE(e.datos.length, 24)
    cen.writeUInt16LE(nombre.length, 28)
    cen.writeUInt16LE(0, 30)
    cen.writeUInt16LE(0, 32)
    cen.writeUInt16LE(0, 34)
    cen.writeUInt16LE(0, 36)
    cen.writeUInt32LE(0, 38)
    cen.writeUInt32LE(offset, 42)
    centrales.push(cen, nombre)
    offset += loc.length + nombre.length + comprimido.length
  }
  const cd = Buffer.concat(centrales)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entradas.length, 8)
  eocd.writeUInt16LE(entradas.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locales, cd, eocd])
}

/** Genera un .xlsx de una hoja con las filas dadas (la primera es el encabezado). */
export function escribirXlsx(nombreHoja: string, filas: Array<Array<string | number | null | undefined>>): Buffer {
  const hoja = xmlEsc(nombreHoja.slice(0, 31) || "Hoja1")
  const ct =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `</Types>`
  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`
  const wb =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="${hoja}" sheetId="1" r:id="rId1"/></sheets></workbook>`
  const wbRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `</Relationships>`
  return zip([
    { nombre: "[Content_Types].xml", datos: Buffer.from(ct, "utf8") },
    { nombre: "_rels/.rels", datos: Buffer.from(rels, "utf8") },
    { nombre: "xl/workbook.xml", datos: Buffer.from(wb, "utf8") },
    { nombre: "xl/_rels/workbook.xml.rels", datos: Buffer.from(wbRels, "utf8") },
    { nombre: "xl/worksheets/sheet1.xml", datos: Buffer.from(hojaXml(filas), "utf8") },
  ])
}

export const COLUMNAS_PLANILLA_USUARIOS = [
  "identificador",
  "email",
  "email alternativo comprobantes",
  "nombre",
  "apellido",
  "grupo",
  "fono1",
  "fono2",
  "fono3",
  "identificador razon social",
  "tipo",
] as const

export type FilaPlanillaUsuario = {
  rut: string
  correo?: string
  nombres?: string
  apellidos?: string
  grupo?: string
  telefono1?: string
  telefono2?: string
  telefono3?: string
  tipo: "usuario" | "administrador"
}

/** RUT como lo escribe el wizard en la planilla (normalizeRutForExcel): solo alfanuméricos, en mayúscula, sin puntos ni guión. */
export function rutPlanilla(raw: string | undefined): string {
  return String(raw || "").replace(/[^0-9A-Za-z]/g, "").toUpperCase()
}

/** Planilla de ingreso de usuarios (mismas 11 columnas del wizard: admins primero, luego trabajadores). */
export function planillaUsuariosXlsx(rutEmpresa: string, filas: FilaPlanillaUsuario[]): Buffer {
  const emp = rutPlanilla(rutEmpresa)
  const orden = [...filas.filter((f) => f.tipo === "administrador"), ...filas.filter((f) => f.tipo !== "administrador")]
  const rows = orden.map((f) => [
    rutPlanilla(f.rut),
    f.correo || "",
    "",
    f.nombres || "",
    f.apellidos || "",
    f.tipo === "administrador" ? "" : f.grupo || "General",
    f.telefono1 || "",
    f.telefono2 || "",
    f.telefono3 || "",
    emp,
    f.tipo,
  ])
  return escribirXlsx("Usuarios", [[...COLUMNAS_PLANILLA_USUARIOS], ...rows])
}
