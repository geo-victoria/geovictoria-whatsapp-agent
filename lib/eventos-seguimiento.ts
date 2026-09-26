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
import { EVENTOS_AGENDA_CO } from "./paises/co/agenda.ts"

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
  // Creados por Lalo el 18-ago; verificados el mismo día contra la API
  // (slots reales en la ventana de prueba: Daniela 128 · Aracelli 93 ·
  // Aleydis 93 — cada evento mira la agenda de SU host).
  "dgalvez@geovictoria.com": "6723047", // CL — Daniela Gálvez
  "asepulveda@geovictoria.com": "6723107", // CL — Aracelli Sepúlveda
  "aaraque@geovictoria.com": "6723118", // CL — Aleydis Araque
  // ── Resto de países ──
  "agordillo@geovictoria.com": "6484393", // CO — Alejandro Gordillo
  "ysegura@geovictoria.com": "7234434", // MX — Yahel Segura (Lalo 26-sep: calendario nuevo; verificado 28 horarios en 5 días)
  // Lalo 26-sep: calendario de Pablo Rodríguez (SDR MX). Verificado el mismo día:
  // 28 horarios en 5 días.
  "prodriguez@geovictoria.com": "7234317", // MX — Pablo Rodríguez (SDR)
  // ── PERÚ (15-sep, regla chilena: la reunión sigue al dueño del registro) ──
  // Evento creado por Lalo el 15-sep; verificado contra la API el mismo día
  // (slots reales en horario -05:00 Lima, 20 min).
  "afiori@geovictoria.com": "7084716", // PE — Ana Fiori (SDR Inbound) · 99 slots/5 días
  "pquispef@geovictoria.com": "7084727", // PE — Priscila Quispe (SDR Inbound) · 146 slots/5 días
  // Mónica Mendoza (telemarketing PE): evento 7084664 (Lalo 21-sep: "agenda de
  // Mónica es app.cal.com/event-types/7084664 — mientras estoy yo como host,
  // luego lo cambiamos a Mónica"). Es también el evento POR DEFECTO de toda
  // reunión peruana (lib/paises/pe/tools-unificadas → eventoAgendaPE).
  "mmendozav@geovictoria.com": "7084664", // PE — Mónica Mendoza (host interino: Lalo)
  // ── COLOMBIA (23-sep, telemarketing del tramo 1-199 de "Deals 2026") ──
  // Eventos creados por Lalo con él como host interino hasta que cada una
  // conecte su calendario (el id no cambia). Verificados el 23-sep: 101 slots
  // en 6 días cada uno. Correos e ids salen de la FICHA OPERATIVA
  // (`calEventoId` de cada persona) vía lib/paises/co/agenda.ts — fuente única.
  ...EVENTOS_AGENDA_CO,
  // ANDERSON (6616830): sin horario del 10-ago al 24-sep (0 slots); el 25-sep
  // responde 118 slots en 5 días con su agenda → cableado.
  "adiazg@geovictoria.com": "6616830", // CL — Anderson Díaz
  // SIN evento propio todavía (caen al round-robin): Eddy Galindo (CO).
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
