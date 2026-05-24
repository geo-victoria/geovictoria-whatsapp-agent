/**
 * Catálogo de módulos de software de GeoVictoria.
 *
 * Scope actual de Vicky: 1-50 trabajadores. Los tiers cubren todo ese rango.
 * Los precios están alineados con el `index.html` de la cotizadora oficial.
 *
 * Para esta etapa:
 *   - Asistencia: habilitado (base obligatoria)
 *   - Add-ons sin mínimo (vacaciones, banco, alertas, calendario, documental):
 *     habilitados con un precio uniforme por usuario hasta 8000+ (no cambian
 *     por tier en la cotizadora oficial).
 *   - Reporte / VictorIA / Casino / Dashboard: declarados pero deshabilitados.
 *     Eduardo puede habilitarlos cambiando el flag cuando quiera.
 */

import type { ModuloSoftware } from "./tipos"

export const CATALOGO_MODULOS: ModuloSoftware[] = [
  // ─── BASE OBLIGATORIA ───────────────────────────────────────────────────
  {
    id: "asistencia",
    nombre: "Control de Asistencia",
    descripcion:
      "Marcaje de entrada y salida con app móvil, biometría o terminales físicos. La base del producto, incluida en toda cotización.",
    tiers: [
      // Tiers tomados del index.html de la cotizadora oficial
      { minUsuarios: 1, maxUsuarios: 10, modalidad: "fijo", precioUF: 0.75 },
      { minUsuarios: 11, maxUsuarios: 20, modalidad: "por_usuario", precioUF: 0.09 },
      { minUsuarios: 21, maxUsuarios: 30, modalidad: "por_usuario", precioUF: 0.08 },
      { minUsuarios: 31, maxUsuarios: 50, modalidad: "por_usuario", precioUF: 0.07 },
    ],
    disponibleParaVicky: true,
  },

  // ─── ADD-ONS POR USUARIO (sin mínimo, precio plano hasta 8000+) ─────────
  // Estos add-ons en la cotizadora oficial mantienen el mismo precio
  // independientemente del rango, por eso un solo tier 1-50 alcanza para
  // el scope de Vicky.

  {
    id: "vacaciones",
    nombre: "Vacaciones y Permisos",
    descripcion:
      "Gestión de solicitudes y aprobaciones de vacaciones y permisos sin planillas Excel.",
    tiers: [{ minUsuarios: 1, maxUsuarios: 50, modalidad: "por_usuario", precioUF: 0.022 }],
    disponibleParaVicky: true,
  },
  {
    id: "banco",
    nombre: "Banco de Horas",
    descripcion:
      "Gestión de horas extras, compensaciones y saldos por trabajador. Útil para empresas con jornadas variables.",
    tiers: [{ minUsuarios: 1, maxUsuarios: 50, modalidad: "por_usuario", precioUF: 0.05 }],
    disponibleParaVicky: true,
  },
  {
    id: "alertas",
    nombre: "Alertas",
    descripcion:
      "Notificaciones automáticas a supervisores ante atrasos, ausencias o anomalías de marcaje.",
    tiers: [{ minUsuarios: 1, maxUsuarios: 50, modalidad: "por_usuario", precioUF: 0.019 }],
    disponibleParaVicky: true,
  },
  {
    id: "calendario",
    nombre: "Planificador Inteligente",
    descripcion:
      "Planificación de turnos y horarios variables. Útil para empresas con personal rotativo.",
    tiers: [{ minUsuarios: 1, maxUsuarios: 50, modalidad: "por_usuario", precioUF: 0.014 }],
    disponibleParaVicky: true,
  },
  {
    id: "documental",
    nombre: "Gestión Documental",
    descripcion:
      "Repositorio centralizado de contratos, anexos y documentos del personal con firma electrónica.",
    tiers: [{ minUsuarios: 1, maxUsuarios: 50, modalidad: "por_usuario", precioUF: 0.012 }],
    disponibleParaVicky: true,
  },

  // ─── DESHABILITADOS PERO DECLARADOS ─────────────────────────────────────
  // Con el nuevo scope 1-50, estos módulos son técnicamente aplicables.
  // Eduardo puede habilitarlos cambiando disponibleParaVicky a true.

  {
    id: "reporte",
    nombre: "Reporte",
    descripcion:
      "Reportería avanzada y exportación de datos. Requiere mínimo 5 trabajadores.",
    minUsuariosTotal: 5,
    tiers: [
      { minUsuarios: 5, maxUsuarios: 10, modalidad: "por_usuario", precioUF: 0.015 },
      { minUsuarios: 11, maxUsuarios: 20, modalidad: "por_usuario", precioUF: 0.013 },
      { minUsuarios: 21, maxUsuarios: 50, modalidad: "por_usuario", precioUF: 0.012 },
    ],
    disponibleParaVicky: false,
  },
  {
    id: "victoria",
    nombre: "VictorIA",
    descripcion:
      "Asistente con inteligencia artificial para análisis y consultas en lenguaje natural sobre la operación.",
    minUsuariosTotal: 5,
    tiers: [
      { minUsuarios: 5, maxUsuarios: 10, modalidad: "por_usuario", precioUF: 0.017 },
      { minUsuarios: 11, maxUsuarios: 20, modalidad: "por_usuario", precioUF: 0.015 },
      { minUsuarios: 21, maxUsuarios: 50, modalidad: "por_usuario", precioUF: 0.012 },
    ],
    disponibleParaVicky: false,
  },
  {
    id: "casino",
    nombre: "Comedor / Casino",
    descripcion:
      "Control de raciones y consumo en casinos corporativos. Precio fijo según rango de usuarios.",
    tiers: [
      { minUsuarios: 1, maxUsuarios: 20, modalidad: "fijo", precioUF: 1.261 },
      { minUsuarios: 21, maxUsuarios: 50, modalidad: "fijo", precioUF: 2.101 },
    ],
    disponibleParaVicky: false,
  },
  {
    id: "dashboard",
    nombre: "Dashboard",
    descripcion:
      "Visualización ejecutiva consolidada de la operación. Precio fijo hasta 50 usuarios.",
    tiers: [{ minUsuarios: 1, maxUsuarios: 50, modalidad: "fijo", precioUF: 1.25 }],
    disponibleParaVicky: false,
  },
]
