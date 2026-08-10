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
  // ── Ejecutivos de la TÓMBOLA CL (eventos creados por Lalo el 10-ago) ──
  // Verificados el mismo día contra la API: los cuatro responden 200 y cada
  // uno devuelve una disponibilidad DISTINTA (73 / 88 / 76 / 59 slots en la
  // misma ventana), o sea cada evento mira la agenda de SU host. Los cuatro
  // tienen Outlook conectado (confirmado por Lalo en la consola de Cal).
  "emujica@geovictoria.com": "6616710", // CL — Eddyluz Mujica (antes 6484386)
  "pdiaz@geovictoria.com": "6616712", // CL — Paola Díaz
  "gmelendez@geovictoria.com": "6616718", // CL — Grey Meléndez
  "alopez@geovictoria.com": "6616741", // CL — Ana Paula López
  "tmartinezq@geovictoria.com": "6616775", // CL — Tamara Martínez
  // ── Resto de países ──
  "agordillo@geovictoria.com": "6484393", // CO — Alejandro Gordillo
  "ysegura@geovictoria.com": "6484399", // MX — Yahel Segura
  // ANDERSON (6616830) NO se cablea: su evento devuelve 0 slots en 14, 30 y
  // 60 días — está sin horario/host utilizable. Cablearlo dejaría a sus
  // clientes sin ninguna hora que elegir; hasta arreglarlo cae al
  // round-robin, que sí ofrece agenda. Medición 10-ago en la MISMA ventana
  // de 14 días: Paola 226 · Grey 203 · Eddyluz 193 · Tamara 175 · Ana Paula
  // 127 · Anderson 0.
  // SIN evento propio todavía (caen al round-robin): Daniela Gálvez,
  // Aracelli Sepúlveda, Aleydis Araque, Eddy Galindo (CO), Mónica Mendoza (PE).
}

/**
 * Evento de seguimiento del dueño, extensible por env SIN deploy:
 * VICKY_CAL_EVENTO_POR_DUENO="email:eventTypeId,email:eventTypeId". Nació el
 * 31-jul con la regla de tómbola de Zoho para Deals ("Tómbola Deals 2026
 * Chile"): cualquier vendedor que la tómbola asigne necesita su evento de
 * host único en Cal para que la reunión se busque en SU agenda — se crea el
 * evento en Cal y se suma acá por env. El env tiene prioridad sobre el mapa.
 */
export function eventoSeguimientoDe(email: string): string | undefined {
  const limpio = (email || "").trim().toLowerCase()
  if (!limpio) return undefined
  const extra = (process.env.VICKY_CAL_EVENTO_POR_DUENO || "").trim()
  if (extra) {
    for (const par of extra.split(",")) {
      const [e, id] = par.split(":").map((s) => s.trim())
      if (e && id && e.toLowerCase() === limpio) return id
    }
  }
  return EVENTO_SEGUIMIENTO_POR_DUENO[limpio]
}
