/**
 * Catálogo de servicios de GeoVictoria.
 *
 * Sigue el mismo patrón que `modulos.ts` y `hardware.ts`: una familia
 * conceptual del catálogo en su propio archivo, con flag `disponibleParaVicky`
 * que controla qué se ofrece efectivamente en la conversación.
 *
 * Hoy solo modela la instalación del reloj de control. Cuando se agreguen
 * otros servicios (envío, capacitación, etc.) van como entradas adicionales
 * en este mismo array.
 *
 * IMPORTANTE — valores que requieren confirmación:
 *   - precioUFRM, precioUFRegion: placeholders. Confirmar con telemarketing.
 *   - advertenciasAutoInstalacion: borrador. Confirmar redacción y completitud.
 */

import type { Servicio } from "./tipos"

export const CATALOGO_SERVICIOS: Servicio[] = [
  {
    id: "instalacion_reloj",
    nombre: "Instalación de reloj",
    descripcion:
      "Visita técnica para instalación on-site del reloj de control en el punto del cliente. Cobro único por punto de instalación.",

    // TODO(eduardo): confirmar valores oficiales con líder de telemarketing.
    precioUFRM: 2.0,
    precioUFRegion: 3.5,

    obligatoriedad: "recomendada",
    permiteAutoInstalacion: true,

    // TODO(eduardo): confirmar redacción y completitud con telemarketing.
    advertenciasAutoInstalacion: [
      "La instalación auto-gestionada por el cliente no incluye garantía de funcionamiento del equipo en sitio.",
      "Si el reloj presenta fallas atribuibles a instalación incorrecta, la visita técnica de soporte se cobra aparte.",
    ],

    aplicaConHardware: true,
    disponibleParaVicky: true,
  },
]
