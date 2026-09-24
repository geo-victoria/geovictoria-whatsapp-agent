/**
 * GUARDA DEL DETECTOR DE COMPROBANTES DEL ESPEJO (24-sep, caso Rodrigo/COT1668).
 * Rodrigo le mandó al WhatsApp espejado de Lalo una captura de NUESTRO correo
 * "Cotización … PAGADA"; la visión la describió como "notificación de
 * cotización pagada de GeoVictoria", el detector la tomó por comprobante y
 * marcó Pagada una cotización de prueba — con correo de PAGADA, cobranza y
 * kickoff del alta. Tres filtros antes de tocar el CRM:
 *   1. contacto interno (Lalo, Rodrigo, líneas de Vicky…) → nunca;
 *   2. captura de una notificación NUESTRA (correo PAGADA, aviso de Zoho) → no;
 *   3. el destino de la transferencia tiene que ser una cuenta o razón social
 *      nuestra (cuenta completa, sus últimos 4 dígitos enmascarados, o el alias).
 * PURO: el llamador pasa el set de contactos internos.
 */
import { cuentasNuestras, destinoNuestroEn } from "./paises/ficha-operativa.ts"

const NOTIFICACION_PROPIA =
  /(notificaci[oó]n|correo|e-?mail|captura\s+de\s+pantalla\s+de\s+(whatsapp|un\s+correo|outlook|gmail))[^.]{0,120}cotizaci[oó]n[^.]{0,40}(pagada|aceptada)|cotizaci[oó]n\s+(\S+\s+){0,4}(pagada|aceptada)\b[^.]{0,80}(geo\s?victoria|zoho|vicky)|\[geo\s?victoria\]|venta\s+(aut[oó]noma|asistida)|canal:\s*(vicky|ejecutivo)/i

export type MotivoDescarte = "contacto_interno" | "notificacion_propia" | "destino_no_nuestro"

function destinoEnmascarado(texto: string): boolean {
  for (const c of cuentasNuestras()) {
    const ult4 = c.digitos.slice(-4)
    if (new RegExp(`[*x•·.#]{2,}\\s?-?\\s?${ult4}\\b`, "i").test(texto)) return true
  }
  return false
}

/** null = procede como comprobante; si no, el motivo para NO tocar el CRM. */
export function motivoDescarteComprobanteEspejo(
  texto: string,
  fono: string,
  internos: Set<string>,
): MotivoDescarte | null {
  const f = String(fono || "").replace(/\D/g, "")
  if (f && internos.has(f)) return "contacto_interno"
  const t = String(texto || "")
  if (NOTIFICACION_PROPIA.test(t)) return "notificacion_propia"
  if (!destinoNuestroEn(t) && !destinoEnmascarado(t)) return "destino_no_nuestro"
  return null
}
