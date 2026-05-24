/**
 * Catálogo de hardware de marcaje de GeoVictoria.
 *
 * Replica el `catalogoEquipos` del index.html de la cotizadora oficial.
 * Para mantener paridad, los `id` deben coincidir EXACTAMENTE.
 *
 * Por defecto, solo el Sense Face 2A está habilitado para Vicky. Para
 * habilitar otro, cambiar `disponibleParaVicky: false` a `true`.
 *
 * NOTA sobre precios del Sense Face 2A en el nuevo scope 1-50:
 *   La cotizadora oficial aplica un descuento promocional por unidad según
 *   tamaño de empresa (sf2aDiscountTiers). Resumido:
 *     - 1-10 trabajadores: máx 1 unidad a precio promo (0.25 UF)
 *     - 11-20: máx 2 unidades promo
 *     - 21-30: máx 2 unidades promo
 *     - 31-50: máx 2 unidades promo
 *
 *   En Vicky asumimos por defecto 1 unidad a precio promo (0.25 UF/mes).
 *   Si el prospecto pide más unidades en la conversación, la tool
 *   cotizar_referencial genera una advertencia para que el modelo aclare
 *   al prospecto que las unidades adicionales pueden tener precio distinto,
 *   y la cotizadora oficial recalculará exactamente al abrir el link.
 */

import type { Hardware } from "./tipos"

export const CATALOGO_HARDWARE: Hardware[] = [
  // ─── HABILITADO PARA VICKY ──────────────────────────────────────────────
  {
    id: "senseface_2a",
    modelo: "Senseface 2A",
    displayName: "Sense Face 2A",
    conexion: "-",
    ventaUF: 0, // no se vende, solo arriendo
    arriendoUF: 0.25, // precio promocional aplicado a la 1ª unidad
    descripcion:
      "Dispositivo biométrico facial para marcaje sin contacto. Reconocimiento rápido, ideal para empresas que quieren un control físico además del marcaje por app.",
    modalidadesDisponibles: ["arriendo"],
    cantidadSugerida: 1,
    disponibleParaVicky: true,
  },

  // ─── DECLARADOS PERO DESHABILITADOS ─────────────────────────────────────
  // Quedan acá para mantener paridad con el catálogo oficial.
  // Eduardo puede habilitar uno cambiando el flag.

  {
    id: "armorpad",
    modelo: "ARMORPAD",
    displayName: "ARMORPAD",
    conexion: "-",
    ventaUF: 8,
    arriendoUF: 1,
    descripcion: "Terminal robusto para entornos industriales.",
    modalidadesDisponibles: ["venta", "arriendo"],
    cantidadSugerida: 1,
    disponibleParaVicky: false,
  },
  {
    id: "ct58",
    modelo: "CT58",
    displayName: "CT58 (4G/Wifi)",
    conexion: "4G/Wifi",
    ventaUF: 8,
    arriendoUF: 1,
    descripcion: "Terminal con conectividad 4G y Wifi.",
    modalidadesDisponibles: ["venta", "arriendo"],
    cantidadSugerida: 1,
    disponibleParaVicky: false,
  },
  {
    id: "in01a_4glan",
    modelo: "IN01-A",
    displayName: "IN01-A (4G/LAN)",
    conexion: "4G/LAN",
    ventaUF: 12,
    arriendoUF: 1.5,
    descripcion: "Terminal IN01-A con conectividad 4G y red cableada.",
    modalidadesDisponibles: ["venta", "arriendo"],
    cantidadSugerida: 1,
    disponibleParaVicky: false,
  },
  {
    id: "in01a_lan",
    modelo: "IN01-A",
    displayName: "IN01-A (LAN)",
    conexion: "LAN",
    ventaUF: 7,
    arriendoUF: 0.88,
    descripcion: "Terminal IN01-A con red cableada.",
    modalidadesDisponibles: ["venta", "arriendo"],
    cantidadSugerida: 1,
    disponibleParaVicky: false,
  },
  {
    id: "in01a_lanwifi",
    modelo: "IN01-A",
    displayName: "IN01-A (LAN/WIFI)",
    conexion: "LAN/WIFI",
    ventaUF: 8,
    arriendoUF: 1,
    descripcion: "Terminal IN01-A con LAN y Wifi.",
    modalidadesDisponibles: ["venta", "arriendo"],
    cantidadSugerida: 1,
    disponibleParaVicky: false,
  },
  {
    id: "mb10vl",
    modelo: "MB10-VL",
    displayName: "MB10-VL (WIFI/LAN)",
    conexion: "WIFI/LAN",
    ventaUF: 3.5,
    arriendoUF: 0.5,
    descripcion: "Terminal económico con Wifi y LAN.",
    modalidadesDisponibles: ["venta", "arriendo"],
    cantidadSugerida: 1,
    disponibleParaVicky: false,
  },
  {
    id: "mb560vl",
    modelo: "MB560-vl",
    displayName: "MB560-vl (WIFI/LAN)",
    conexion: "WIFI/LAN",
    ventaUF: 5,
    arriendoUF: 0.6,
    descripcion: "Terminal con Wifi y LAN.",
    modalidadesDisponibles: ["venta", "arriendo"],
    cantidadSugerida: 1,
    disponibleParaVicky: false,
  },
  {
    id: "s922",
    modelo: "S922",
    displayName: "S922 (4G)",
    conexion: "4G",
    ventaUF: 20,
    arriendoUF: 2.5,
    descripcion: "Terminal premium con conectividad 4G.",
    modalidadesDisponibles: ["venta", "arriendo"],
    cantidadSugerida: 1,
    disponibleParaVicky: false,
  },
  {
    id: "senseface_3a",
    modelo: "Senseface 3A",
    displayName: "Senseface 3A (WIFI/LAN)",
    conexion: "WIFI/LAN",
    ventaUF: 7,
    arriendoUF: 0.65,
    descripcion: "Biométrico facial con Wifi y LAN.",
    modalidadesDisponibles: ["venta", "arriendo"],
    cantidadSugerida: 1,
    disponibleParaVicky: false,
  },
  {
    id: "senseface_4a",
    modelo: "Senseface 4A",
    displayName: "Senseface 4A",
    conexion: "-",
    ventaUF: 8.5,
    arriendoUF: 0.75,
    descripcion: "Biométrico facial generación 4A.",
    modalidadesDisponibles: ["venta", "arriendo"],
    cantidadSugerida: 1,
    disponibleParaVicky: false,
  },
  {
    id: "senseface_7a",
    modelo: "Senseface 7A",
    displayName: "Senseface 7A (WIFI/LAN)",
    conexion: "WIFI/LAN",
    ventaUF: 10,
    arriendoUF: 0.8,
    descripcion: "Biométrico facial gama alta con Wifi y LAN.",
    modalidadesDisponibles: ["venta", "arriendo"],
    cantidadSugerida: 1,
    disponibleParaVicky: false,
  },
  {
    id: "speedface_v4l",
    modelo: "SpeedFace V4L",
    displayName: "SpeedFace V4L (WIFI/LAN)",
    conexion: "WIFI/LAN",
    ventaUF: 5,
    arriendoUF: 0.6,
    descripcion: "Biométrico facial SpeedFace V4L.",
    modalidadesDisponibles: ["venta", "arriendo"],
    cantidadSugerida: 1,
    disponibleParaVicky: false,
  },
  {
    id: "speedface_v5l",
    modelo: "SpeedFace V5L",
    displayName: "SpeedFace V5L (WIFI/LAN)",
    conexion: "WIFI/LAN",
    ventaUF: 12,
    arriendoUF: 1.5,
    descripcion: "Biométrico facial SpeedFace V5L gama alta.",
    modalidadesDisponibles: ["venta", "arriendo"],
    cantidadSugerida: 1,
    disponibleParaVicky: false,
  },
  {
    id: "uru4500",
    modelo: "URU4500",
    displayName: "URU4500 (USB)",
    conexion: "USB",
    ventaUF: 3,
    arriendoUF: 0.25,
    descripcion: "Lector USB para conexión a PC.",
    modalidadesDisponibles: ["venta", "arriendo"],
    cantidadSugerida: 1,
    disponibleParaVicky: false,
  },
  {
    id: "x628c",
    modelo: "X628-C",
    displayName: "X628-C (LAN)",
    conexion: "LAN",
    ventaUF: 5,
    arriendoUF: 0.6,
    descripcion: "Terminal con red cableada.",
    modalidadesDisponibles: ["venta", "arriendo"],
    cantidadSugerida: 1,
    disponibleParaVicky: false,
  },
]
