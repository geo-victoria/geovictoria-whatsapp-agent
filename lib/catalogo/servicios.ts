/**
 * Catálogo de servicios asociados de GeoVictoria.
 *
 * Modela DOS grupos de cobro por punto físico, ambos según modalidad del reloj
 * (arriendo/venta) y zona (RM / otras regiones):
 *   - Envío del reloj (precio fijo, sin descuento).
 *   - Instalación on-site (descontable: RM 50% / regiones 25%; se omite si el
 *     cliente auto-instala).
 *
 * Tarifas oficiales (UF por punto):
 *   Envío        — arriendo: RM 0   / región 0,5   · compra: RM 0,5 / región 0,7
 *   Instalación  — arriendo: RM 1   / región 3     · compra: RM 2   / región 5
 *
 * IMPORTANTE: editar las tarifas acá y commit & push para actualizar Vicky.
 */

import type { Servicio } from "./tipos"

export const CATALOGO_SERVICIOS: Servicio[] = [
  {
    id: "envio_reloj",
    nombre: "Envío de reloj",
    descripcion:
      "Despacho del reloj de control al punto del cliente. Cobro único por punto. Precio fijo (no aplica descuento).",
    tarifa: {
      arriendo: { RM: 0.0, region: 0.5 },
      venta: { RM: 0.5, region: 0.7 },
    },
    descontable: false,
    omitirSiAutoInstalada: false,
    obligatoriedad: "obligatoria",
    permiteAutoInstalacion: false,
    advertenciasAutoInstalacion: [],
    aplicaConHardware: true,
    disponibleParaVicky: true,
  },
  {
    id: "instalacion_reloj",
    nombre: "Instalación de reloj",
    descripcion:
      "Visita técnica para instalación on-site del reloj de control en el punto del cliente. Cobro único por punto.",
    tarifa: {
      arriendo: { RM: 1.0, region: 3.0 },
      venta: { RM: 2.0, region: 5.0 },
    },
    descontable: true,
    omitirSiAutoInstalada: true,
    obligatoriedad: "recomendada",
    permiteAutoInstalacion: true,
    advertenciasAutoInstalacion: [
      "La instalación auto-gestionada por el cliente no incluye garantía de funcionamiento del equipo en sitio.",
      "Si el reloj presenta fallas por instalación incorrecta, la visita técnica de soporte se cobra aparte.",
    ],
    aplicaConHardware: true,
    disponibleParaVicky: true,
  },
]
