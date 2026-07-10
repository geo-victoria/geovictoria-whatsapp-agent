/**
 * Perfil de país: CHILE (línea +56 9 6730 8227).
 *
 * Primer perfil del modelo multi-país — envuelve las piezas que ya existían
 * (catálogo, RUT, UF, canal Botmaker, SDRs) sin cambiarles el comportamiento.
 * Los promptBlocks documentan lo país-específico del prompt actual; se irán
 * consumiendo a medida que el núcleo del prompt se limpie de chilenismos.
 */

import type { PerfilPais } from "../tipos"
import { CATALOGO_MODULOS } from "../../catalogo/modulos"
import { CATALOGO_HARDWARE } from "../../catalogo/hardware"
import { CATALOGO_SERVICIOS } from "../../catalogo/servicios"
import { rutValido, normalizarRut } from "../../rut"
import { getUFActual } from "../../uf"

function formatearCLP(monto: number): string {
  return "$" + Math.round(monto).toLocaleString("es-CL")
}

export const PERFIL_CL: PerfilPais = {
  codigo: "cl",
  nombre: "Chile",
  prefijoTelefono: "56",
  timezone: "America/Santiago",

  moneda: {
    codigo: "CLP",
    formatear: formatearCLP,
    unidadIndexada: {
      nombre: "UF",
      obtenerValor: getUFActual,
    },
  },

  validarTributario: (input: string) => ({
    valido: rutValido(input),
    normalizado: normalizarRut(input),
    etiqueta: "RUT",
  }),

  catalogo: {
    modulos: CATALOGO_MODULOS,
    hardware: CATALOGO_HARDWARE,
    servicios: CATALOGO_SERVICIOS,
  },

  promptBlocks: {
    identidad:
      "Eres Vicky, ejecutiva comercial de GeoVictoria CHILE. Atiendes a empresas que operan en Chile. Todos los precios que comunicas son en pesos chilenos (CLP) con referencia en UF.",
    reglasDePrecio:
      "Los precios del catálogo están en UF y se convierten a CLP con la UF del día (la conversión la hacen las tools, nunca tú). El plan se factura en UF: el monto en CLP puede variar mes a mes. IVA 19% se agrega donde corresponde (las tools ya lo calculan).",
    geografia:
      "La ubicación de los relojes se clasifica en Chile: RM vs regiones para el envío, y tres zonas para la instalación (RM / Coquimbo-Valparaíso-O'Higgins / resto). Las comunas chilenas las resuelve la tool, tú solo transcribes.",
    legal:
      "GeoVictoria está autorizado por la Dirección del Trabajo de Chile (Resolución Exenta N°38); ante dudas normativas existe la tool enviar_certificacion. Nueva ley de protección de datos: el trabajador puede marcar sin biometría (patrón/contraseña en la app); los datos están encriptados.",
    lenguaje:
      "Español chileno cercano y profesional: tuteo simple, sin voseo verbal (-ái/-ís), sin 'po'/'cachái'/'al tiro', sin '¡' ni '¿' de apertura.",
  },

  entidadLegal: {
    razonSocial: "Victoria S.A",
    idTributario: "R.U.T: 76.188.587-1",
    direccion: "Avenida Los Leones 2061, Piso 4, Providencia",
    ciudad: "Santiago",
  },

  canal: {
    channelId: (process.env.BOTMAKER_CHANNEL_V3 || "").trim(),
    numeroLinea: (process.env.BOTMAKER_CHANNEL_NUMBER || "56967308227").trim(),
    templates: {
      leadApertura: (process.env.OUTBOUND_TEMPLATE_LEAD || "").trim() || undefined,
      leadNudge: (process.env.OUTBOUND_TEMPLATE_NUDGE || "vicky_lead_nudge").trim(),
      leadCierre: (process.env.OUTBOUND_TEMPLATE_CIERRE || "vicky_lead_cierre").trim(),
    },
  },

  equipo: {
    sdrInbound: [
      { email: "aaraque@geovictoria.com", zohoUserId: "3525045000583802005" },
      { email: "asepulveda@geovictoria.com", zohoUserId: "3525045000594735052" },
    ],
    ejecutivo: {
      nombre: "Anderson Díaz",
      email: "adiazg@geovictoria.com",
      telefono: "+56 9 3937 2058",
    },
  },

  cotizadorHabilitado: true,
}
