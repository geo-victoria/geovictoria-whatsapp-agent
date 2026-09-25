/**
 * Línea de WhatsApp (canal Botmaker) por PAÍS — fuente única (15-sep, Perú
 * Fase A).
 *
 * POR QUÉ EXISTE: cada perfil de país declaraba su channelId con su propio
 * default (CO con `""`, o sea "línea chilena" en silencio), botmaker-push
 * caía a BOTMAKER_CHANNEL_V3 (Chile) cuando no había canal de origen ni
 * channelId del llamador, y las plantillas de un bot podían salir por la
 * línea de otro (Botmaker acepta el encargo y lo bota). Acá vive UNA tabla:
 * número de línea y channelId por país, y la regla de coherencia entre la
 * plantilla y la línea.
 *
 * PURO: sin red. Lee env con los mismos defaults que los perfiles.
 */

export type PaisLinea = "cl" | "co" | "mx" | "pe"

const BUSINESS_ID = (process.env.BOTMAKER_BUSINESS_ID || "GeoVictoriaEspaol").trim()

/** Número de la línea (sin "+") por país. */
export const NUMERO_LINEA: Record<PaisLinea, string> = {
  cl: (process.env.BOTMAKER_CHANNEL_NUMBER || "56967308227").replace(/\D/g, ""),
  co: (process.env.BOTMAKER_CHANNEL_NUMBER_CO || "573181070737").replace(/\D/g, ""),
  mx: (process.env.BOTMAKER_CHANNEL_NUMBER_MX || "5215659778486").replace(/\D/g, ""),
  pe: (process.env.BOTMAKER_CHANNEL_NUMBER_PE || "51922067167").replace(/\D/g, ""),
}

/**
 * channelId de Botmaker por país. Chile conserva BOTMAKER_CHANNEL_V3 (el
 * default histórico de todos los llamadores); los demás aceptan su env y, si
 * falta, se arman con la forma canónica `<business>-whatsapp-<número>`.
 */
export function channelIdPorPais(pais: PaisLinea): string {
  if (pais === "cl") return (process.env.BOTMAKER_CHANNEL_V3 || "").trim()
  const env =
    pais === "co"
      ? process.env.BOTMAKER_CHANNEL_CO
      : pais === "mx"
        ? process.env.BOTMAKER_CHANNEL_MX
        : process.env.BOTMAKER_CHANNEL_PE
  const e = (env || "").trim()
  return e || `${BUSINESS_ID}-whatsapp-${NUMERO_LINEA[pais]}`
}

/**
 * País por prefijo de un número (sin "+"). Mismos criterios que
 * lib/ruteo-pais: CL 56+9 · CO 57+10 · MX 521+10 (o 52+10) · PE 51+9.
 */
/**
 * País de la línea que corresponde a un CONTACTO: respeta el prefijo de país de
 * los identificadores de WhatsApp sin número (BSUID "PE.4635…", "CO.1594…") y
 * cae al prefijo telefónico para los números. 25-sep, prueba de Ana Fiori.
 */
export function paisLineaDeContacto(contact: string): PaisLinea | "otro" {
  const marca = /^\s*(CL|CO|MX|PE)\./i.exec(String(contact || ""))?.[1]?.toLowerCase()
  if (marca === "cl" || marca === "co" || marca === "mx" || marca === "pe") return marca
  return paisDeNumero(contact)
}

export function paisDeNumero(num: string): PaisLinea | "otro" {
  const c = String(num || "").replace(/\D/g, "")
  if (!c) return "otro"
  if (c.startsWith("521") && c.length >= 13) return "mx"
  if (c.startsWith("52") && !c.startsWith("521") && c.length === 12) return "mx"
  if (c.startsWith("57") && c.length >= 12) return "co"
  if (c.startsWith("56") && c.length >= 11) return "cl"
  if (c.startsWith("51") && c.length === 11) return "pe"
  return "otro"
}

/** País de una LÍNEA (por el número al final del channelId o el número pelado). */
export function paisDeLinea(canalONumero: string): PaisLinea | "otro" {
  const num = (String(canalONumero || "").match(/(\d{6,})\s*$/) || [])[1] || ""
  if (!num) return "otro"
  for (const p of Object.keys(NUMERO_LINEA) as PaisLinea[]) {
    if (NUMERO_LINEA[p] && num === NUMERO_LINEA[p]) return p
  }
  return paisDeNumero(num)
}

/**
 * País al que pertenece una PLANTILLA por su nombre, si lo declara:
 * `vicky_alta_flow_clv4` → cl · `vicky_react_t2_cl_v2` → cl ·
 * `vicky_co_solicitud_recibida` → co · `vicky_mx_lead_apertura` → mx.
 * Sin marcador (`vicky_traspaso_ejecutivo`, `vicky_t0_finde`) → null: puede
 * existir en cualquier bot. "vicky_cotizacion_…" NO es "co" (el token exige
 * borde `_` o fin de nombre, opcionalmente seguido de vN).
 */
export function paisDePlantilla(nombre: string): PaisLinea | null {
  const n = String(nombre || "").trim().toLowerCase()
  const m = /(?:^|_)(cl|co|mx|pe)(?:v\d+)?(?:_|$)/.exec(n)
  const p = m?.[1]
  return p === "cl" || p === "co" || p === "mx" || p === "pe" ? p : null
}

/**
 * ¿La plantilla puede salir por esta línea? Una plantilla vive en el bot de
 * SU línea (regla 25-ago: "plantillas SIEMPRE en el bot de la línea") — por
 * otra línea Botmaker acepta el 202 y no entrega nada. Sin marcador de país
 * en el nombre no se puede afirmar nada: se deja pasar.
 */
/**
 * Plantillas con marcador de país cuyo TEXTO es neutro (sin RUT/UF/comuna) y
 * que, con los bots de Botmaker UNIFICADOS (verificado 22-sep: una plantilla
 * "Vicky Chile" salió de verdad por la línea +51), sirven a cualquier línea.
 * Lalo 23-sep ("bots unificados ok"): Colombia las usa tal cual.
 */
export const PLANTILLAS_MULTILINEA = new Set<string>(["vicky_alta_qr_cl", "vicky_loop_pago_link_cl"])

export function plantillaCoherenteConLinea(nombrePlantilla: string, canalONumero: string): boolean {
  if (PLANTILLAS_MULTILINEA.has(String(nombrePlantilla || "").trim().toLowerCase())) return true
  const pTpl = paisDePlantilla(nombrePlantilla)
  if (!pTpl) return true
  const pLinea = paisDeLinea(canalONumero)
  if (pLinea === "otro") return true
  return pTpl === pLinea
}
