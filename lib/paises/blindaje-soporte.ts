/**
 * SOPORTE INVENTADO — UN blindaje para todos los países con mesa propia
 * (24-sep, al sumar México; herencia del chileno del 01-sep, del peruano del
 * 15-sep y del colombiano del 23-sep). Los datos salen de la FICHA OPERATIVA
 * del país: la tarjeta de su Mesa de Ayuda y la lista blanca de correos (su
 * equipo + líderes + usuarios activos de Zoho). Lo que cambia:
 *   - fijos +56 2, la Mesa CL (600 914 3819) y el WhatsApp de soporte CL
 *     → teléfono de la mesa del país;
 *   - cualquier @geovictoria.com fuera de la lista blanca → correo de la mesa.
 * Best-effort: sin ficha de soporte devuelve el texto tal cual.
 */
import { equipoOperativo, fichaOperativa } from "./ficha-operativa.ts"

export async function blindarSoporteInventadoPais(
  pais: string,
  texto: string,
  permitidosExtra?: Set<string>,
): Promise<string> {
  if (!texto) return texto
  const ficha = fichaOperativa(pais)
  const sop = ficha.soporte
  if (!sop) return texto
  const permitidos = new Set<string>(["vicky@geovictoria.com", "info@geovictoria.com", sop.email.toLowerCase()])
  for (const p of equipoOperativo(pais)) permitidos.add(p.email.toLowerCase())
  for (const e of [ficha.equipo.lider, ficha.equipo.liderSdr]) if (e) permitidos.add(e.toLowerCase())
  try {
    const { emailsEquipoZoho } = await import("../emails-equipo.ts")
    for (const e of await emailsEquipoZoho()) permitidos.add(String(e).toLowerCase())
  } catch { /* lista de la ficha */ }
  // Correos que el orquestador declara legítimos (el del admin del borrador en
  // fase onboarding): jamás se pisan — cicatriz PE 21-sep, resumen del alta.
  for (const e of permitidosExtra || []) permitidos.add(String(e).toLowerCase())
  const salida = texto
    .replace(/\+?\s*56\s*[\s.\-]*2[\s.\-]*\d{4}[\s.\-]*\d{4}/g, sop.telefono)
    .replace(/\b600\s*914\s*3819\b/g, sop.telefono)
    .replace(/\+?\s*56\s*9[\s.\-]*4401[\s.\-]*3873/g, sop.telefono)
  return salida.replace(/\b([a-z0-9._%+-]+)@geovictoria\.com\b/gi, (todo, usuario: string) =>
    permitidos.has(`${usuario.toLowerCase()}@geovictoria.com`) ? todo : sop.email,
  )
}
