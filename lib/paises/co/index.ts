/**
 * Perfil de país: COLOMBIA (línea +57 318 107 0737).
 *
 * Estado: EN CONSTRUCCIÓN — el perfil existe y compila, pero la línea aún no
 * apunta al agente (falta crear flow + acción de código en Botmaker) y el
 * cotizador CO no está habilitado. Ver TODOs.
 *
 * TODO antes de encender:
 *   1. channelId real del canal +57 en Botmaker (al crear la acción de código).
 *   2. Definiciones de catálogo pendientes (ver co/catalogo.ts).
 *   3. Emails de los SDR CO (los zohoUserId ya están: tómbola Galindo/
 *      Guerrero/Quiroga observada en Zoho el 09-jul).
 *   4. Ejecutivo comercial CO para PDF/correos (¿quién acompaña como Anderson
 *      en Chile?).
 *   5. Plantillas HSM de la línea CO (apertura/nudge/cierre) aprobadas por Meta.
 *   6. Cotizador CO (moneda COP sin unidad indexada, entidad legal, pago) →
 *      recién ahí cotizadorHabilitado = true.
 */

import type { PerfilPais } from "../tipos"
import { CATALOGO_MODULOS_CO, CATALOGO_HARDWARE_CO, CATALOGO_SERVICIOS_CO } from "./catalogo"
import { nitValido, normalizarNit } from "./nit"

function formatearCOP(monto: number): string {
  return "$" + Math.round(monto).toLocaleString("es-CO") + " COP"
}

export const PERFIL_CO: PerfilPais = {
  codigo: "co",
  nombre: "Colombia",
  prefijoTelefono: "57",
  timezone: "America/Bogota",

  moneda: {
    codigo: "COP",
    formatear: formatearCOP,
    // Sin unidad indexada: los precios del catálogo son COP directos.
    unidadIndexada: null,
  },

  validarTributario: (input: string) => ({
    valido: nitValido(input),
    normalizado: normalizarNit(input),
    etiqueta: "NIT",
  }),

  catalogo: {
    modulos: CATALOGO_MODULOS_CO,
    hardware: CATALOGO_HARDWARE_CO,
    servicios: CATALOGO_SERVICIOS_CO,
  },

  promptBlocks: {
    identidad:
      "Eres Vicky, ejecutiva comercial de GeoVictoria COLOMBIA. Atiendes a empresas que operan en Colombia. Todos los precios que comunicas son en pesos colombianos (COP), montos fijos — en Colombia NO existe la UF ni ninguna unidad indexada.",
    reglasDePrecio:
      "Los precios del catálogo están directamente en pesos colombianos (COP). Nunca menciones UF, CLP ni precios de otros países. Ventaja comercial clave del arriendo en Colombia: el envío y la instalación del reloj son GRATIS (solo se cobran en modalidad venta).", // TODO: IVA neto/incluido según definición.
    geografia:
      "Para envío e instalación del reloj (solo en modalidad venta) la ubicación se clasifica en dos zonas: capital y resto del país.", // TODO: definir cobertura exacta de "capital".
    legal:
      "El ente fiscalizador laboral en Colombia es el Ministerio del Trabajo (Dirección de Inspección, Vigilancia, Control y Gestión Territorial). NO existe un documento de certificación equivalente al chileno y NUNCA cites a la Dirección del Trabajo de Chile ni la Resolución 38 (son chilenas, no aplican). Permanencia: sin amarre; el cliente puede cortar avisando con 30 días.",
    lenguaje:
      "Español neutro con cortesía colombiana: trato de 'usted' como forma segura por defecto (cambia a tuteo solo si el cliente tutea primero). Nada de chilenismos ni localismos de otros países.",
  },

  canal: {
    channelId: (process.env.BOTMAKER_CHANNEL_CO || "").trim(), // TODO: setear al crear el canal en Botmaker
    numeroLinea: (process.env.BOTMAKER_CHANNEL_NUMBER_CO || "573181070737").trim(),
    templates: {
      // TODO: crear y aprobar plantillas de la línea CO en Meta.
    },
  },

  equipo: {
    // Tómbola SDR Colombia observada en Zoho (leads +57, 09-jul-2026).
    // TODO: confirmar emails.
    sdrInbound: [
      { email: "", zohoUserId: "3525045000613817111" }, // Galindo
      { email: "", zohoUserId: "3525045000619732095" }, // Guerrero
      { email: "", zohoUserId: "3525045000639899035" }, // Quiroga Chia
    ],
    // Tropicalización (líderes comerciales): ejecutiva de referencia CO.
    // TODO: confirmar correo — la planilla dice lvargas@, las cotizaciones
    // reales de Creator dicen lvargash@ (Laura Lucía Vargas Hernández).
    ejecutivo: {
      nombre: "Laura Vargas",
      email: "lvargash@geovictoria.com",
      telefono: "+57 310 609 5259",
    },
  },

  cotizadorHabilitado: false,
}
