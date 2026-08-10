/**
 * CATÁLOGO DEL CANAL EJECUTIVO — la calculadora de Nacho (gv-cotizador),
 * transcrita 1:1 el 10-ago-2026 desde calculadora.html (generada por main.py
 * desde precios.xlsx). Fuente de verdad del agente "Cotizadora de Ejecutivos".
 *
 * PRINCIPIO 0 (Lalo): este catálogo es INDEPENDIENTE del de Vicky vendedora
 * (lib/catalogo/) — cada canal su lista. Acá 1-10 usuarios = 0,75 UF fijo;
 * en la de Vicky, 0,25/0,6. No unificar jamás sin orden explícita.
 *
 * Todo en UF. La conversión a CLP ocurre al EMITIR con la UF del día
 * (getUFActualSafe del cotizador) y queda congelada en la cotización.
 */

export type TramoUF = {
  min: number
  max: number
  tipo: "fijo" | "por_usuario"
  uf: number
}

/** Tope de descuento por línea en TODO el catálogo (input max=25 en la UI). */
export const MAX_DESCUENTO_PCT = 25

/** Dotación máxima cotizable por el canal ejecutivo. */
export const MAX_USUARIOS = 8000

// ── Asistencia (producto core) ────────────────────────────────────────────
export const TRAMOS_ASISTENCIA: TramoUF[] = [
  { min: 1, max: 10, tipo: "fijo", uf: 0.75 },
  { min: 11, max: 20, tipo: "por_usuario", uf: 0.09 },
  { min: 21, max: 30, tipo: "por_usuario", uf: 0.08 },
  { min: 31, max: 50, tipo: "por_usuario", uf: 0.07 },
  { min: 51, max: 100, tipo: "por_usuario", uf: 0.065 },
  { min: 101, max: 200, tipo: "por_usuario", uf: 0.06 },
  { min: 201, max: 500, tipo: "por_usuario", uf: 0.055 },
  { min: 501, max: 1000, tipo: "por_usuario", uf: 0.05 },
  { min: 1001, max: 3000, tipo: "por_usuario", uf: 0.045 },
  { min: 3001, max: 5000, tipo: "por_usuario", uf: 0.04 },
  { min: 5001, max: 8000, tipo: "por_usuario", uf: 0.035 },
]

// ── Add-ons de Asistencia (UF por usuario/mes, precio plano) ─────────────
export const ADDONS = {
  alertas: { nombre: "Alertas", uf: 0.019 },
  banco: { nombre: "Banco de Horas", uf: 0.05 },
  calendario: { nombre: "Calendario Inteligente", uf: 0.014 },
  documental: { nombre: "Gestión Documental", uf: 0.012 },
  vacaciones: { nombre: "Vacaciones y Permisos", uf: 0.022 },
  appsupervisores: { nombre: "App de Supervisores", uf: 0.015 },
  appcuadrillas: { nombre: "App Cuadrillas", uf: 0.015 },
} as const
export type AddonId = keyof typeof ADDONS

// ── Otros servicios (tramos propios) ─────────────────────────────────────
export const REPORTE_MIN_USUARIOS = 5
export const TRAMOS_REPORTE: TramoUF[] = [
  { min: 5, max: 10, tipo: "por_usuario", uf: 0.015 },
  { min: 11, max: 20, tipo: "por_usuario", uf: 0.013 },
  { min: 21, max: 50, tipo: "por_usuario", uf: 0.012 },
  { min: 51, max: 100, tipo: "por_usuario", uf: 0.01 },
  { min: 101, max: 200, tipo: "por_usuario", uf: 0.009 },
  { min: 201, max: 500, tipo: "por_usuario", uf: 0.008 },
  { min: 501, max: 1000, tipo: "por_usuario", uf: 0.007 },
  { min: 1001, max: 3000, tipo: "por_usuario", uf: 0.006 },
  { min: 3001, max: 8000, tipo: "por_usuario", uf: 0.006 },
]

export const VICTORIA_MIN_USUARIOS = 5
export const TRAMOS_VICTORIA_CONNECT: TramoUF[] = [
  { min: 5, max: 10, tipo: "por_usuario", uf: 0.017 },
  { min: 11, max: 20, tipo: "por_usuario", uf: 0.015 },
  { min: 21, max: 50, tipo: "por_usuario", uf: 0.012 },
  { min: 51, max: 100, tipo: "por_usuario", uf: 0.01 },
  { min: 101, max: 200, tipo: "por_usuario", uf: 0.007 },
  { min: 201, max: 500, tipo: "por_usuario", uf: 0.006 },
  { min: 501, max: 1000, tipo: "por_usuario", uf: 0.005 },
  { min: 1001, max: 3000, tipo: "por_usuario", uf: 0.004 },
  { min: 3001, max: 8000, tipo: "por_usuario", uf: 0.003 },
]

export const TRAMOS_CASINO: TramoUF[] = [
  { min: 1, max: 20, tipo: "fijo", uf: 1.261 },
  { min: 21, max: 50, tipo: "fijo", uf: 2.101 },
  { min: 51, max: 100, tipo: "fijo", uf: 2.941 },
  { min: 101, max: 200, tipo: "fijo", uf: 3.782 },
  { min: 201, max: 500, tipo: "fijo", uf: 4.622 },
  { min: 501, max: 1000, tipo: "fijo", uf: 5.462 },
  { min: 1001, max: 1500, tipo: "fijo", uf: 6.303 },
  { min: 1501, max: 2000, tipo: "fijo", uf: 7.143 },
  { min: 2001, max: 2500, tipo: "fijo", uf: 7.983 },
  { min: 2501, max: 3000, tipo: "fijo", uf: 8.824 },
  { min: 3001, max: 3500, tipo: "fijo", uf: 9.664 },
  { min: 3501, max: 4000, tipo: "fijo", uf: 10.504 },
  { min: 4001, max: 4500, tipo: "fijo", uf: 11.345 },
  { min: 4501, max: 5000, tipo: "fijo", uf: 12.185 },
]

export const TRAMOS_DASHBOARD_BI: TramoUF[] = [
  { min: 1, max: 50, tipo: "fijo", uf: 1.25 },
  { min: 51, max: 100, tipo: "fijo", uf: 2.5 },
  { min: 101, max: 200, tipo: "fijo", uf: 5.5 },
  { min: 201, max: 500, tipo: "fijo", uf: 9.6 },
  { min: 501, max: 1000, tipo: "fijo", uf: 14.4 },
  { min: 1001, max: 1500, tipo: "por_usuario", uf: 0.018 },
  { min: 1501, max: 2000, tipo: "por_usuario", uf: 0.017 },
  { min: 2001, max: 2500, tipo: "por_usuario", uf: 0.016 },
  { min: 2501, max: 3000, tipo: "por_usuario", uf: 0.015 },
  { min: 3001, max: 3500, tipo: "por_usuario", uf: 0.014 },
  { min: 3501, max: 4000, tipo: "por_usuario", uf: 0.013 },
  { min: 4001, max: 4500, tipo: "por_usuario", uf: 0.012 },
  { min: 4501, max: 5000, tipo: "por_usuario", uf: 0.011 },
  { min: 5001, max: 5500, tipo: "por_usuario", uf: 0.01 },
]

export const OTROS_SERVICIOS = {
  reporte: { nombre: "Reporte a Medida", tramos: TRAMOS_REPORTE, minUsuarios: REPORTE_MIN_USUARIOS },
  victoria: { nombre: "Victoria Connect", tramos: TRAMOS_VICTORIA_CONNECT, minUsuarios: VICTORIA_MIN_USUARIOS },
  casino: { nombre: "Casino", tramos: TRAMOS_CASINO, minUsuarios: 1 },
  dashboard: { nombre: "Dashboard BI", tramos: TRAMOS_DASHBOARD_BI, minUsuarios: 1 },
} as const
export type OtroServicioId = keyof typeof OTROS_SERVICIOS

// ── Equipos (venta / arriendo mensual, UF) ───────────────────────────────
export type Equipo = { id: string; nombre: string; venta: number; arriendo: number }
export const EQUIPOS: Equipo[] = [
  { id: "armorpad", nombre: "ARMORPAD", venta: 8, arriendo: 1 },
  { id: "ct58", nombre: "CT58 (4G/Wifi)", venta: 8, arriendo: 1 },
  { id: "in01a_4glan", nombre: "IN01-A (4G/LAN)", venta: 12, arriendo: 1.5 },
  { id: "in01a_lan", nombre: "IN01-A (LAN)", venta: 7, arriendo: 0.88 },
  { id: "in01a_lanwifi", nombre: "IN01-A (LAN/WIFI)", venta: 8, arriendo: 1 },
  { id: "mb10vl", nombre: "MB10-VL (WIFI/LAN)", venta: 3.5, arriendo: 0.5 },
  { id: "mb560vl", nombre: "MB560-vl (WIFI/LAN)", venta: 5, arriendo: 0.6 },
  { id: "s922", nombre: "S922 (4G)", venta: 20, arriendo: 2.5 },
  { id: "senseface_2a", nombre: "Senseface 2A", venta: 0, arriendo: 0.35 },
  { id: "senseface_3a", nombre: "Senseface 3A (WIFI/LAN)", venta: 7, arriendo: 0.65 },
  { id: "senseface_4a", nombre: "Senseface 4A", venta: 8.5, arriendo: 0.75 },
  { id: "senseface_7a", nombre: "Senseface 7A (WIFI/LAN)", venta: 10, arriendo: 0.8 },
  { id: "speedface_v4l", nombre: "SpeedFace V4L (WIFI/LAN)", venta: 5, arriendo: 0.6 },
  { id: "speedface_v5l", nombre: "SpeedFace V5L (WIFI/LAN)", venta: 12, arriendo: 1.5 },
  { id: "uru4500", nombre: "URU4500 (USB)", venta: 3, arriendo: 0.25 },
  { id: "x628c", nombre: "X628-C (LAN)", venta: 5, arriendo: 0.6 },
]

export const ACCESORIOS: Equipo[] = [
  { id: "controladora", nombre: "Controladora", venta: 11, arriendo: 1.8 },
  { id: "enchufe_magic", nombre: "Enchufe Magic", venta: 0.4, arriendo: 0 },
  { id: "gabinete_impresora", nombre: "Gabinete Impresora Térmica Nueva", venta: 3, arriendo: 0.5 },
  { id: "gabinete_lector", nombre: "Gabinete Lector de Carnet", venta: 2, arriendo: 0.3 },
  { id: "gabinete_chico", nombre: "Gabinete chico nueva generación", venta: 4, arriendo: 0.3 },
  { id: "lector_mifare", nombre: "Lector Tarjetas MIFARE", venta: 3, arriendo: 0 },
  { id: "vuquest_3320g", nombre: "Lector de CI/Barra - Vuquest 3320g", venta: 7, arriendo: 1.2 },
  { id: "lector_hid_kr10", nombre: "Lector de tarjetas HID Wiegand KR10", venta: 2, arriendo: 0 },
  { id: "mini_ups_12v", nombre: "Mini UPS 12V", venta: 2, arriendo: 0.3 },
  { id: "mini_ups_5v", nombre: "Mini UPS 5V", venta: 2, arriendo: 0.3 },
  { id: "router_industrial", nombre: "Router Industrial", venta: 5, arriendo: 0.3 },
  { id: "sim_mint", nombre: "SIM Mint", venta: 0.5, arriendo: 0.5 },
  { id: "slk_tl202ii", nombre: "SLK-TL202II", venta: 7, arriendo: 1.2 },
  { id: "tarjeta_hid", nombre: "Tarjeta HID", venta: 0.06, arriendo: 0 },
  { id: "tarjeta_id_1", nombre: "Tarjeta ID", venta: 0.03, arriendo: 0 },
  { id: "tarjeta_id_2", nombre: "Tarjeta ID (alt)", venta: 0.04, arriendo: 0 },
  { id: "totem_reloj", nombre: "Tótem Reloj Gama Alta", venta: 8, arriendo: 1.3 },
]

// ── Servicios asociados (SIEMPRE pago único) — precio default y MÍNIMO por
// zona (RM/región) y modalidad del hardware al que acompañan ──────────────
export type ServicioAsociadoId = "envio" | "instalacion" | "homologacion"
export const SERVICIOS_ASOCIADOS: Record<
  ServicioAsociadoId,
  { nombre: string; def: Record<"venta" | "arriendo", Record<"rm" | "region", number>>; min: Record<"venta" | "arriendo", Record<"rm" | "region", number>> }
> = {
  envio: {
    nombre: "Envío",
    def: { venta: { rm: 0.7, region: 0.7 }, arriendo: { rm: 0.5, region: 0.5 } },
    min: { venta: { rm: 0.7, region: 0.7 }, arriendo: { rm: 0, region: 0 } },
  },
  instalacion: {
    nombre: "Instalación",
    def: { venta: { rm: 2, region: 5 }, arriendo: { rm: 1, region: 4 } },
    min: { venta: { rm: 2, region: 5 }, arriendo: { rm: 1, region: 4 } },
  },
  homologacion: {
    nombre: "Homologación de equipo",
    def: { venta: { rm: 0.3, region: 0.3 }, arriendo: { rm: 0.3, region: 0.3 } },
    min: { venta: { rm: 0.3, region: 0.3 }, arriendo: { rm: 0.3, region: 0.3 } },
  },
}

// ── Promociones ──────────────────────────────────────────────────────────
/** Asistencia (1-10) + un add-on elegible = 1 UF fijo total. Banco de Horas
 * JAMÁS es elegible (decisión de negocio explícita de gv-cotizador). */
export const PROMO_ASISTENCIA_ADDON_UF = 1.0
export const PROMO_ASISTENCIA_ADDON_MAX_USUARIOS = 10
export const PROMO_ADDON_EXCLUIDO: AddonId = "banco"

/** Senseface 2A promocional: arriendo 0,30 (lista 0,35), con tope de unidades
 * promocionadas según el tramo de usuarios de Asistencia. */
export const PROMO_SF2A_UF = 0.3
export const SF2A_TOPE_PROMO: Array<{ min: number; max: number; unidades: number }> = [
  { min: 1, max: 10, unidades: 1 },
  { min: 11, max: 20, unidades: 2 },
  { min: 21, max: 30, unidades: 2 },
  { min: 31, max: 50, unidades: 2 },
  { min: 51, max: 100, unidades: 3 },
  { min: 101, max: 200, unidades: 3 },
  { min: 201, max: 500, unidades: 4 },
  { min: 501, max: 1000, unidades: 4 },
  { min: 1001, max: 3000, unidades: 4 },
  { min: 3001, max: 5000, unidades: 5 },
  { min: 5001, max: 8000, unidades: 5 },
]

/** Kit con lector QR (jul-2026): SF3A + gabinete lector CI + Vuquest, arriendo
 * mensual del kit completo. */
export const KIT_QR_ARRIENDO_UF = 1.8

/** Bundle IN01 4G/LAN + impresora térmica + gabinetes (jul-2026). */
export const IN01_BUNDLE_UF = { venta: 27.0, arriendo: 3.4 }

export function tramoDe(tramos: TramoUF[], usuarios: number): TramoUF | null {
  return tramos.find((t) => usuarios >= t.min && usuarios <= t.max) || null
}
