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

## Humanización: cadencia humana (latencia) y typos ocasionales

**Estado:** pendiente lo de abajo. Los otros cambios de estilo del feedback
original YA están en producción: respuestas cortas sin enumerar métodos de
entrada (regla en el prompt), sin negritas (`normalizarFormatoWhatsApp`) y sin
`¡`/`¿` de apertura (`quitarSignosApertura`).

1. **Cadencia humana (latencia).** Introducir una demora antes de responder (y/o
   simular "escribiendo…") proporcional al largo del mensaje, para que no llegue
   instantáneo. Hoy la respuesta sale en el mismo timestamp que el mensaje del
   usuario (se ve robótico). Implementación: delay en el envío por Botmaker
   (cuidando el lock/inbox y la ventana de 24h).

2. **Faltas de ortografía aleatorias (humanización).** Introducir errores menores
   ocasionales para que se vea humano.
   - ⚠️ **Decisión de producto pendiente:** en venta B2B una marca con typos puede
     leerse como poco profesional o descuidada. Si se hace, debe ser **muy
     esporádico y leve** (nunca en cifras, %, links, RUT, email ni datos que se
     persisten), nunca en el primer saludo, y jamás dentro de un bloque
     `mensajeParaProspecto` de una tool. Evaluar A/B antes de dejarlo fijo.

---

## Operativo: cambiar la foto de perfil de WhatsApp de Vicky

**Estado:** pendiente (tarea de configuración, NO de código).

**Qué:** actualizar la **foto de perfil** del número de WhatsApp de Vicky. El
usuario (Lalo) ya tiene la imagen que se debe usar.

**Replanteo de la imagen (jul-2026):** revisar el CONCEPTO de la foto actual —
¿por qué Vicky aparece con chaleco altiplánico? Evaluar si esa estética
representa la marca y al personaje (ejecutiva comercial chilena, cercana y
profesional) o si conviene generar/elegir una imagen nueva alineada al branding
de GeoVictoria antes de subirla. Definirlo con Marketing.

**Dónde se hace (no es el repo):** la foto de perfil de un número WhatsApp
Business API se cambia en **Botmaker** (configuración del canal) o vía la
**WhatsApp Business API / Meta Business Manager** (endpoint de business profile).
No vive en este código.

**Acción:** quien tenga acceso admin a Botmaker/Meta sube la imagen. Requisitos
típicos: imagen cuadrada (mín. ~640×640), formato JPG/PNG, peso moderado.

---

## Dashboard: tasa de cierre Vicky vs ejecutivos (por tramo + revenue)

**Estado:** propuesto (para backlog).

**Qué se quiere:** un panel que compare el desempeño de cierre de **Vicky** contra
los **ejecutivos humanos**, para medir el aporte real de Vicky y dónde gana/pierde:
- **Tasa de cierre** (cotizaciones aceptadas / enviadas) de Vicky vs ejecutivos.
- **Separado por tramo** de tamaño: 1-20, 21-50, y los tramos mayores que manejan
  los ejecutivos (51-100, 100+).
- **Revenue:** no solo conteo — también el monto cerrado (UF/CLP), recurrente y/o
  total, por cada lado y tramo.

**Fuentes de datos (Zoho, módulo `Cotizaciones_GeoVictoria`):**
- **Quién creó la cotización:** `Created_By` = "Vicky GeoVictoria"
  (id `3525045000484500876`) → Vicky; cualquier otro usuario → ejecutivo.
- **Cierre:** `Estado_Cotizacion` = "Aceptada" (numerador) sobre el total enviado
  (denominador a definir: Enviada+Aceptada, o incluir Rechazada/Expirada).
- **Tramo (cantidad de usuarios):** vive en el Deal asociado
  (`N_Empleados_que_marcan`), NO en la cabecera de la cotización → hay que cruzar
  cada cotización con su Deal.
- **Revenue:** `Total_Recurrente_UF` (mensual), `Total_No_Recurrente_UF` / 
  `Total_Con_IVA_UF` (pago único / total). Definir qué reportar (ej. recurrente
  anualizado vs total del primer pago).

**Consideraciones:**
- **Excluir pruebas/internas** (mismo criterio ya usado: emails `@geovictoria`,
  números de prueba, "PRUEBA"/"Prueba" en el nombre). Idealmente apoyado en el tag
  "Prueba/Interno" que también está en backlog.
- **Atribución:** una cotización puede pasar de Vicky a un ejecutivo (derivación) —
  definir a quién se adjudica el cierre (quién creó vs quién cerró).
- **Período configurable** (semana/mes) y tendencia en el tiempo.
- Puede vivir como página nueva del dashboard de Vicky (junto a `/dashboard`,
  `/meetings`, `/support`) y/o alimentarse del endpoint de funnel ya existente
  (`/api/vic-funnel`).

**Por qué importa:** pone número al ROI de Vicky (¿cierra mejor o peor que un
humano? ¿en qué tramos? ¿cuánto revenue mueve?) y ayuda a decidir dónde conviene
que Vicky cotice sola vs derivar a un ejecutivo.

---

## Automatizar el post-venta completo (hoy manual de Anderson) en Zoho

**Estado:** propuesto (para backlog)
**Aplica a:** toda cotización que se paga (tarjeta o transferencia).

**Qué hace hoy Anderson a mano** (al confirmarse un pago):
1. **Revisar el pago** — verificar que la plata efectivamente entró (tarjeta vía
   MercadoPago, o transferencia con comprobante enviado al ejecutivo).
2. **Crear la Nota de Venta** en Zoho.
3. **Crear la Solicitud de Administración y Finanzas** en Zoho.
4. **Crear el Ticket de Servicio Técnico** (para la instalación/implementación) en
   Zoho.

El objetivo es **eliminar todas esas manualidades**: que al confirmarse el pago se
disparen los 4 pasos solos.

**Punto de enganche (ya existe):**
- El pago con **tarjeta** ya es automático: webhook MercadoPago → `post-payment-finalize`.
  Ese mismo punto es donde hay que colgar la creación automática de los registros
  de Zoho (idempotente, una sola vez por cotización pagada).
- El pago por **transferencia** hoy NO se confirma solo (MercadoPago Chile no tiene
  transferencia confirmada — ver ítem aparte). Para cubrir el 100% hace falta
  primero resolver la **verificación automática de la transferencia**
  (Fintoc/Khipu, o conciliación bancaria), de modo que también caiga en
  `post-payment-finalize` y dispare el mismo post-venta.

**Alcance técnico a definir (Zoho):**
- **Nota de Venta:** ¿módulo nativo (Sales Orders / `Notas_de_Venta` custom?),
  qué campos se copian desde la cotización (cliente, ítems, montos, IVA), y la
  relación con el Deal/Cotización de origen.
- **Solicitud de Administración y Finanzas:** identificar el módulo/proceso exacto
  (¿Blueprint? ¿módulo custom? ¿asignación a un usuario/cola de Finanzas?) y qué
  gatilla la facturación.
- **Ticket de Servicio Técnico:** módulo de tickets (¿Zoho Desk o un custom en
  CRM?), datos de la instalación (dirección, zona RM/regiones, N° de relojes,
  tipo de validación), y a qué cola/técnico se asigna.
- **Idempotencia:** clave por cotización pagada para no duplicar los 3 registros si
  el webhook reintenta.
- **Orquestación:** definir si se hace desde el backend del cotizador
  (`post-payment-finalize` extendido) o con un **Workflow/Function de Zoho** que
  escuche el cambio de la cotización a "Pagada"/"Aceptada+pagada". Probablemente
  conviene un solo orquestador para no partir la lógica.

**Bloqueantes / dependencias:**
- Requiere mapear bien cada módulo de Zoho y sus campos obligatorios (relevamiento
  con Anderson: qué llena hoy a mano en cada uno).
- Depende de tener un **estado "Pagada" confiable** en la cotización — hoy el
  picklist `Estado_Cotizacion` no tiene "Pagada" (Borrador/Enviada/Aceptada/
  Rechazada/Expirada); hay que definir cómo se marca el pago confirmado (campo
  nuevo, o un estado/tag adicional) para que sea el trigger.
- Para transferencias, depende del ítem de **verificación automática de pago**.

**Por qué importa:** elimina trabajo manual repetitivo y propenso a error en cada
venta, acelera el inicio de la implementación (el ticket técnico nace solo) y deja
trazabilidad completa pago → nota de venta → finanzas → servicio técnico sin pasos
humanos intermedios.

---

## Re-engagement por CORREO (canal complementario al WhatsApp)

**Estado:** propuesto (para backlog)
**Aplica a:** leads tibios fuera de la ventana de 24h de WhatsApp —
  1. **Preform mostrado** (vio precio, no dejó datos / no avanzó).
  2. **Cotización enviada** (recibió link + PDF, no aceptó/pagó).

**Qué se quiere:**
- Sumar el **correo** como canal de reactivación, en paralelo (o como respaldo)
  al toque por WhatsApp. Ventaja clave: el correo **NO depende de plantilla HSM
  ni de la ventana de 24h** — se puede enviar en cualquier momento, con el
  **último precio** cotizado y un CTA para retomar/aceptar.
- Idealmente encadenado a la misma cadencia de reactivación (47h / 7d / 15d) por
  segmento, decidiendo por lead si va WhatsApp, correo, o ambos.

**Infra que YA existe (aprovechar):**
- Endpoint en el cotizador `api/quote-acceptance/send-reactivation-email` (arma
  el correo con CTA de aceptación online + PDF adjunto; se auto-gatea y filtra
  internos/prueba).
- Flag `REACTIVATION_EMAIL_ENABLED` + `dispararCorreo()` en `vic-reactivation-cron`
  (hoy solo se llama en el segmento "cotización"). Falta: extenderlo al segmento
  "preform", y/o correr el correo aunque el WhatsApp HSM esté apagado.

**A definir:**
- Fuente del "último precio" para el preform (el estimado vive en la conversación,
  no siempre en Zoho) vs. cotización formal (sí está en Zoho/cotizador).
- Plantilla/copy del correo por segmento, y el CTA (link de aceptación con token,
  ligado al ítem de "auto-descuento por clic" ya en backlog).
- Frecuencia y tope para no spamear; opt-out.
- Decisión de canal por lead (solo correo / solo WhatsApp / ambos).

**Por qué importa:** el correo destraba el reenganche multi-día SIN depender de
plantillas HSM aprobadas (el bloqueante actual del WhatsApp fuera de 24h). Es el
camino más rápido para reactivar los ~63% de preforms que hoy se fugan.

---

## Reactivación por LLAMADA (voz) — evaluar Dapta o Botmaker

**Estado:** exploración temprana (para backlog)
**Aplica a:** leads de mayor valor o que no responden por texto (WhatsApp/correo):
preforms tibios, cotizaciones enviadas sin avanzar, no-shows de reunión.

**Qué se quiere:** sumar un **canal de voz** (agente IA) para reenganchar cuando el
texto no funciona. Dos variantes, no excluyentes:
- **(A) Callback consentido:** Vicky ofrece en el chat "¿te llamo para verlo por
  teléfono?"; el cliente dice que sí y ESO gatilla la llamada (cero fricción, con
  consentimiento; sin problemas de horario/no-molestar). La más humana.
- **(B) Llamada de reactivación proactiva:** toque de voz saliente a un lead que se
  enfrió (ej. hora 48 del preform, cotización sin avanzar, no-show).

**Guion / propósito de la llamada (consultivo, NO cobrador):**
- Abrir destrabando: "¿hay algo que te falte para avanzar? ¿alguna duda por
  resolver?".
- Recordar que la cotización ya está lista: "tienes la cotización en tu WhatsApp y
  la puedes aceptar cuando quieras".
- Si aparece una objeción → resolverla, o derivar/agendar con un humano.
- Es el MISMO enfoque consultivo que ya aplicamos al nudge de WhatsApp: la voz es
  el mismo mensaje por otro canal.

**Proveedores a evaluar:**
- **Botmaker** — ya es el BSP de WhatsApp de Vicky (línea +56 9 6730 8227). SÍ tiene
  voz: producto **Callbots** (agentes de voz por teléfono y por **WhatsApp Calling**,
  con soporte de llamada saliente / "Llamada saliente desde WhatsApp"). Ventaja:
  reusar plataforma, token y contexto del lead. **BLOQUEANTE A CONFIRMAR:** si
  Callbots expone un **endpoint/API para DISPARAR la llamada saliente** desde el
  flujo de Vicky — no está documentado públicamente (probable que sea vía el
  `intent` de `go.botmaker.com` que ya usamos para plantillas; confirmar con
  soporte de Botmaker).
- **Dapta** — agentes de voz IA; evaluar integración, español chileno, calidad de
  voz y cómo pasar el contexto del lead. Alternativa si Botmaker no expone el disparo.

**A definir:**
- Caso de uso concreto y disparador (¿hora 48 del preform? ¿no-show? ¿lead
  caliente que pidió que lo llamen?).
- Guion/objetivo de la llamada (retomar, agendar, derivar a ejecutivo) y traspaso
  a humano si engancha.
- Cumplimiento (horario hábil por zona, consentimiento, no molestar).
- Costos por minuto/llamada y comparación Dapta vs. Botmaker vs. otros.
- Cómo pasa el contexto del lead (empresa, precio cotizado, etapa) al agente de voz.

**Por qué importa:** la voz tiene tasa de respuesta muy superior al texto para
leads fríos y cierra el ciclo omnicanal (WhatsApp → correo → llamada) sin sumar
carga manual al equipo comercial.

---

## Mejoras del flujo post-venta / onboarding (sugerencias de Anderson, jul-2026)

**1. Automatizar el envío del comprobante de pago al cliente**
Hoy el comprobante de MercadoPago se comparte a mano desde el panel. Al confirmarse
un pago (webhook), enviar automáticamente el comprobante/confirmación al correo del
cliente (y opcionalmente por WhatsApp). Insumos: los datos del pago ya están en el
webhook/finalize; el comprobante oficial vive en MP (evaluar si basta una
confirmación propia con nº de operación o se adjunta el de MP).

**2. Verificar el primer correo de Auto-Onboarding (reportado: "no está llegando")**
Eduardo corrigió el filtro del workflow de Zoho que omitía el envío cuando el
origen era la redirección web post-cotización — verificar end-to-end con el próximo
pago real que el correo llegue (y revisar spam/remitente). Relacionado: buzón
vicky@ en M365 (respuestas rebotan) y reputación del remitente.

**3. Onboarding — turnos: opción de finalizar sin retroceder**
En el paso de turnos del auto-onboarding, el usuario que ya terminó debe poder
finalizar directamente sin tener que volver atrás por el wizard. Cambio de UX en
onboarding-geovictoria.

**4. Onboarding — creación y asignación de turnos con agente LLM**
Reemplazar la configuración manual de turnos por un agente conversacional (LLM)
que entienda "trabajamos L-V 9 a 18 con colación de 45 min" y genere/asigne los
turnos. Feature mayor; definir alcance mínimo (crear turnos desde texto libre)
antes de asignaciones complejas.

---

## Prompt: orden de presentación de los métodos de marcaje (App → Huellero → Reloj)

**Estado:** propuesto (jul-2026, Lalo). Relacionado con el cambio "app-first"
que quedó revertido a la espera del OK de Rodrigo.

**Qué:** definir un ORDEN canónico al presentar las modalidades de marcaje:
1. **App** (gratis, mejor precio)
2. **Huellero**
3. **Reloj control**

Hoy el menú default ofrece "app y reloj" como las dos más usadas (web/call como
nota al pie) sin un orden comercial deliberado. Al retomar el app-first, fijar
esta jerarquía en el bloque de marcaje y en la pregunta de modalidad.

---

## Prompt: en REGIONES recomendar marcajes auto-asistidos (los más baratos)

**Estado:** IMPLEMENTADO PARCIAL (09-jul): regla "doble valor en regiones" en el
prompt — si algún punto del reloj queda fuera de la RM, Vicky muestra ambos
valores (con reloj vs app/cuadrilla gratis, sin envío ni instalación) antes del
preform, a cualquier tamaño; señal (d) de cuadrilla agregada. PENDIENTE solo la
parte USB (abajo).

**Qué:** cuando el prospecto es de REGIÓN (fuera de la RM), Vicky debe
recomendar proactivamente los métodos de marcaje **auto-asistidos y más
baratos**, en vez de anclar con reloj + instalación/envío (que en regiones
encarece fuerte el pago inicial — ver fugas de Pto. Natales y zonas extremas):

1. **App** (gratis, cada uno en su celular)
2. **Cuadrilla** (gratis, todo el equipo marca en una tablet/celular de la empresa)
3. **USB** (método auto-asistido de bajo costo — definir alcance/precio exacto)

**Pendiente de definición antes de implementar:**
- Confirmar qué es exactamente el marcaje **USB** en el catálogo (no está hoy
  en el conocimiento del prompt ni en el catálogo de la tool de precios) y su
  tarifa, para no inventar un producto.
- Decidir si el reloj se sigue OFRECIENDO en regiones cuando el cliente lo pide
  (sí, con transparencia de costos de envío/instalación) o solo bajo fit
  evidente.

**Relación:** complementa la regla "barato-primero ante objeción de precio" ya
desplegada — esto la vuelve PREVENTIVA para regiones (recomendar antes de que
aparezca la objeción), y se apoya en el orden App → Huellero → Reloj del ítem
anterior del backlog.

---

## Monitoreo de calidad del número de WhatsApp (Meta) — alerta y freno automático

**Estado:** pendiente (lo único vivo del ítem de cadencia/anti-spam: la cadencia
nueva 1h/23h + HSM 47h/7d/15d, el horario hábil con feriados y el seguimiento
consensuado YA están implementados y en producción).

**Qué falta:** monitorear el índice de calidad del número en Meta/Botmaker,
alertar si baja, y pausar o reducir la cadencia automáticamente para no
arriesgar el bloqueo de envíos.

---

## ✅ Resuelto (registro compacto — detalle en git)

- **Tarifa instalación 3 zonas** (RM 1 UF / IV-V-VI 3 UF / resto 5 UF, sin
  distinción arriendo/compra, sin descuento; escalera solo plan 10→20%) — 09-jul.
- **Cadencia + horario hábil**: 2 toques 1h/23h texto libre + 47h/7d/15d por HSM,
  gate Lun-Sáb 9-19 zona del contacto + feriados, seguimiento consensuado.
- **Bug create_quote con descuento** (caso Vanessa 25-jun): no reproducido —
  COT199 (02-jul) y COT202 (06-jul) nacieron con descuento OK.
- **Etiqueta "Pago único" dinámica** en PDF (lista solo los conceptos presentes).
- **Guardrail anti-muletilla** "permíteme procesar el descuento" (determinista,
  en vic-botmaker-v3).
- **Voseo chileno -ái/-ís** ("me los pasai?") saneado con lista curada.
- **Validaciones de marcaje de la app** correctas en el prompt (facial, patrón,
  firma, sin validación; usuario/contraseña = solo login).
- **Estilo**: sin negritas (normalizarFormatoWhatsApp), sin ¡/¿ inicial
  (quitarSignosApertura), no enumerar métodos del reloj de entrada.
- **Protección de datos + encriptación**: bloque de conocimiento en el prompt
  (patrón/contraseña sin biometría; datos encriptados; no proactivo) — 09-jul.
- **Advertencia de auto-instalación eliminada** (se acepta la elección y se
  avanza; condiciones quedan en los T&C) — 09-jul.
