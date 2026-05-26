/**
 * Catálogo de servicios de GeoVictoria.
 *
 * Por ahora solo modela Instalación de reloj. Envío y otros servicios se
 * agregarán cuando Vicky los necesite.
 *
 * IMPORTANTE: los precios son placeholders hasta que el líder de telemarketing
 * confirme los valores oficiales por región. Editar las dos constantes y
 * commit & push para actualizar Vicky.
 */

import type { Servicio } from "./tipos"

export const CATALOGO_SERVICIOS: Servicio[] = [
  {
    id: "instalacion_reloj",
    nombre: "Instalación de reloj",
    descripcion:
      "Visita técnica para instalación on-site del reloj de control en el punto del cliente. Cobro único por punto.",

    // TODO(eduardo): confirmar valores reales con telemarketing.
    precioUFRM: 2.0,
    precioUFRegion: 3.5,

    obligatoriedad: "recomendada",
    permiteAutoInstalacion: true,

    advertenciasAutoInstalacion: [
      "La instalación auto-gestionada por el cliente no incluye garantía de funcionamiento del equipo en sitio.",
      "Si el reloj presenta fallas por instalación incorrecta, la visita técnica de soporte se cobra aparte.",
      // TODO(eduardo): confirmar redacción con telemarketing y agregar/quitar advertencias.
    ],

    aplicaConHardware: true,
    disponibleParaVicky: true,
  },
]
