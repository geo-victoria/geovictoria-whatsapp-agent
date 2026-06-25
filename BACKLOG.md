# Backlog — Vicky / Reactivación

Ítems pendientes priorizables. Cada uno indica contexto, alcance y bloqueantes
conocidos.

---

## Reenganche multi-día: toque hora 47 (WhatsApp + correo) + llamada hora 48

**Estado:** propuesto (para backlog)
**Aplica a:** prospectos en dos situaciones —
  1. **Preform abandonado** (dejó la pre-cotización a medias en el cotizador).
  2. **Cotización enviada** (recibió propuesta y no avanzó).

**Qué se quiere:**
- A la **hora 47** desde el último contacto/evento: enviar **WhatsApp + correo**
  con el **último precio** ya cotizado al cliente (el más reciente que se le mostró).
- Si **no engancha** (no responde / no reactiva), **llamarlo a la hora 48**.

**Contexto del sistema actual:**
- La cadencia vigente vive en `vic-followup-cron` + la migración
  `vic_v3_claim_followups`: **3 toques a ~1h, ~6h y ~18h**, todos dentro de la
  ventana de 24h de WhatsApp y como **texto libre** (push Botmaker), sin precios
  ni links por diseño (guardrail del nudge).
- El toque de hora 47/48 es **alcance multi-día (día 2-3)**, ya señalado como
  pendiente en el comentario de cabecera del cron ("haría falta una plantilla HSM
  aprobada").

**Bloqueantes / consideraciones:**
- **Ventana 24h:** a la hora 47 el WhatsApp libre falla (error 131047). Requiere
  **plantilla HSM aprobada** por Meta para el toque con precio.
- **Precio en el mensaje:** rompe el guardrail actual del nudge (prohíbe montos/
  links). Este toque es un canal distinto (HSM con variable de precio), no el
  nudge de re-enganche. Hay que separarlo del flujo `generarNudge`.
- **Correo:** definir proveedor/plantilla de correo y de dónde sale el "último
  precio" (fuente de verdad: ¿cotización en cotizador / Zoho?).
- **Llamada hora 48:** definir si es tarea para un humano (lista de llamados) o
  marcación automática; y el criterio de "no enganchó".
- **Origen del dato cross-repo:** "preform abandonado" nace en `cotizador`,
  "cotización enviada" también; el envío vive en `whatsapp-agent`. Hay que
  acordar el contrato de datos entre ambos.

---

## Auto-descuento por clic en el correo (CTA "Activar mi precio especial")

**Estado:** propuesto (para backlog)
**Aplica a:** segmento **cotización** del reenganche (el preform no tiene
cotización formal que rebajar).

**Qué se quiere:**
- Que el CTA del correo de reactivación (y, opcionalmente, el botón URL de la
  plantilla HSM de cotización) apunte a un **endpoint con token firmado** que, al
  hacer clic:
  1. valide el token (quoteId + intención + expiración),
  2. **aplique el descuento máximo** server-side (regenera el PDF, igual que
     `aplicar_siguiente_descuento` con el tope),
  3. **redirija a la página de aceptación** con el precio ya rebajado.

**Por qué es atractivo:**
- Elimina el problema del "PDF viejo": el descuento se aplica EN el clic, antes de
  que el cliente vea el precio. Hoy el correo solo reenvía la cotización si ya está
  en el máximo (`send-reactivation-email.js` filtra con `hayEscalonDespues`); con
  esto el correo podría ir a TODOS los de cotización sin ese filtro.
- Idempotente: si el cliente ya estaba en el tope, el clic no rompe nada.
- Unifica canales: el mismo link serviría para el botón URL de WhatsApp.

**Decisiones / consideraciones:**
- **Política:** quien haga clic obtiene el tope (20%) al instante, sin pasar por
  Vicky — el descuento deja de estar "gateado" por la conversación para los que
  reciben el toque. Es el espíritu del flash offer, pero hay que aceptarlo
  explícitamente (margen).
- **Seguridad:** token firmado (mismo modelo "bearer link" que la página de
  aceptación actual); aplicar dos veces es inofensivo (idempotente).
- **Implementación:** endpoint nuevo en `cotizador` (GET con token →
  aplica a tope → 302 a `quote-acceptance.html`). El cron debería pasar el link
  firmado por cliente si se usa también en el botón URL de WhatsApp.

**Por ahora (decidido):** NO se construye. El correo mantiene el filtro de "solo
reenvía la cotización si ya está en el máximo"; para el resto, el descuento lo
aplica Vicky en vivo por WhatsApp y recién ahí entrega el PDF nuevo.

---

## BUG (alta prioridad): create_quote falla en Zoho cuando la cotización nace con descuento

**Estado:** detectado en producción (25-jun, caso Vanessa / DGC Maquinarias).
**Síntoma:** al cerrar una venta donde el cliente aceptó un descuento en el
preform, `generar_link_cotizadora` → `create-from-vicky` falla con:
`stage='create_quote'` → `Zoho createRecord failed: invalid data`. Vicky entonces
deriva a un ejecutivo ("un ejecutivo te contactará") en vez de entregar el link.

**Diagnóstico:** las cotizaciones SIN descuento se crean bien; el fallo aparece
solo con `escalonDescuento > 0`, o sea cuando `quoteFields` incluye
`quoteDiscountFields` (create-from-vicky.js ~935): `Escalon_Descuento`,
`Escalon_Negociacion`, `Descuento_Desbloqueado` (bool), `Descuento_Recurrente_Pct`,
`Descuento_Instalacion_RM_Pct`, `Descuento_Instalacion_Region_Pct`. Hipótesis:
uno de esos api_name no existe / tiene tipo distinto en el módulo
`Cotizaciones_GeoVictoria` (ej. campo nuevo no creado en Zoho, o un picklist/
checkbox que rechaza el valor numérico/booleano).

**Próximos pasos para corregir:**
1. Surface el detalle del error de Zoho en `zoho-crm.js` (incluir `details.api_name`
   del INVALID_DATA en vez de solo "invalid data"), para saber el campo exacto.
2. Verificar en Zoho (getFields del módulo) que los 6 campos de descuento existan
   con el tipo correcto; crear/ajustar el que falte.
3. Reintentar la generación con descuento y confirmar.

**Workaround disponible:** endpoint admin `POST /api/vic-admin-genquote`
(auth x-cron-secret) ejecuta `generar_link_cotizadora` con datos arbitrarios y
devuelve pdfUrl+acceptanceUrl o el error real — sirve para rescatar cotizaciones
fallidas a futuro UNA VEZ corregido este bug (hoy choca con el mismo problema).

---

## UX: etiqueta fija "Pago único (equipos, instalación, servicios)" confunde

**Estado:** detectado en producción (cliente confundido, 25-jun).
**Síntoma:** en la página de aceptación y el PDF, la línea del pago único dice
SIEMPRE *"Pago único (equipos, instalación, servicios)"* — texto **fijo**. Un
cliente cuya cotización **no incluía instalación** (solo envío de reloj) creyó que
estaba pagando instalación. La palabra "instalación" aparece aunque no aplique.

**Dónde:** `cotizador/api/_shared/proposal-html-builder.js` línea ~465
(`<span>Pago único (equipos, instalación, servicios)</span>`). Mismo concepto en
las T&C (líneas ~1308 y ~1430: "equipos, instalacion y servicios iniciales").

**Soluciones propuestas:**
- **(A, recomendada) Etiqueta dinámica:** construir el texto a partir de los ítems
  NO recurrentes presentes en el pago único (compra de equipos / instalación /
  envío / servicios iniciales), listando SOLO los que aplican. Así nunca aparece
  "instalación" si la cotización no la tiene. Requiere inspeccionar
  categoría/modalidad de los ítems one-shot al armar la fila.
- **(B, rápida) Texto genérico** que no prometa instalación específica, ej.
  "Pago único (equipos y cargos iniciales)" o "Cargos únicos según tu cotización".
  Menos preciso pero elimina la confusión de inmediato.

**Recomendación:** A (dinámica) para precisión; B como parche inmediato si urge.
Alinear también el texto de las T&C para que no liste instalación cuando no aplica.
