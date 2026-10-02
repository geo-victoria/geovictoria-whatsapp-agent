/**
 * PLANILLA DE INGRESO QUE EL CLIENTE MANDA POR EL CHAT (caso Palco Alto /
 * Lietta, IMP-11854, 02-oct): el cliente envió su propia planilla "INGRESO
 * EMPRESA" con razón social, giro, dirección, comuna, rubro y dos
 * administradores; la planilla que armó Vicky para la IMP salió con razón
 * social "Jose" y sin giro/dirección/comuna (el RUT no está en el padrón SII)
 * y Nailliw no podía crearla. Lo que el cliente declara en SU planilla manda.
 *
 * PURO: lee la transcripción (columnas separadas por tab) que deja la visión.
 */
export type PlanillaCliente = {
  razonSocial?: string
  nombreFantasia?: string
  rut?: string
  giro?: string
  direccion?: string
  comuna?: string
  rubro?: string
  admins: Array<{ nombre?: string; apellido?: string; rut?: string; telefono?: string; correo?: string }>
}

const limpiar = (s: string | undefined) => String(s || "").replace(/\s+/g, " ").trim()

function celda(lineas: string[][], etiqueta: RegExp): string {
  for (const cols of lineas) {
    const i = cols.findIndex((c) => etiqueta.test(c))
    if (i >= 0) {
      const v = cols.slice(i + 1).map(limpiar).find(Boolean)
      if (v && !etiqueta.test(v)) return v
    }
  }
  return ""
}

/** Datos de empresa y administradores de una planilla de ingreso transcrita; null si el texto no es una. */
export function planillaClienteEnTexto(texto: string): PlanillaCliente | null {
  const t = String(texto || "")
  if (!/DATOS DE INGRESO EMPRESA|Raz[oó]n Social \(debe ser igual a SII\)/i.test(t)) return null
  const lineas = t.split(/\r?\n/).map((l) => l.split("\t"))
  const p: PlanillaCliente = {
    razonSocial: celda(lineas, /^\s*Raz[oó]n Social/i),
    nombreFantasia: celda(lineas, /^\s*Nombre de fantas[ií]a/i),
    rut: celda(lineas, /^\s*RUT\s*\(ejemplo/i).replace(/[^0-9kK]/g, ""),
    giro: celda(lineas, /^\s*Giro\s*$/i),
    direccion: celda(lineas, /^\s*Direcci[oó]n\s*$/i),
    comuna: celda(lineas, /^\s*Comuna\s*$/i),
    rubro: celda(lineas, /^\s*Rubro\s*$/i),
    admins: [],
  }
  // Tabla de administradores: filas "N° · Nombre · Apellido · RUT · Teléfono · Correo".
  const iTabla = lineas.findIndex((c) => c.some((x) => /^\s*N°\s*$/.test(x)) && c.some((x) => /Correo/i.test(x)))
  if (iTabla >= 0) {
    for (const cols of lineas.slice(iTabla + 1, iTabla + 6)) {
      const v = cols.map(limpiar)
      const k = v.findIndex((x) => /^[1-4]$/.test(x))
      if (k < 0) continue
      const [nombre, apellido, rut, telefono, correo] = v.slice(k + 1)
      if (!nombre && !correo) continue
      p.admins.push({ nombre, apellido, rut: String(rut || "").replace(/[^0-9kK]/g, ""), telefono, correo })
    }
  }
  return p.razonSocial || p.giro || p.direccion || p.admins.length ? p : null
}
