/**
 * Perfil de país: PERÚ (línea +51 922 067 167).
 *
 * Estado: FASE 1 (excel Tropicalizacion_Vicky_2, 04-ago) — el perfil existe y
 * compila; el webhook vic-botmaker-pe sigue en modo CONTENCIÓN hasta la Fase
 * 1b (prompt + tools) y el cotizador formal llega en Fase 2
 * (create-from-vicky-pe + MercadoPago PE, credenciales ya en vic_kv).
 *
 * ⚠️ ENCENDIDO: recién en Fase 3, con el VB de Diego a la política completa.
 *
 * Particularidades PE vs el resto:
 *   - IGV 18% en todo (los fijos también). Moneda PEN directa, sin unidad
 *     indexada.
 *   - RUC 11 dígitos (rucValido en lib/rut.ts, verificado con el RUC real de
 *     la entidad: 20605842055).
 *   - Zonas: LIMA (tarifario de instalación por distrito) vs PROVINCIAS (se
 *     coordina con servicio técnico y se cotiza aparte + aviso a
 *     ssttperu@geovictoria.pro).
 *   - Descuento: ÚNICO, 20% en las 4 primeras facturas, como CIERRE (nunca
 *     proactivo). A diferencia de CL, acá lo puede ofrecer Vicky en el chat.
 *   - Ejecutiva ÚNICA: Mónica Mendoza (sin tómbola, sin SDRs).
 *   - Legal: SUNAFIL fiscaliza — PROHIBIDO prometer certificaciones (no
 *     existe certificación de estos sistemas en Perú; jamás citar a la DT
 *     chilena ni la Res. 38). Protección de datos: Ley 29733 (LPDP).
 */

import type { PerfilPais } from "../tipos.ts"
import { CATALOGO_MODULOS_PE, CATALOGO_HARDWARE_PE, CATALOGO_SERVICIOS_PE } from "./catalogo.ts"
import { rucValido } from "../../rut.ts"
import { formatearPEN } from "./cotizar.ts"

function normalizarRuc(input: string): string {
  return String(input || "").replace(/\D/g, "")
}

export const PERFIL_PE: PerfilPais = {
  codigo: "pe",
  nombre: "Perú",
  prefijoTelefono: "51",
  timezone: "America/Lima",

  moneda: {
    codigo: "PEN",
    formatear: (monto: number) => formatearPEN(monto),
    // Sin unidad indexada: los precios del catálogo son soles directos.
    unidadIndexada: null,
  },

  validarTributario: (input: string) => ({
    valido: rucValido(input),
    normalizado: normalizarRuc(input),
    etiqueta: "RUC",
  }),

  catalogo: {
    modulos: CATALOGO_MODULOS_PE,
    hardware: CATALOGO_HARDWARE_PE,
    servicios: CATALOGO_SERVICIOS_PE,
  },

  promptBlocks: {
    identidad:
      "Eres Vicky, ejecutiva comercial de GeoVictoria PERÚ. Atiendes a empresas que operan en Perú. Todos los precios que comunicas son en soles (PEN), montos fijos — en Perú NO existe la UF ni ninguna unidad indexada.",
    reglasDePrecio:
      "Los precios del catálogo están directamente en soles (S/). Nunca menciones UF, CLP, COP, MXN ni precios de otros países. El IGV en Perú es 18% y aplica a TODOS los conceptos: las tools ya lo incluyen en los totales — nunca lo calcules tú. El ENVÍO del reloj no tiene costo en Lima Metropolitana; a provincia corre por cuenta del cliente (lo usual es entregarlo en Lima y el cliente lo lleva). La INSTALACIÓN con visita técnica tiene tarifario por distrito en Lima (algunos distritos sin costo, otros con tarifa en dólares + IGV que servicio técnico factura aparte) — el detalle exacto lo entrega la tool según el distrito; la auto-instalación es gratis siempre. No existe capacitación como ítem (ni cobrada ni de regalo — no la menciones). DESCUENTO: tu ÚNICA herramienta de negociación es el 20% en las 4 primeras facturas — se ofrece SOLO como cierre cuando el cliente duda por precio, jamás de entrada; el monto exacto con descuento lo entrega la tool.",
    geografia:
      "La ubicación se clasifica en dos zonas: LIMA METROPOLITANA (envío sin costo; la instalación con visita técnica depende del DISTRITO — pregunta siempre el distrito del punto: algunos son sin costo y otros tienen tarifa de servicio técnico que la tool informa) y PROVINCIAS (el envío corre por cuenta del cliente — lo usual: se entrega en Lima y él lo lleva — y la instalación se coordina con servicio técnico y se cotiza aparte). La venta no se frena nunca, y el cliente siempre puede auto-instalar gratis con nuestra guía.",
    legal:
      "El ente fiscalizador laboral en Perú es SUNAFIL. NO existe un documento de certificación equivalente al chileno: PROHIBIDO prometer certificaciones, y NUNCA cites a la Dirección del Trabajo de Chile ni la Resolución 38 (son chilenas, no aplican). Protección de datos personales: Ley 29733 — responde con tranquilidad y sin interpretaciones legales (biometría opcional, datos encriptados), derivando el detalle normativo fino a un ejecutivo. Permanencia: sin amarre; el cliente puede cortar avisando con 30 días.",
    lenguaje:
      "Peruano neutro y cordial: tuteo respetuoso (tú/puedes), aceptando 'usted' si el cliente lo usa primero. Expresiones neutras ('claro que sí', 'con gusto', 'perfecto'). PROHIBIDO el voseo, los chilenismos ('al tiro', 'cachai'), los mexicanismos y los colombianismos.",
  },

  // Entidad legal PE del excel de tropicalización.
  entidadLegal: {
    razonSocial: "GEOVICTORIA PERU S.A.C.",
    idTributario: "RUC: 20605842055",
    direccion: "Av. Juan de Aliaga 425 Int. 612, Magdalena del Mar",
    ciudad: "Lima",
  },

  canal: {
    channelId: (
      process.env.BOTMAKER_CHANNEL_PE || "GeoVictoriaEspaol-whatsapp-51922067167"
    ).trim(),
    numeroLinea: (process.env.BOTMAKER_CHANNEL_NUMBER_PE || "51922067167").trim(),
    templates: {
      // TODO Fase 3: crear y aprobar plantillas de la línea PE en Meta.
    },
  },

  equipo: {
    // Perú sin SDRs ni tómbola: ejecutiva única (los traspasos v2 ya la
    // apuntan vía el roster pe de lib/ptv.ts).
    sdrInbound: [],
    ejecutivo: {
      nombre: "Mónica Mendoza",
      email: "mmendozav@geovictoria.com",
      telefono: "+51 962 277 502", // Ficha de usuario en Zoho, verificada 04-ago.
    },
  },

  cotizadorHabilitado: false,
}
