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
- **La tómbola de asignación mete a Vicky SOLO con 1-19 empleados** y
  no-cliente (decisión 16-jul, CL y CO por igual; antes era ≤49). El workflow
  dispara el webhook cuando el lead queda con Owner = Vicky.
- 20+ → tómbola humana / ejecutivo enterprise · cliente actual → soporte.

## 1. Cadencia de toques (solo corre si NO responde; CUALQUIER respuesta la corta)

| Toque | Cuándo | Canal | Quién lo dispara | Plantilla | Estado |
|---|---|---|---|---|---|
| **0** | **min 0** (24/7) ⚡ | WhatsApp HSM | Workflow Zoho → `/api/vic-outbound-lead` | P1 apertura | ✅ construido |
| **0.5** | min 10-15 · solo horario hábil · **A/B test** | **Voz IA** | por definir (Dapta/Callbots) | guion voz | ⏳ F3 |
| 1 | +2 h | Email | `vic-outbound-cadence-cron` → Zoho send_mail | Correo 1 | ✅ construido |
| 2 | Día 1 (+24h) | WhatsApp HSM | `vic-outbound-cadence-cron` | P2 nudge | ✅ construido |
| 3 | Día 5 (+120h) | Email | cron → Zoho send_mail | Correo 2 | ✅ construido |
| 4 | Día 7 (+168h) | WhatsApp HSM (cierre) | cron | P3 cierre | ✅ construido |
| 5 | Día 8 (+192h) | Email (breakup) | cron → Zoho send_mail | Correo 3 | ✅ construido |

Offsets en horas desde el toque 0, configurables en `vic_kv`
`outbound_cadence_offsets_h` ("e1,waNudge,e2,waCierre,e3" — default
`2,24,120,168,192`). +4h tras el correo 3 sin respuesta → cadencia **agotada**:
el lead se reasigna round-robin a las SDR Inbound del país. Todos los toques
respetan horario hábil de la zona del lead (`vic_filter_business_now`).

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
  cotización para ${empresa}. Te ayudo a armarla de inmediato por acá — ¿avanzamos?"
- **P2 `vicky_lead_nudge`** (T2 · vars nombre, empresa):
  "Hola ${nombre}, soy Vicky de GeoVictoria 👋 Te escribí ayer por tu solicitud
  para ${empresa}. Armar tu cotización toma 2 minutos por acá. ¿Hay algo que te
  falte para avanzar o alguna duda que te pueda resolver?"
- **P3 `vicky_lead_cierre`** (T4 · vars nombre, empresa):
  "Hola ${nombre}! Soy Vicky de GeoVictoria. No te quiero molestar más: dejo tu
  cotización para ${empresa} lista para retomarla cuando tú quieras — me
  escribes por acá y la armamos de inmediato. ¡Que te vaya súper! 👋"
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

## 4.5 Colombia — paridad de proactividad (línea +57 318 107 0737)

> Código desplegado (17-jul-2026), **seguro por defecto**: sin las envs de
> plantilla CO, el toque 0 CO se salta y la cadencia avanza solo con correos.
> El país se decide por el **prefijo del teléfono** (+56 CL / +57 CO); el
> workflow de Zoho puede mandar `country`/`territorio` explícito ("Colombia")
> para además normalizar teléfonos locales (`3XXXXXXXXX` → `57...`,
> `9XXXXXXXX` → `56...`).

Qué ya corre igual que Chile sin config extra:
- Correos e1/e2/e3 con **copy colombiano** (sin claims DT ni "6.000 empresas",
  botón a `wa.me/573181070737`), vía Zoho send_mail sobre el lead.
- Horario hábil **America/Bogota 9-19** + los 19 feriados CO 2026 cargados en
  `vic_holidays` (incluye lunes 20-jul).
- Fallo de envío del toque 0 o cadencia agotada → reasignación round-robin a
  las **SDR Inbound CO** (Galindo/Guerrero/Quiroga, turno en `vic_kv`).
- Conversación marcada `country=co`: la respuesta del lead corre el agente CO
  (precios COP, agenda CO con Alejandro Gordillo) por la línea +57.

### Checklist de encendido
1. ✅ **Plantillas HSM aprobadas en Botmaker/Meta** (16-jul-2026, línea +57,
   categoría marketing, vars `${nombre}` y `${empresa}`), cableadas como
   default en el código (las envs `OUTBOUND_TEMPLATE_*_CO` quedan de override):
   - **P1 `vicky_co_lead_apertura`** (T0) · **P2 `vicky_co_lead_nudge`**
     (día 1) · **P3 `vicky_co_lead_cierre`** (día 7).
   - El texto de la plantilla debe calzar **1:1** con el contexto que el código
     persiste en la conversación (`saludoApertura` en `vic-outbound-lead`,
     `CONTEXT_NUDGE_CO`/`CONTEXT_CIERRE_CO` en el cron): si se edita una
     plantilla, actualizar esos literales en el mismo cambio.
   - Las de reactivación CO (`vicky_co_react_preform` / `vicky_co_react_cotizacion`,
     12-jul) ya eran default del cron de reactivación.
2. **Verificar `BOTMAKER_CHANNEL_CO` en Vercel** — la usa toda salida por la
   línea +57 (plantillas y push).
3. ✅ **Zoho listo** (17-jul): el workflow "Vicky - Toque 0 WhatsApp lead" es
   genérico (dispara con Owner = Vicky y ya manda `territorio` y
   `paginaConversion`), y la tómbola de asignación incluye a Vicky para leads
   Colombia 1-19 empleados. Mejora sugerida pendiente: la entrada CO de la
   tómbola no filtra por Lead Source (la CL sí) — agregar el mismo filtro
   inbound para que importaciones/partners no gatillen el toque 0.
4. **E2E con número del equipo CO**: primero `"test": true` en el body (envía
   la plantilla real al número indicado, sin dedup ni tocar Zoho); después el
   flujo completo agregando el número a `OUTBOUND_ALLOW_CONTACTS` y acelerando
   los offsets vía `vic_kv outbound_cadence_offsets_h`.

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
- ✅ F2: `vic-outbound-cadence-cron` (cada 15 min): correos e1/e2/e3 vía Zoho
  send_mail + HSM nudge/cierre + agotamiento con reasignación SDR — CL y CO.
- ✅ Multi-país: toque 0 y cadencia CO (línea +57), copy y correos colombianos,
  feriados/zona Bogotá, SDRs CO — ver sección 4.5.
- ⏳ Config CO: workflow de Zoho para leads CO + verificar `BOTMAKER_CHANNEL_CO`
  (plantillas ya aprobadas y cableadas — checklist en 4.5).
- ⏳ F3: voz T0.5 — bloqueante: endpoint de disparo por API (Dapta vs Callbots).
- ⏳ Etapas del lead (Lead_Status) en contactado/respondió/cotizando — definir
  valores del picklist.
