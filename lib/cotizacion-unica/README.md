# Motor único de cotización (el de Chile)

`motor.ts` es la tool chilena `cotizar_referencial` con los datos del país
sacados a `ReglasCotizacion`. La lógica es una sola para todos los países:
qué se cobra (plan por tramos, equipo en arriendo o venta, envío e instalación
por punto, arriendo fuera de la zona base), cuándo va el doble valor
(con equipo → "1 - … + App" / "2.- … solo app" / "Qué opción prefieres?") y
cómo se arma el mensaje.

| Archivo | Qué es |
|---|---|
| `motor.ts` | La lógica (pura, sin red). |
| `reglas-cl.ts` | Datos de Chile, leídos del catálogo (`lib/catalogo`) y de `lib/geografia`. |
| `pais.ts` | Corre el motor para Perú/Colombia/México y arma los ítems de SU formal. |
| `lib/paises/{pe,co,mx}/cotizar.ts` | Datos de cada país + el contrato de sus tools. |

## Agregar un país (solo datos)

1. En `lib/paises/<cc>/cotizar.ts` declara un objeto `ReglasCotizacion`:
   - `modulos`: el plan de asistencia con sus tramos (en la moneda del país).
   - `hardware`: el equipo (`id: ID_EQUIPO`), con `arriendoUF`, `arriendoFueraUF`
     (fuera de la zona base, despacho incluido) y `ventaUF`.
   - `servicios`: `envio_reloj` (por modalidad y zona; 0 = incluido) e
     `instalacion_reloj` (por zona base / intermedia / resto).
   - `instalacionBonificada(modalidad, zona)`: dónde la visita técnica va sin costo.
   - `impuesto`: tasa, si grava solo el equipo, y cómo se agrega.
   - `escalera`: los escalones de descuento del plan y sus meses.
   - `presentacion`: cómo se escriben los montos ("S/100 + IGV", "$315.000"…).
   - `textos`: vocabulario (reloj/equipo, arriendo/alquiler/renta, dónde va
     bonificada, notas finales).
2. Declara los `TextosFormal` (ids y nombres de los ítems que recibe el
   endpoint `create-from-vicky-<cc>` del cotizador).
3. Exporta `cotizar<CC>(input)` llamando a `cotizarPais(reglas, formal, "de <País>", input)`
   y traduciendo los campos a su moneda.

No se escribe lógica en el adaptador: `tests/cotizacion-unica.test.ts` falla si
aparece un `for`, un `reduce` o un `Map` en `lib/paises/<cc>/cotizar.ts`.

## Cómo se probó

- Chile: la tool anterior congelada sobre 20.045 configuraciones (dotación
  0-51, 5 combinaciones de módulos, 17 de equipo, 13 de puntos): 0 diferencias
  (mensaje byte a byte, ítems y totales). Una muestra queda en
  `tests/fixtures/cotizacion-cl-congelada.json`.
- Perú/Colombia/México: el motor anterior congelado (11.424 casos): números e
  ítems de la formal idénticos; el texto cambió donde ahora tiene la forma de
  Chile. Muestra en `tests/fixtures/cotizacion-pais-congelada.json`.
