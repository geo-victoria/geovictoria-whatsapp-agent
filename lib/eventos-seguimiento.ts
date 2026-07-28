/**
 * Event types "Seguimiento cotización" por ejecutivo (Cal.com, creados por
 * Lalo el 28-jul): eventos de EQUIPO round-robin con UN solo host — uno por
 * ejecutivo de Vicky en cada país.
 *
 * Son la única forma REAL de que una reunión nazca asignada al dueño de la
 * cotización: la API v2 (2024-08-13) no permite forzar el host dentro de un
 * evento multi-host — probado el 28-jul con la key productiva:
 * `teamMemberEmail` de primer nivel → 400 "property teamMemberEmail should
 * not exist". Con un evento de host único, disponibilidad y asignación son
 * del dueño por construcción.
 *
 * IDs verificados contra las páginas públicas (host correcto en cada una):
 * cal.com/team/onboardinggv/seguimiento-cotizacion-{cl,co,mx}
 */
export const EVENTO_SEGUIMIENTO_POR_DUENO: Record<string, string> = {
  "emujica@geovictoria.com": "6484386", // CL — Eddyluz Mujica
  "agordillo@geovictoria.com": "6484393", // CO — Alejandro Gordillo
  "ysegura@geovictoria.com": "6484399", // MX — Yahel Segura
}
