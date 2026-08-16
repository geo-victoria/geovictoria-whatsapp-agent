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

// PRUEBA DE PRECIOS (biblia 12-ago, Rodrigo 11-ago): durante UN MES asistencia
// 3-10 baja de 0,60 a 0,55 fijo y 11-20 de 0,07 a 0,055/usuario, con Vacaciones
// como espejo exacto al 50% (0,275 fijo · 0,0275/u). Hipótesis: menor precio
// sube conversión; al cierre del mes se compara contra el período anterior.
// Rollback sin deploy: env VICKY_PRECIOS_CLASICOS=1 restaura 0,60/0,07.
const PRECIOS_CLASICOS = (process.env.VICKY_PRECIOS_CLASICOS || "").trim() === "1"

export const CATALOGO_MODULOS: ModuloSoftware[] = [
  // ─── BASE OBLIGATORIA ───────────────────────────────────────────────────
  {
    id: "asistencia",
    nombre: "Control de Asistencia",
    descripcion:
      "Marcaje de entrada y salida por varios canales: web (logueado en la plataforma desde el navegador), app móvil (con biometría facial y georeferenciación) y call (llamada telefónica) — los tres GRATIS e incluidos —, además de reloj control físico/terminales biométricos (con costo). La base del producto, incluida en toda cotización.",
    tiers: [
      // Micro-plan: 1-2 trabajadores que marcan → tarifa especial. Desde 3
      // que marcan, tramo fijo normal (ajuste de tramos, Lalo 31-jul-2026).
      { minUsuarios: 1, maxUsuarios: 2, modalidad: "fijo", precioUF: 0.25 },
      { minUsuarios: 3, maxUsuarios: 10, modalidad: "fijo", precioUF: PRECIOS_CLASICOS ? 0.6 : 0.55 },
      { minUsuarios: 11, maxUsuarios: 20, modalidad: "por_usuario", precioUF: PRECIOS_CLASICOS ? 0.07 : 0.055 },
      // 21-30 a 0,055 (Lalo, 16-ago). La prueba de precios bajó el 11-20 de 0,07
      // a 0,055 y dejó este tramo en 0,065: la escalera dejaba de ser
      // descendente y la NOTA DE VENTA —que imprime la tabla completa— mostraba
      // que crecer de 20 a 21 usuarios subía el precio unitario un 18%.
      // Se iguala acá y en PRICING_TIERS del cotizador, en el mismo acto.
      { minUsuarios: 21, maxUsuarios: 30, modalidad: "por_usuario", precioUF: 0.055 },
      { minUsuarios: 31, maxUsuarios: 50, modalidad: "por_usuario", precioUF: 0.055 },
      // ── TRAMOS 51+ = CANAL EJECUTIVO (calculadora de Nacho, 10-ago) ──
      // Vicky WhatsApp NUNCA llega acá: sus guardas (umbral 20/50 y el tope de
      // sus tools) viven aguas arriba. Solo el agente del editor (dash) pasa
      // el cap alto vía _maxUsuariosOverride. Fuente: pricingTiers de
      // gv-cotizador (valores tabla oficiales del canal comercial).
      { minUsuarios: 51, maxUsuarios: 100, modalidad: "por_usuario", precioUF: 0.065 },
      { minUsuarios: 101, maxUsuarios: 200, modalidad: "por_usuario", precioUF: 0.06 },
      { minUsuarios: 201, maxUsuarios: 500, modalidad: "por_usuario", precioUF: 0.055 },
      { minUsuarios: 501, maxUsuarios: 1000, modalidad: "por_usuario", precioUF: 0.05 },
      { minUsuarios: 1001, maxUsuarios: 3000, modalidad: "por_usuario", precioUF: 0.045 },
      { minUsuarios: 3001, maxUsuarios: 5000, modalidad: "por_usuario", precioUF: 0.04 },
      { minUsuarios: 5001, maxUsuarios: 8000, modalidad: "por_usuario", precioUF: 0.035 },
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
    // REGLA DE PRECIO (Lalo, 05-ago; antes 30% desde el 21-jul): vacaciones
    // vale el 50% del precio de asistencia, POR CADA usuario de asistencia —
    // por eso los tiers son el ESPEJO exacto de los de asistencia × 0,50
    // (misma modalidad por tramo, incluidos los tramos de tarifa fija). Si
    // asistencia cambia sus tiers, actualizar estos en el mismo cambio. El
    // descuento recurrente aplica sobre asistencia + módulos (bucket
    // recurrente del cotizador).
    tiers: [
      { minUsuarios: 1, maxUsuarios: 2, modalidad: "fijo", precioUF: 0.125 },
      { minUsuarios: 3, maxUsuarios: 10, modalidad: "fijo", precioUF: PRECIOS_CLASICOS ? 0.3 : 0.275 },
      { minUsuarios: 11, maxUsuarios: 20, modalidad: "por_usuario", precioUF: PRECIOS_CLASICOS ? 0.035 : 0.0275 },
      { minUsuarios: 21, maxUsuarios: 30, modalidad: "por_usuario", precioUF: 0.0325 },
      { minUsuarios: 31, maxUsuarios: 50, modalidad: "por_usuario", precioUF: 0.0275 },
    ],
    disponibleParaVicky: true,
  },
  {
    id: "banco",
    nombre: "Banco de Horas",
    descripcion:
      "Gestión de horas extras, compensaciones y saldos por trabajador. Útil para empresas con jornadas variables.",
    tiers: [{ minUsuarios: 1, maxUsuarios: 8000, modalidad: "por_usuario", precioUF: 0.05 }],
    disponibleParaVicky: false,
  },
  {
    id: "alertas",
    nombre: "Alertas",
    descripcion:
      "Notificaciones automáticas a supervisores ante atrasos, ausencias o anomalías de marcaje.",
    tiers: [{ minUsuarios: 1, maxUsuarios: 8000, modalidad: "por_usuario", precioUF: 0.019 }],
    disponibleParaVicky: false,
  },
  {
    id: "calendario",
    nombre: "Planificador Inteligente",
    descripcion:
      "Planificación de turnos y horarios variables. Útil para empresas con personal rotativo.",
    tiers: [{ minUsuarios: 1, maxUsuarios: 8000, modalidad: "por_usuario", precioUF: 0.014 }],
    disponibleParaVicky: false,
  },
  {
    id: "documental",
    nombre: "Gestión Documental",
    descripcion:
      "Repositorio centralizado de contratos, anexos y documentos del personal con firma electrónica.",
    tiers: [{ minUsuarios: 1, maxUsuarios: 8000, modalidad: "por_usuario", precioUF: 0.012 }],
    disponibleParaVicky: false,
  },
]
