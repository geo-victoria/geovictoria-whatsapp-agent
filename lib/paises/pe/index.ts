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
 *   - Zonas: LIMA METROPOLITANA (envío incluido; instalación incluida en
 *     arriendo, US$43 en venta) vs PROVINCIAS (envío US$30 en venta /
 *     incluido en arriendo a US$23; instalación US$214) — precio cerrado en
 *     toda zona (Lalo 22-sep) + aviso a ssttperu@geovictoria.pro cuando el
 *     cliente pide la visita.
 *   - Descuento: escalera chilena 10 → 20 % en el plan por 6 meses, SOLO ante objeción (nunca
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
import { channelIdPorPais, NUMERO_LINEA } from "../../linea-por-pais.ts"

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
      "Los precios del catálogo están directamente en soles (S/). Nunca menciones UF, CLP, COP, MXN ni precios de otros países. El IGV en Perú es 18% y aplica a TODOS los conceptos: las tools ya lo incluyen en los totales — nunca lo calcules tú. El ENVÍO del reloj va incluido en Lima Metropolitana y en el arriendo a provincia (ahí la tarifa mensual ya trae el despacho); en VENTA a provincia es una línea de pago único que la tool calcula — nunca digas que el envío lo asume el cliente. La INSTALACIÓN técnica va incluida en arriendo en Lima Metropolitana; en venta y en provincia tiene precio cerrado por zona que la tool entrega (jamás se cotiza aparte); la auto-instalación es gratis siempre. No existe capacitación como ítem (ni cobrada ni de regalo — no la menciones). DESCUENTO: tu única herramienta de negociación es la escalera 10% → 20% sobre el plan mensual por 6 meses — se ofrece SOLO ante una objeción de precio, un escalón por vez, jamás de entrada; el monto exacto con descuento lo entrega la tool.",
    geografia:
      "La ubicación se clasifica en dos zonas: LIMA METROPOLITANA (envío incluido; instalación técnica incluida en arriendo y con precio cerrado en venta) y PROVINCIAS (envío e instalación con precio cerrado: envío incluido en el arriendo y línea única en venta; instalación cotizada por la tool cuando el cliente la pide). La venta no se frena nunca, y el cliente siempre puede auto-instalar gratis con nuestra guía.",
    legal:
      "El ente fiscalizador laboral en Perú es SUNAFIL. NO existe un documento de certificación equivalente al chileno: PROHIBIDO prometer certificaciones, y NUNCA cites a la Dirección del Trabajo de Chile ni la Resolución 38 (son chilenas, no aplican). Protección de datos personales: Ley 29733 — responde con tranquilidad y sin interpretaciones legales (biometría opcional, datos encriptados), derivando el detalle normativo fino a un ejecutivo. Permanencia: sin amarre; el cliente puede cortar avisando con 30 días.",
    lenguaje:
      "Peruano neutro y cordial: tuteo respetuoso (tú/puedes), aceptando 'usted' si el cliente lo usa primero. Expresiones neutras ('claro que sí', 'con gusto', 'perfecto'). PROHIBIDO el voseo, los chilenismos ('al tiro', 'cachai'), los mexicanismos y los colombianismos.",
  },

  // Entidad legal PE del excel de tropicalización.
  entidadLegal: {
    razonSocial: "GEOVICTORIA PERU S.A.C.",
    idTributario: "RUC: 20605842055",
    direccion: "Av. General Trinidad Morán 1340, Urb. Risso, Lince",
    ciudad: "Lima",
  },

  canal: {
    // Fuente única de líneas por país (15-sep): lib/linea-por-pais.ts.
    channelId: channelIdPorPais("pe"),
    numeroLinea: NUMERO_LINEA.pe,
    templates: {
      // TODO Fase 3: crear y aprobar plantillas de la línea PE en Meta.
    },
  },

  equipo: {
    // ROLES PERÚ (Lalo 15-sep): Mónica Mendoza = única telemarketing (lo
    // calificado, los deals y las cotizaciones); SDR Inbound = Ana Fiori y
    // Priscila Quispe (lo que Vicky NO logra calificar, por rotación interna
    // — Zoho no tiene regla de tómbola para PE); gestora de la venta
    // autónoma = Cecilia Valverde (lib/traspaso-postpago, kv
    // owner_venta_autonoma_pe); líder comercial Diego Bendezú, que jamás se
    // presenta al cliente (homólogo de Victoria Luna en CL). La rotación
    // real vive en zoho-leads (reasignarLeadSdrInboundPE, roster env
    // VIC_SDR_INBOUND_PE con este mismo default).
    sdrInbound: [
      { email: "afiori@geovictoria.com", zohoUserId: "3525045000299130001" }, // Ana Fiori
      { email: "pquispef@geovictoria.com", zohoUserId: "3525045000576828001" }, // Priscila Quispe
    ],
    ejecutivo: {
      nombre: "Mónica Mendoza",
      email: "mmendozav@geovictoria.com",
      telefono: "+51 962 277 502", // Ficha de usuario en Zoho, verificada 04-ago.
    },
  },

  cotizadorHabilitado: false,
}
