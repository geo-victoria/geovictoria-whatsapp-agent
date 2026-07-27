/**
 * Perfil de país: MÉXICO (línea +52 1 56 5977 8486).
 *
 * Estado: EN CONSTRUCCIÓN — el perfil existe y compila; la integración
 * (registro en lib/paises/index.ts, ruta app/api/vic-botmaker-mx/, flow y
 * acción de código en Botmaker) la hace otro proceso. Ver TODOs.
 *
 * TODO antes de encender:
 *   1. Teléfono del ejecutivo comercial (Yahel Segura) — pendiente.
 *   2. SDRs MX para tómbola inbound (v1: sin tómbola, todo lead va a Yahel).
 *   3. Plantillas HSM de la línea MX (apertura/nudge/cierre) aprobadas por Meta.
 *   4. Cotizador MX (endpoint create-from-vicky-mx, entidad legal Checador,
 *      pago con tarjeta y transferencia BANORTE) → recién ahí
 *      cotizadorHabilitado = true.
 *   5. Territorio "México" en lib/zoho-leads.ts (hoy solo setea Territorio
 *      para Chile/Colombia; el owner directo de Yahel mitiga mientras tanto).
 */

import type { PerfilPais } from "../tipos"
import { CATALOGO_MODULOS_MX, CATALOGO_HARDWARE_MX, CATALOGO_SERVICIOS_MX } from "./catalogo"
import { rfcValido, normalizarRfc } from "./rfc"

function formatearMXN(monto: number): string {
  return "$" + Math.round(monto).toLocaleString("es-MX") + " MXN"
}

export const PERFIL_MX: PerfilPais = {
  codigo: "mx",
  nombre: "México",
  // Los números mexicanos de WhatsApp usan 52 + 1 + 10 dígitos (el "1" móvil
  // histórico). El guard de outbound debe aceptar TAMBIÉN el 52 pelado de 12
  // dígitos (números sin el 1); este campo lleva el prefijo canónico de la
  // línea.
  prefijoTelefono: "521",
  timezone: "America/Mexico_City",

  moneda: {
    codigo: "MXN",
    formatear: formatearMXN,
    // Sin unidad indexada: los precios del catálogo son MXN directos.
    unidadIndexada: null,
  },

  validarTributario: (input: string) => ({
    valido: rfcValido(input),
    normalizado: normalizarRfc(input),
    etiqueta: "RFC",
  }),

  catalogo: {
    modulos: CATALOGO_MODULOS_MX,
    hardware: CATALOGO_HARDWARE_MX,
    servicios: CATALOGO_SERVICIOS_MX,
  },

  promptBlocks: {
    identidad:
      "Eres Vicky, ejecutiva comercial de GeoVictoria MÉXICO. Atiendes a empresas que operan en México. Todos los precios que comunicas son en pesos mexicanos (MXN), montos fijos — en México NO existe la UF ni ninguna unidad indexada.",
    reglasDePrecio:
      "Los precios del catálogo están directamente en pesos mexicanos (MXN). Nunca menciones UF, CLP, COP ni precios de otros países. El IVA en México es 16% y aplica a todos los conceptos: las tools ya lo incluyen en los totales que muestran — nunca lo calcules tú. La capacitación online es un servicio COBRADO ($600 pago único) que la tool incluye en toda cotización: NUNCA digas que va incluida ni que tiene 100% de descuento. Ventaja comercial del arriendo: envío gratis en todo México e instalación gratis en CDMX y Zona Metropolitana.",
    geografia:
      "Para la instalación del reloj la ubicación se clasifica en dos zonas: CDMX/Zona Metropolitana del Valle de México (instalación profesional cotizable) y resto del país (la instalación profesional la cotiza el ejecutivo aparte, o el cliente auto-instala gratis — la venta no se frena). El envío en venta tiene tarifa única nacional; en arriendo es gratis.",
    legal:
      "El ente fiscalizador laboral en México es la STPS (Secretaría del Trabajo y Previsión Social). NO existe un documento de certificación equivalente al chileno: PROHIBIDO prometer certificaciones, y NUNCA cites a la Dirección del Trabajo de Chile ni la Resolución 38 (son chilenas, no aplican). Permanencia: sin amarre; el cliente puede cortar avisando con 30 días.",
    lenguaje:
      "Tuteo mexicano cálido y profesional (tú/tienes/puedes), con expresiones neutras mexicanas suaves ('claro que sí', 'con gusto'; 'te late?' con moderación). PROHIBIDO el voseo, los chilenismos y los colombianismos.",
  },

  // Entidad legal MX del documento de tropicalización (beneficiario de la
  // transferencia bancaria y dirección de devolución de equipos).
  entidadLegal: {
    razonSocial: "Checador, S.A. de C.V.",
    idTributario: "RFC: CEC2005286R4",
    direccion: "Hamburgo 213, Piso 10, Cuauhtémoc, C.P. 06600",
    ciudad: "Ciudad de México",
  },

  canal: {
    // channelId del documento oficial (línea +52 1 56 5977 8486).
    channelId: (
      process.env.BOTMAKER_CHANNEL_MX || "GeoVictoriaEspaol-whatsapp-5215659778486"
    ).trim(),
    numeroLinea: (process.env.BOTMAKER_CHANNEL_NUMBER_MX || "5215659778486").trim(),
    templates: {
      // TODO: crear y aprobar plantillas de la línea MX en Meta.
    },
  },

  equipo: {
    // v1 MX sin tómbola SDR: todo lead derivado queda a nombre del ejecutivo
    // (Yahel). TODO: agregar SDRs MX cuando el equipo los defina.
    sdrInbound: [],
    // Ejecutivo que toma los deals y cotizaciones de Vicky MX (equivalente a
    // Anderson Díaz en Chile / Alejandro Gordillo en Colombia).
    ejecutivo: {
      nombre: "Yahel Segura",
      email: "ysegura@geovictoria.com",
      telefono: "+52 55 3763 6604", // Ficha de usuario en Zoho, verificada 27-jul.
    },
  },

  cotizadorHabilitado: false,
}
