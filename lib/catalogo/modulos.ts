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
      "Marcaje de entrada y salida por varios canales: web (logueado en la plataforma desde el navegador), app móvil (con biometría facial y georeferenciación) y call (llamada telefónica) — los tres GRATIS e incluidos —, además de reloj control físico/terminales biométricos (con costo). La base del producto, incluida en toda cotización.",
    tiers: [
      // Micro-plan: 1 trabajador que marca → tarifa especial. Cubre 2 usuarios
      // (el que marca + 1 administrador). Desde 2 que marcan, tramo fijo normal.
      { minUsuarios: 1, maxUsuarios: 1, modalidad: "fijo", precioUF: 0.25 },
      { minUsuarios: 2, maxUsuarios: 10, modalidad: "fijo", precioUF: 0.6 },
      { minUsuarios: 11, maxUsuarios: 20, modalidad: "por_usuario", precioUF: 0.07 },
      { minUsuarios: 21, maxUsuarios: 30, modalidad: "por_usuario", precioUF: 0.065 },
      { minUsuarios: 31, maxUsuarios: 50, modalidad: "por_usuario", precioUF: 0.055 },
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
      "Los trabajadores solicitan vacaciones, días administrativos, licencias y permisos desde la app/portal; el supervisor aprueba o rechaza en un clic y los saldos de días (acumulados, tomados, pendientes) se calculan y actualizan SOLOS según la normativa. Todo trazable y sin planillas Excel ni papeles. Se integra con el control de asistencia.",
    // REGLA DE PRECIO (Lalo, 21-jul): vacaciones vale el 30% del precio de
    // asistencia, POR CADA usuario de asistencia — por eso los tiers son el
    // ESPEJO exacto de los de asistencia × 0,30 (misma modalidad por tramo,
    // incluidos los tramos de tarifa fija). Si asistencia cambia sus tiers,
    // actualizar estos en el mismo cambio. El descuento recurrente aplica
    // sobre asistencia + módulos (bucket recurrente del cotizador).
    tiers: [
      { minUsuarios: 1, maxUsuarios: 1, modalidad: "fijo", precioUF: 0.075 },
      { minUsuarios: 2, maxUsuarios: 10, modalidad: "fijo", precioUF: 0.18 },
      { minUsuarios: 11, maxUsuarios: 20, modalidad: "por_usuario", precioUF: 0.021 },
      { minUsuarios: 21, maxUsuarios: 30, modalidad: "por_usuario", precioUF: 0.0195 },
      { minUsuarios: 31, maxUsuarios: 50, modalidad: "por_usuario", precioUF: 0.0165 },
    ],
    disponibleParaVicky: true,
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
