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

---

## UX: muletilla "déjame revisar en el sistema" ANTES de dar el siguiente descuento

**Estado:** detectado en producción; la regla del prompt NO basta (el modelo la
incumple igual).

**Síntoma:** cuando el cliente pide avanzar al siguiente escalón de descuento,
Vicky a veces manda un mensaje de relleno/anuncio ANTES de entregarlo, del estilo:
*"Permíteme procesar el descuento en el sistema para confirmarte el porcentaje
exacto que puedo aplicarte. ¿Te parece?"* — y recién en el turno siguiente da el
número. Suena a robot atascado y, peor, el "¿Te parece?" obliga al cliente a
confirmar dos veces, agregando una vuelta extra justo en el momento más sensible
de la negociación (donde más se fuga).

**Por qué importa:** la negociación de precio es el punto de conversión más
delicado. Un anuncio de proceso + pregunta de confirmación rompe el ritmo, da
sensación de demora y resta credibilidad ("¿por qué tiene que ir a revisar algo
que debería saber al toque?").

**Evidencia de que el prompt no alcanza:** ya existe una regla anti-muletilla en
el prompt (`app/api/vic-sales-agent-v3/prompt.ts` ~línea 531, agregada el 17-jun
en `9dbf84c`): *"PROHIBIDO decir cosas como 'permíteme procesar el descuento en
el sistema'..."*. Pese a eso, el modelo emitió la frase **textual** varias veces
DESPUÉS de esa fecha (18-jun ×4 y 25-jun en `vic_v3_messages`). La instrucción
sola no lo frena.

**Solución propuesta (guardrail determinista, no solo prompt):**
- Post-procesar el `reply` en `vic-botmaker-v3/route.ts` (mismo patrón que los
  guards de opt-out y de alucinación de callback): si el turno detecta un
  **anuncio de proceso de descuento** (regex sobre frases tipo "permíteme
  procesar el descuento", "déjame confirmarte el porcentaje", "voy a revisar en
  el sistema", "¿te parece?") **sin** un `mensajeParaProspecto` real (la respuesta
  no trae % ni montos de una tool llamada este turno), entonces **reintentar el
  loop forzando** la tool de descuento que corresponda
  (`consultar_descuento_referencial` / `consultar_siguiente_descuento`) y
  responder DIRECTO con su `mensajeParaProspecto`, sin el preámbulo.
- Alternativa más liviana: si la respuesta es solo el preámbulo (sin número),
  **suprimirlo** y no enviar nada hasta tener el `mensajeParaProspecto` del mismo
  turno.

**Nota:** distinguir del "Déjame confirmar los datos antes de generar la
cotización" (confirmación de datos del cliente), que es legítimo y NO debe
gatillar el guard. El guard apunta solo al anuncio de *procesar/revisar el
descuento*.

---

## Estilo / humanización: mensajes más cortos, sin negritas, sin "¡!" y con cadencia humana

**Estado:** propuesto (feedback sobre el tono de Vicky).

**Síntoma (caso real):** ante un simple *"Hola, quisiera un reloj control"*, Vicky
responde con un párrafo explicativo + la **lista completa** de métodos de marcaje
(clave, facial, huella, tarjeta, QR, cédula) + **dos preguntas a la vez**
(cuántas personas y en cuántos puntos). Se siente largo, "educador" y es
demasiada info para esa pregunta. Parece capacitación, no conversación.

**Cambios pedidos:**

1. **Respuestas más cortas, no "educadoras".** Responder a lo que se preguntó, sin
   volcar todo lo que se sabe. Para "quiero un reloj", basta una frase + la
   pregunta clave; NO listar los 6 métodos de marcaje salvo que lo pregunten.
   - Tocar la regla del prompt que obliga a enumerar métodos
     (`prompt.ts` ~línea 560, "REGLA DURA métodos del reloj"): hoy fuerza a NO
     decir "solo facial", pero se interpreta como listar TODOS. Ajustar para que
     los métodos se mencionen **solo si el cliente pregunta por el método**, no de
     entrada.
   - Evitar 2 preguntas en el mismo mensaje cuando una basta para avanzar.

2. **Quitar negritas.** Nada de `*texto*`/markdown bold en los mensajes. Que el
   énfasis sea por redacción, no por formato.

3. **Quitar signos de exclamación al inicio de frase.** Nada de "¡Hola!",
   "¡Perfecto!", "¡Genial!" como apertura. Tono más sobrio y natural (chileno
   neutro). Saneador determinista posible: strip de `¡` inicial + del `!` de
   cierre en aperturas tipo saludo/afirmación.

4. **Cadencia humana (latencia).** Introducir una demora antes de responder (y/o
   simular "escribiendo…") proporcional al largo del mensaje, para que no llegue
   instantáneo. Hoy la respuesta sale en el mismo timestamp que el mensaje del
   usuario (se ve robótico). Implementación: delay en el envío por Botmaker
   (cuidando el lock/inbox y la ventana de 24h).

5. **Faltas de ortografía aleatorias (humanización).** Introducir errores menores
   ocasionales para que se vea humano.
   - ⚠️ **Decisión de producto pendiente:** en venta B2B una marca con typos puede
     leerse como poco profesional o descuidada. Si se hace, debe ser **muy
     esporádico y leve** (nunca en cifras, %, links, RUT, email ni datos que se
     persisten), nunca en el primer saludo, y jamás dentro de un bloque
     `mensajeParaProspecto` de una tool. Evaluar A/B antes de dejarlo fijo.

**Dónde:** estilo general en `app/api/vic-sales-agent-v3/prompt.ts`; saneadores
deterministas (negritas, "¡!") y latencia/typos en `vic-botmaker-v3/route.ts`
(donde ya viven `sanitizarVoseo` y `normalizarFormatoWhatsApp`).

**Quick wins (prompt, bajo riesgo):** 1 (acortar), 2 (sin negritas) y 3 (sin "¡!")
son ajustes de prompt + saneador y se pueden hacer ya. 4 (latencia) y 5 (typos)
requieren código y, el 5, una decisión de producto.

---

## Conocimiento incorrecto: validaciones de marcaje de la APP MÓVIL

**Estado:** detectado en producción (Vicky dio info errónea/incompleta).

**Síntoma (caso real):** ante *"¿qué otras validaciones tiene la App?"*, Vicky
respondió: georeferenciación, biometría facial y **"usuario y contraseña"**.

**Errores:**
1. **"Usuario y contraseña" NO es una validación de marcaje** — eso es solo para
   **loguearse** a la app, no para validar la marcación. No corresponde listarlo
   como capa de seguridad del marcaje.
2. **Faltan métodos de validación de marcaje:** **patrón**, **firma** y la opción
   **sin validación**.

**Lista correcta (validación de identidad al marcar en la app):**
- **Biometría facial** (reconocimiento facial)
- **Patrón**
- **Firma**
- **Sin validación** (marca directa, sin verificación de identidad)
- (aparte) **Georeferenciación** = valida la **ubicación** (GPS) desde donde se
  marca — es validación de *dónde*, complementaria a las de *quién*.

> Usuario y contraseña = acceso/login a la app, NO validación de marcaje.

**Causa:** el prompt no enumera las validaciones de la app; solo dice "app móvil
con biometría facial y georeferenciación" (`prompt.ts` ~líneas 554 y 566), así que
ante la pregunta el modelo improvisa y mete "usuario y contraseña".

**Fix:** agregar al prompt el listado correcto de validaciones de marcaje de la
app (facial, patrón, firma, sin validación + georeferenciación como capa de
ubicación), y dejar claro que usuario/contraseña es solo login. Validar la lista
final con el equipo de producto por si hay más métodos o matices por plan.
