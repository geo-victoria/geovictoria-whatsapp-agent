# Playbook — Vicky proactiva (leads del formulario web)

> v2 (jul-2026). Réplica de las mejores prácticas de equipos de calificación
> comercial (SDR inbound) en timing, canales y copy, adaptadas a Vicky.
> Evidencia base: contactar en <5 min ≈ 21× más calificación (MIT/InsideSales);
> +391% conversión respondiendo en el primer minuto (Velocify); 78% compra al
> primero que responde; los mejores equipos hacen llamada+email el día 1 y
> cadencias de 6-8 toques front-loaded en 7-14 días.

## Principio rector: VELOCITY FIRST
Cada minuto entre el submit del formulario y el primer contacto es conversión
perdida. Vicky responde en segundos, 24/7 — esa es la ventaja estructural sobre
cualquier competidor humano (promedio industria: 47 horas). El workflow de Zoho
dispara **on-create, sin batch ni delays**.

## 0. Entrada y ruteo (vive en Zoho)
- Fuente: formulario web (nombre, apellido, correo, empresa, teléfono, rango de
  empleados, ¿usa GeoVictoria?).
- **Workflow de Zoho asigna a Vicky SOLO:** ≤49 empleados y no-cliente.
- 50+ → ejecutivo enterprise · cliente actual → soporte.

## 1. Cadencia de toques (solo corre si NO responde; CUALQUIER respuesta la corta)

| Toque | Cuándo | Canal | Quién lo dispara | Plantilla | Estado |
|---|---|---|---|---|---|
| **0** | **min 0** (24/7) ⚡ | WhatsApp HSM | Workflow Zoho → `/api/vic-outbound-lead` | P1 apertura | ✅ construido |
| **0.5** | min 10-15 · solo horario hábil · **A/B test** | **Voz IA** | por definir (Dapta/Callbots) | guion voz | ⏳ F3 |
| 1 | +1-2 h (mismo día) | Email | **Zoho nativo** (Cadencia A) | Correo 1 | ⏳ config |
| 2 | Día 1 | WhatsApp HSM | cron propio | P2 nudge | ⏳ F2 |
| 3 | Día 5 | Email | **Zoho nativo** | Correo 2 | ⏳ config |
| 4 | Día 7-8 | Email + WhatsApp HSM (cierre) | Zoho + cron | Correo 3 + P3 | ⏳ config/F2 |

Tras el toque 4 sin respuesta → lead marcado **no-responde** → nurture largo / humano.

Decisiones de diseño (best practices aplicadas):
- **Doble toque día 1** (WhatsApp + voz + email): el patrón del 80% de las
  cadencias top. La voz al minuto 10 usa su mayor poder (inmediatez) en vez de
  desperdiciarla como rescate tardío.
- **WhatsApp SIEMPRE primero**: en Chile la llamada desconocida se ignora y el
  WhatsApp se lee; además el WhatsApp sale 24/7 (la voz solo en horario hábil) y
  la maquinaria de conversión (preform → descuento → pago) vive ahí.
- **La llamada referencia el WhatsApp** ("te acabo de escribir…"): legitima el
  número y empuja la respuesta escrita. Guion 30-60 seg: confirmar interés →
  "te dejo todo por WhatsApp" → ofrecer agendar. NO vende por teléfono, no deja
  buzón, un solo reintento.
- **Front-loaded**: 4 de los 6 toques en las primeras 24 h; después se espacia.
- **Cada toque tiene SU plantilla** (intención distinta; repetir el mismo HSM
  baja el quality rating de Meta).
- **Restricción HSM**: el lead nunca ha escrito → la ventana de 24h no existe →
  TODO WhatsApp de esta fase es plantilla aprobada. Email y voz no tienen esa
  restricción (por eso van en la mezcla).

## 2. Calificación (BANT-lite conversacional: "calificar cotizando")
El formulario ya hizo el progressive profiling. En cuanto el lead responde:
1. Confirmar **número exacto** de empleados (una sola pregunta; el rango no
   basta para el tramo de precio). >50 real → deriva.
2. Descubrir **modalidad** (app/web/reloj) — una pregunta por turno, nunca
   interrogatorio.
3. **Mostrar precio de inmediato** (preform): en SMB transaccional el
   presupuesto no se pregunta, se revela con el precio.
4. **Micro-cierre** ("¿te hace sentido avanzar?") → destapa la objeción → si
   objeta precio, NEGOCIA (escalera 10→20%); si acepta, pide **solo RUT** (el
   email vino del formulario, se confirma en una línea).
5. Timing/autoridad solo si emerge ("lo veo con mi socio" → `programar_seguimiento`).

Ramas: 🟢 caliente → cotiza · 🟡 tibio → seguimiento consensuado · 🔴 no-fit →
deriva. **Hitos en Zoho (regla dura):** cotización → CONVIERTE el lead en
cuenta+contacto+deal · reunión → reasigna el lead al KAM + evento · callback →
reasigna al ejecutivo. Nunca lead duplicado ni huérfano.

## 3. Copy — principios (aplican a TODO canal)
- **Ningún toque pide datos.** El único trabajo del toque es abrir conversación
  (los datos se piden conversando, de a uno, y el RUT al final). Anti-patrón
  prohibido: "envíanos RUT + cantidad + método" (el error de la Cadencia A vieja).
- Tono Vicky: chileno, tuteo, cercano, corto. Nada de "Quedamos atentos a su
  confirmación".
- **Todo toque termina en pregunta o CTA único** (un botón/acción, no tres).
- Los correos empujan de vuelta al WhatsApp (link wa.me precargado) u ofrecen
  reunión respondiendo el correo. Firma dinámica del Lead Owner (= Vicky).
- El cierre de cadencia es cordial y deja la puerta abierta (breakup email),
  nunca culposo.

## 4. Set de plantillas (una por toque)

### WhatsApp (HSM, aprobar en Botmaker/Meta, utility, sintaxis Botmaker ${variable})
- **P1 `vicky_lead_apertura`** (T0 · vars nombre, empresa):
  "Hola ${nombre} 👋 Soy Vicky de GeoVictoria. Recibimos tu solicitud de
  cotización para ${empresa}. Te ayudo a armarla al tiro por acá — ¿avanzamos?"
- **P2 `vicky_lead_nudge`** (T2 · vars nombre, empresa):
  "Hola ${nombre}, soy Vicky de GeoVictoria 👋 Te escribí ayer por tu solicitud
  para ${empresa}. Armar tu cotización toma 2 minutos por acá. ¿Hay algo que te
  falte para avanzar o alguna duda que te pueda resolver?"
- **P3 `vicky_lead_cierre`** (T4 · vars nombre, empresa):
  "Hola ${nombre}! Soy Vicky de GeoVictoria. No te quiero molestar más: dejo tu
  cotización para ${empresa} lista para retomarla cuando tú quieras — me
  escribes por acá y la armamos al tiro. ¡Que te vaya súper! 👋"
- **R1 `vicky_react_preform` / R2 `vicky_react_cotizacion`** (reactivación
  multi-día 47h/7d/15d, fase aparte — ver cron de reactivación): gancho de
  precio especial por tiempo limitado.

### Email (plantillas de Zoho CRM, Cadencia A renovada; merge fields ${Leads.*} y firma ${Lookup:Lead Owner.*})
- **Correo 1** (T1, mismo día): asunto "Tu cotización GeoVictoria está a un
  mensaje de distancia" — recibimos tu solicitud + te escribí por WhatsApp +
  CTA wa.me + prueba social (DT, 6.000 empresas) + opción reunión.
- **Correo 2** (T3, día 5): asunto "${nombre}, tu cotización sigue lista para
  armar" — beneficios concretos (adiós planillas, reportes solos, normativa DT)
  + CTA wa.me + opción reunión.
- **Correo 3** (T4, día 7-8): asunto "Dejamos tu cotización guardada" — breakup
  cordial + CTA de retorno.
(Textos completos redactados — pegarlos en las plantillas de la Cadencia A.)

### Voz (T0.5, guion — no plantilla)
"Hola ${nombre}, soy Vicky de GeoVictoria — te acabo de escribir por WhatsApp
por tu solicitud de cotización para ${empresa}. ¿Te quedó alguna duda o te
ayudo a armarla ahora? … Te dejo todo listo por WhatsApp / ¿prefieres que
coordinemos una reunión con un ejecutivo?"

## 5. Condiciones transversales
- Cualquier respuesta corta la cadencia de su fase y pasa a conversación.
- Voz/llamadas SOLO horario hábil de la zona del lead (Lun-Sáb 9-19, feriados);
  WhatsApp HSM y email 24/7.
- Opt-out inmediato y definitivo · internos excluidos · tope reactivación 3 ·
  gap mínimo 24h entre HSM.

## 6. Medición (por toque y canal)
Enviados → respondieron → calificados (nº exacto confirmado) → vieron precio →
cotizados → aceptados. El dash Sankey ya cubre desde "vieron precio"; falta
instrumentar tasa de respuesta por toque cuando haya volumen. El A/B de T0.5
(voz sí/no) se decide con esa data.

## Estado y pendientes
- ✅ F1: endpoint toque 0 + modo prospección + hitos en Zoho (convertir/reasignar).
- ⏳ Config: aprobar P1-P3 en Meta · setear `OUTBOUND_TEMPLATE_LEAD` · workflow
  de Zoho (webhook on-create) · renovar los 3 correos de la Cadencia A · workflow
  nativo "al cambiar owner → notificar".
- ⏳ F2: cron del toque 2/4 de WhatsApp (P2/P3) para no-respondedores.
- ⏳ F3: voz T0.5 — bloqueante: endpoint de disparo por API (Dapta vs Callbots).
- ⏳ Etapas del lead (Lead_Status) en contactado/respondió/cotizando — definir
  valores del picklist.
