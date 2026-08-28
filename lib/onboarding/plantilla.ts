/**
 * EL mensaje de arranque del onboarding. Uno solo, para todos los casos.
 *
 * DECISIÓN (Eduardo, 26-jul): el mismo texto para las dos vías de pago —
 * tarjeta y transferencia— y tanto dentro como fuera de la ventana de 24 h.
 * Antes había dos redacciones y una de ellas moría en silencio fuera de
 * ventana; ahora hay una sola y siempre llega.
 *
 * EL CUERPO ES LA ÚNICA FUENTE DE VERDAD. Fuera de la ventana se manda como
 * plantilla HSM (Botmaker resuelve las variables); dentro, se manda el MISMO
 * texto ya renderizado como mensaje libre. Nunca dos redacciones que puedan
 * separarse con el tiempo — hay un eval que lo verifica.
 *
 * POR QUÉ NO DICE "TU PAGO QUEDÓ REGISTRADO": el texto que eligió Eduardo lo
 * traía, y con TARJETA sería cierto — pero con TRANSFERENCIA no. Ahí solo se
 * recibió el comprobante; el abono lo verifica finanzas en paralelo (regla
 * Lalo 17-jul, con eval que la protege). Como el mensaje es uno solo para las
 * dos vías, la afirmación sale y "ya eres parte de GeoVictoria" carga el
 * sentido: es una bienvenida, no un dato sobre el dinero. El acuse del monto
 * lo da Vicky aparte, en la vía donde sí corresponde.
 *
 * SINTAXIS: Botmaker usa ${variable} con nombre, NO los {{1}} posicionales de
 * Meta. `empresa` y `rut_empresa` son variables de contacto de scope "user" que
 * ya existen en la cuenta — se pasan explícitamente como params porque el
 * puntero de la cotización tiene el dato fresco y la variable guardada podría
 * estar vacía o vieja.
 *
 * Creada en Botmaker el 26-jul: UTILITY, locale es, bot "Vicky Chile".
 *
 * OJO CON EL NOMBRE — no se puede reciclar. Meta bloquea el nombre de una
 * plantilla por 4 SEMANAS después de borrarla: un intento anterior se llamaba
 * vicky_onboarding_inicio_cl, se borró para corregir el cuerpo, y al volver a
 * crearla con el mismo nombre Meta la rechazó ("You can't change the category
 * for this message template while the existing Spanish content is being
 * deleted. Try again in 4 weeks or use MARKETING as the category"). La salida
 * NO es bajar a MARKETING —esto es post-transaccional y MARKETING queda sujeto
 * a los límites promocionales— sino usar un nombre nuevo. Si hay que cambiar
 * el texto otra vez, se crea con OTRO nombre y se cambia esta constante; nunca
 * borrar y recrear con el mismo.
 */

export const PLANTILLA_ONBOARDING_CL = {
  /** ruleNameOrId que espera la API de notificaciones de Botmaker. */
  name: "vicky_alta_cuenta_cl",
  category: "UTILITY" as const,
  locale: "es",
  botName: "Vicky Chile",
  body:
    "Felicitaciones, ya eres parte de GeoVictoria 🎉\n\n" +
    "Ahora te creo la cuenta por este mismo chat, toma un par de minutos.\n\n" +
    "De tu cotización ya tengo estos datos de la empresa:\n" +
    "Empresa: ${empresa}\n" +
    "RUT: ${rut_empresa}\n\n" +
    "Los usamos tal cual? Si hay que cambiar algo, me dices. " +
    "Y cuéntame quién va a administrar la cuenta: su nombre, apellido, RUT y correo.",
} as const

/**
 * Plantilla del ALTA POR FORMULARIO (WhatsApp Flow, 28-ago): botón FLOW
 * "Crear cuenta" → alta_cuenta_v2_flow (3 pantallas, endpoint vickyaltaflowv3).
 * Se manda SOLO con el gate vic_kv `alta_flow_kickoff` = "on" (la plantilla
 * debe estar APROBADA: Botmaker acepta encargos de plantillas PENDING y los
 * bota en silencio — cicatriz del 25-ago). Si el envío falla, el kickoff cae
 * al camino clásico conversacional: nadie se queda sin alta.
 */
export const PLANTILLA_ALTA_FLOW_CL = {
  name: "vicky_alta_flow_clv4",
  category: "UTILITY" as const,
  locale: "es",
  botName: "Vicky Chile",
  body:
    "Felicidades ${nombre}, tu pago quedó registrado 🙌 Ya está todo listo para crear tu cuenta: " +
    "solo falta confirmar los datos de tu empresa y de quien la administrará. " +
    "Los completas aquí mismo, en un formulario rápido.",
} as const

/** Param de la plantilla del Flow. Fallbacks: nombre → empresa → emoji. */
export function paramsPlantillaAltaFlow(nombre?: string, empresa?: string): { nombre: string } {
  const primero = (nombre || "").trim().split(/\s+/)[0] || ""
  return { nombre: primero || (empresa || "").trim() || "🎉" }
}

export type ParamsOnboarding = { empresa: string; rut_empresa: string }

/** Params de la plantilla. Sin dato, genéricos que no dejan huecos raros. */
export function paramsPlantillaOnboarding(empresa?: string, rut?: string): ParamsOnboarding {
  return {
    empresa: (empresa || "").trim() || "tu empresa",
    rut_empresa: (rut || "").trim() || "el de tu cotización",
  }
}

/**
 * El MISMO cuerpo, con las variables resueltas, para mandarlo como texto libre
 * cuando la ventana está abierta. Renderiza desde `body`, así que el texto no
 * puede divergir del de la plantilla aprobada.
 */
export function renderPlantillaOnboarding(params: ParamsOnboarding): string {
  return PLANTILLA_ONBOARDING_CL.body.replace(
    /\$\{(\w+)\}/g,
    (_, k: string) => (params as Record<string, string>)[k] ?? `\${${k}}`,
  )
}
