/** Parte PURA de lib/contenido-cotizacion (testeable con node --test). */
import { formatearMontoOperativo } from "./paises/ficha-operativa.ts"

type Item = { nombre: string; cantidad?: number; subtotalClp?: number; recurrente?: boolean; modalidad?: string }

/** Texto de UNA línea, en la moneda del país (Chile: pesos de referencia). PURO. */
export function lineaDeItem(i: Item, pais: string): string {
  const cant = i.cantidad && i.cantidad > 1 ? ` × ${i.cantidad}` : ""
  const monto =
    typeof i.subtotalClp === "number" && i.subtotalClp > 0
      ? formatearMontoOperativo(i.subtotalClp, pais || "cl")
      : "sin costo"
  const cuando = i.recurrente ? "mensual" : "pago único"
  return `- ${i.nombre}${cant}: ${monto} ${pais === "co" ? "" : "neto "}(${cuando})`.replace("  ", " ")
}

/** Bloque para el prompt con las líneas reales. PURO (recibe los ítems ya leídos). */
export function bloqueContenido(items: Item[], pais: string): string {
  const lineas = items.filter((i) => i.nombre).slice(0, 25).map((i) => lineaDeItem(i, pais))
  if (!lineas.length) return ""
  const tieneInstalacion = items.some((i) => /instalaci/i.test(i.nombre))
  return (
    `CONTENIDO REAL DE ESA COTIZACIÓN (exactamente lo que el cliente ve en su link; NO existe ninguna otra línea):\n` +
    lineas.join("\n") +
    `\n` +
    (tieneInstalacion
      ? ""
      : `Esta cotización NO incluye instalación técnica: el equipo va autoinstalable. Si el cliente la quiere, se agrega con actualizar_cotizacion y recién ahí existe su costo.\n`) +
    `Si el cliente pregunta qué incluye su cotización o cuánto cuesta una parte, responde SOLO con estas líneas. Prohibido decir que algo "está desglosado" o "viene incluido" si no aparece arriba, y prohibido derivar a un ejecutivo para explicar su propia cotización.\n\n`
  )
}
