/**
 * Catálogo de módulos de software de GeoVictoria.
 *
 * Scope actual de Vicky: 1-50 trabajadores. Los tiers cubren todo ese rango.
 * Los precios están alineados con el `index.html` de la cotizadora oficial.
 *
 * Política comercial actual:
 *   - Asistencia: habilitado (base obligatoria que Vicky ofrece proactivamente)
 *   - Resto de add-ons: declarados pero NO disponibles para Vicky.
 *     Solo se mencionan si el prospecto pregunta explícitamente por ellos,
 *     y en ese caso Vicky deriva con motivo "fuera_de_scope".
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
      { minUsuarios: 1, maxUsuarios: 10, modalidad: "fijo", precioUF: 0.75 },
      { minUsuarios: 11, maxUsuarios: 20, modalidad: "por_usuario", precioUF: 0.09 },
      { minUsuarios: 21, maxUsuarios: 30, modalidad: "por_usuario", precioUF: 0.08 },
      { minUsuarios: 31, maxUsuarios: 50, modalidad: "por_usuario", precioUF: 0.07 },
    ],
    disponibleParaVicky: true,
  },

  // ─── ADD-ONS DESHABILITADOS PARA VICKY ──────────────────────────────────
  // Declarados para mantener paridad con la cotizadora oficial,
  // pero no se ofrecen proactivamente en la conversación.

  {
    id: "vacaciones",
    nombre: "Vacaciones y Permisos",
    descripcion:
      "Gestión de solicitudes y aprobaciones de vacaciones y permisos sin planillas Excel.",
    tiers: [{ minUsuarios: 1, maxUsuarios: 50, modalidad: "por_usuario", precioUF: 0.022 }],
    disponibleParaVicky: false,
  },
  {
    id: "banco",
    nombre: "Banco de Horas",
    descripcion:
      "Gestión de horas extras, compensaciones y saldos por trabajador. Útil para empresas con jornadas variables.",
    tiers: [{ minUsuarios: 1, maxUsuarios: 50, modalidad: "por_usuario", precioUF: 0.05 }],
    disponibleParaVicky: false,
  },
  {
    id: "alertas",
    nombre: "Alertas",
    descripcion:
      "Notificaciones automáticas a supervisores ante atrasos, ausencias o anomalías de marcaje.",
    tiers: [{ minUsuarios: 1, maxUsuarios: 50, modalidad: "por_usuario", precioUF: 0.019 }],
    disponibleParaVicky: false,
  },
  {
    id: "calendario",
    nombre: "Planificador Inteligente",
    descripcion:
      "Planificación de turnos y horarios variables. Útil para empresas con personal rotativo.",
    tiers: [{ minUsuarios: 1, maxUsuarios: 50, modalidad: "por_usuario", precioUF: 0.014 }],
    disponibleParaVicky: false,
  },
  {
    id: "documental",
    nombre: "Gestión Documental",
    descripcion:
      "Repositorio centralizado de contratos, anexos y documentos del personal con firma electrónica.",
    tiers: [{ minUsuarios: 1, maxUsuarios: 50, modalidad: "por_usuario", precioUF: 0.012 }],
    disponibleParaVicky: false,
  },
]
