/**
 * Etiqueta DETERMINISTA de la opción que se está descontando (31-ago, prueba
 * de Rodrigo): el primer 10% se calculó sobre reloj+app cuando el cliente
 * había elegido solo app, y el mensaje no decía sobre QUÉ opción era — el
 * error quedó invisible hasta el reclamo. Esta etiqueta se construye desde
 * los args REALES de la tool y viaja pegada al mensajeParaProspecto: si el
 * modelo pasó la opción equivocada, se nota al tiro (cliente y modelo).
 *
 * Módulo PURO (patrón del repo): el nombre de cada hardware llega por
 * resolver inyectado para que el test lo ejercite sin arrastrar el catálogo.
 */

export type HardwareEtiqueta = { id: string; cantidad?: number; modalidad?: string }

export function etiquetaOpcionDescuento(
  userCount: number,
  hardware: HardwareEtiqueta[] | undefined,
  nombreDe: (id: string) => string | null,
): { etiqueta: string; opcion: string } {
  const partes = [
    `App móvil para ${userCount} personas`,
    ...(hardware || []).map((h) => {
      const nombre = nombreDe(h.id) || h.id
      const mod = (h.modalidad || "arriendo") === "venta" ? "en compra" : "en arriendo"
      return `${nombre} ${mod}${(h.cantidad || 1) > 1 ? ` ×${h.cantidad}` : ""}`
    }),
  ]
  const opcion = partes.join(" + ")
  return { opcion, etiqueta: `(Este valor es para la opción: ${opcion}.)` }
}
