# Monitoreo mensual de MRR

Herramientas para el análisis recurrente del MRR consolidado por conglomerado.

## Contenido

| Archivo | Qué es |
|---|---|
| `monitoreo_mrr.py` | Script que procesa el export mensual y genera el Excel de monitoreo |
| `fusiones_conglomerados.csv` | Fusiones de conglomerados validadas (confianza alta): etiqueta original → grupo corregido |
| `radar/build_radar.py` | Genera el dashboard Radar MRR (HTML cifrado con clave) desde el export mensual |
| `radar/template.html` + `radar/assets/` | Template del dashboard y assets de marca (fuentes, logo) |

## Uso mensual

1. Exportar el archivo `MRR_consolidado_YYYYMM.xlsx` con las dos pestañas
   (`Facturación x Producto USD` y `Facturación x Producto MonLocal`).
2. Correr:

   ```bash
   pip install pandas numpy openpyxl   # una vez
   python analysis/mrr/monitoreo_mrr.py MRR_consolidado_202608.xlsx Monitoreo_202608.xlsx
   ```

3. El Excel de salida trae: **Resumen** (KPIs), **En riesgo** (cuentas grandes con
   contracción sostenida en moneda local — el patrón que precede a la fuga),
   **Fugas 12m** y **NRR país**.

También se puede subir el xlsx mensual a una conversación de Claude y pedir
"corre el monitoreo de MRR": este script y sus convenciones son la referencia.

## Radar MRR (dashboard mensual)

El dashboard por país (pestañas Global + Chile/Colombia/México/Perú/Argentina/Otros,
con KPIs, NRR local, puente del crecimiento, riesgo, alertas y asistente de datos)
se regenera cada mes desde el mismo export:

```bash
pip install cryptography   # una vez (además de pandas/numpy/openpyxl)
python analysis/mrr/radar/build_radar.py MRR_consolidado_202608.xlsx \
    -o radar_mrr.html --clave 'LaClaveDelMes'   # o export RADAR_CLAVE=...
```

El HTML resultante es autocontenido y lleva los datos cifrados (AES-256-GCM):
sin la clave no se puede leer nada, ni mirando el código fuente.

**URL oficial del panel**: https://radar-mrr-git-master-geo-victoria.vercel.app
(proyecto Vercel `radar-mrr`, sirve `analysis/mrr/radar/dist/` de la rama
`master`). Para actualizarla: copiar la salida a `analysis/mrr/radar/dist/index.html`,
commitear y pushear a `master` — Vercel redeploya solo. La clave puede cambiarse
en cada corrida (los que tengan la anterior deberán pedir la nueva).

Nota: el dominio corto `radar-mrr.vercel.app` quedó apuntando a una rama de
producción `main` que no existe en este repo; si algún día se cambia la
"Production Branch" del proyecto a `master` en la configuración de Vercel,
ese dominio corto también quedará al día.

Notas:
- Las fusiones se toman de `fusiones_conglomerados.csv` (compartidas con el monitoreo).
- Las "señales estructurales" (estacionalidad, partners, ticket de entrada) son
  hallazgos del análisis ago-2026 y no se recalculan; el resto sí, mes a mes.
- `--json datos.json` vuelca los datos sin cifrar para revisarlos (no compartir).

## Convenciones (acordadas ago-2026)

- **NRR siempre en moneda local** (tipo de cambio constante); USD como referencia.
- **Conglomerados corregidos**: se aplican las fusiones del CSV (Visma, Falabella,
  CMPC, Randstad, etc.) y se desarma el placeholder `55555555`.
- **Nombres**: si la etiqueta del conglomerado es un código (RUT/RUC/RFC), se
  muestra la razón social del cliente principal del grupo.
- **Fuga** = sin facturación en los últimos 3 meses del archivo.
- **Riesgo** = cuenta ≥ US$500/mes con caída ≥22% en moneda local entre el
  promedio de los meses −8..−6 y el promedio de los últimos 3.
- Si un país llega sin carga en el último mes (caso España jul-2026), se usa el
  mes anterior para ese país.

Cuando Finanzas valide nuevas fusiones (p. ej. las de confianza media), agregarlas
a `fusiones_conglomerados.csv`.
