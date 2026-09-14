/**
 * ¿El reply PROMETE un contacto que había que registrar?
 *
 * Nace del caso Francisca (14-sep, +56956387811). Preguntó "cuando podrian
 * instalarlo?" dos minutos después de recibir su cotización y recibió el
 * enlatado del rescate de callback: "Dejé registrada tu solicitud de contacto
 * y el equipo la tiene con tus datos…". Nunca pidió que la llamaran.
 *
 * El cinturón anti-alucinación de callback (vic-botmaker-v3, 2.6c) existe para
 * que Vicky no diga "un ejecutivo te contactará" sin crear el lead. Pero su
 * detector incluía la forma GENÉRICA "el equipo / un ejecutivo te va a
 * contactar", y esa frase es la respuesta CORRECTA a una pregunta de plazo:
 * la instalación la coordina el equipo de implementación. Sin tool en el turno
 * —porque no correspondía ninguna— el cinturón la leyó como alucinación,
 * reemplazó la respuesta, registró una promesa falsa y cerró el loop.
 *
 * La regla acá es la misma que arregló el cinturón de descuento el 14-sep
 * (`turnoHablaDeDescuento`): la afirmación EXPLÍCITA de registro siempre
 * cuenta; la GENÉRICA cuenta salvo que el turno sea una pregunta operativa de
 * plazo y el cliente nunca haya pedido que lo contacten.
 *
 * Módulo PURO: sin red, sin Supabase. Lo consumen los webhooks.
 */

const sinTildes = (t: string) =>
  String(t || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()

/**
 * Tier A — el reply AFIRMA haber registrado algo, o nombra a una persona que
 * va a llamar. Esto es lo que jamás se puede decir sin tool: si es falso, el
 * cliente queda esperando a alguien que no sabe que existe.
 */
export function afirmaRegistroExplicito(t: string): boolean {
  const s = String(t || "")
  return (
    /\b(tom[eé]|dej[eé]|guard[eé]|registr[eé]|anot[eé])[^.]{0,30}\b(tus\s+datos|tu\s+solicitud|tus\s+antecedentes|el\s+callback|tu\s+contacto)\b/i.test(s) ||
    /\bqued(aste|[oó])\b[^.]{0,20}\bregistrad/i.test(s) ||
    /\bte\s+(dej[eé]|registr[eé])[^.]{0,15}\bregistrad/i.test(s) ||
    /\bte\s+conect(amos|o)\s+con\b/i.test(s) ||
    /\b(ya\s+)?(est[aá]|qued[oó])\s+escalad[oa]\b/i.test(s) ||
    /\bpara\s+que\s+[A-ZÁÉÍÓÚ][\wáéíóú]+\s+te\s+(llame|contacte|escriba)\b/.test(s) ||
    /\ble\s+pas[eé]\s+tus\s+datos\b/i.test(s)
  )
}

/**
 * Tier B — forma GENÉRICA: "un ejecutivo / el equipo … te va a contactar".
 * Solo formas ASERTIVAS; la oferta en subjuntivo ("¿quieres que un ejecutivo
 * te contacte?") es legítima sin tool y nunca entró acá.
 */
export function afirmaContactoGenerico(t: string): boolean {
  return /\b(un\s+ejecutivo|el\s+ejecutivo|la\s+ejecutiva|tu\s+ejecutiv[oa]|nuestr[oa]\s+ejecutiv[oa]|el\s+equipo|un\s+asesor|el\s+implementador|Anderson)\b[^.]{0,60}\b(te\s+(contactar[aá]|llamar[aá]|contacta|llama|va\s+a\s+(contactar|llamar))|se\s+(pondr[aá]|contactar[aá])\s+en\s+contacto)/i.test(
    String(t || ""),
  )
}

/** ¿El CLIENTE pidió en algún momento que lo llamen o contacten? */
export function clientePidioContacto(textos: string[]): boolean {
  const s = sinTildes((textos || []).join(" \n "))
  return (
    /\bllam(ame|enme|arme|eme)\b/.test(s) ||
    /\bque\s+me\s+(llamen|contacten|llame)\b/.test(s) ||
    /\bme\s+pueden\s+(llamar|contactar)\b/.test(s) ||
    /\b(puedes|puede|podrias|podria)\s+llamarme\b/.test(s) ||
    /\bprefiero\s+(hablar|que\s+me\s+llamen|una\s+llamada)\b/.test(s) ||
    /\bhablar\s+con\s+(un|una|alguien|algun|ejecutiv|asesor|vendedor|persona)/.test(s) ||
    /\b(quiero|necesito|me\s+gustaria)\s+(que\s+)?(un\s+)?(ejecutiv|asesor|vendedor)/.test(s) ||
    /\bagend(ar|amos|emos)\s+(una\s+)?(reunion|llamada)\b/.test(s) ||
    /\bcontact(enme|arme)\b/.test(s)
  )
}

/**
 * ¿El cliente está preguntando un PLAZO operativo? ("cuándo lo instalan",
 * "en cuánto llega el reloj", "cuánto demora la implementación"). Ahí que el
 * equipo de implementación coordine NO es una promesa de callback comercial:
 * es cómo funciona el servicio, y está escrito en los T&C de la cotización.
 */
export function preguntaOperativaDePlazo(mensajeCliente: string): boolean {
  const s = sinTildes(mensajeCliente)
  const pregunta =
    /\bcuando\b/.test(s) ||
    /\bcuanto\s+(demora|tarda|tiempo|se\s+demora)\b/.test(s) ||
    /\ben\s+cuanto\s+(tiempo|llega)\b/.test(s) ||
    /\bque\s+plazo\b/.test(s) ||
    /\bpara\s+cuando\b/.test(s) ||
    /\bfecha\s+de\s+(instalacion|entrega|inicio)\b/.test(s)
  if (!pregunta) return false
  return /\b(instal|implement|capacit|despach|envi|entrega|activ|parte|partir|empez|comenz|puesta\s+en\s+marcha|induccion|llega)/.test(s)
}

/**
 * Veredicto que consume el cinturón: ¿hay que exigir tool de registro?
 */
export function prometeContactoSinRegistro(
  reply: string,
  opts: { mensajeCliente?: string; textosCliente?: string[] } = {},
): boolean {
  if (afirmaRegistroExplicito(reply)) return true
  if (!afirmaContactoGenerico(reply)) return false
  if (clientePidioContacto(opts.textosCliente || [])) return true
  if (preguntaOperativaDePlazo(opts.mensajeCliente || "")) return false
  return true
}
