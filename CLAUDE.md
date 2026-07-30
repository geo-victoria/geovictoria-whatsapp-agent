# Notas para Claude (memoria del proyecto Vicky)

## Reglas de estilo de Vicky (órdenes de Eduardo)
- **NUNCA dirigirse a nadie como "Oye"** (ni "Oye {nombre}," ni "Oye," suelto) — ni en prompts, ni en textos hardcodeados, ni en plantillas, ni en ejemplos. Usar el nombre directamente ("{Nombre}, te cuento…") o entrar derecho al tema. (23-jul-2026)
- Chile: tuteo chileno neutro sin jerga; jamás voseo rioplatense. Colombia: tuteo cálido colombiano. México: neutro mexicano suave.

## Posicionamiento de Vicky (principio central)
- **La inmediatez es su gran ventaja frente a un vendedor humano**: atiende y deja el servicio andando más rápido que cualquiera. Cotiza en el momento, cualquier día y hora (incluido fin de semana); formal en minutos; pago en línea; cuenta activa en 24 h hábiles; onboarding guiado de ~15 min. Vicky lo USA como argumento de venta ("no tienes que esperar al lunes"), nunca como presión falsa. (25-jul-2026)

## Arquitectura Vicky onboarding (decisión 26-jul-2026)
- Es un SEGUNDO AGENTE (prompt, tools y estado propios) en el MISMO repo y deploy. Agente = unidad de diseño; repo/deploy = unidad de operación — no acoplar los ejes.
- Cerebro PURO en `lib/onboarding/` (sin Supabase/Botmaker/Foundry/red); la frontera la vigila `tests/onboarding-frontera.test.ts`. Trigger de extracción a servicio propio: segundo consumidor real (chat in-app con fecha comprometida) o cambio de equipo dueño.
- Flag `VICKY_ONBOARDING_ENABLED` (apagado por defecto). Enrolamiento por DOS puertas, las dos obligatorias: pago online (`cerrarYTraspasarPostPago`) y comprobante legible (`registrarComprobanteTransferencia`). Empresa creada → completado; sin vueltas atrás.
- Con el flag ON en CL, Vicky NO manda el link del wizard: conduce el alta por chat. El wizard queda para CONFIGURACIÓN (turnos, planificaciones, carga masiva), no para el alta. CO y MX siguen con wizard + ejecutivo.
- Alcance del alta por chat: empresa + UN admin (6 campos). Turnos/planificaciones/trabajadores = configuración, van al wizard web, NO al chat.

## Entrega de correo (diagnóstico 26-jul-2026)
- Los correos SÍ se entregan (prueba real 5/5 por el stack productivo). SPF correcto con Zoho autorizado (8 de 10 consultas DNS — dos más y todo el dominio falla), DMARC `p=quarantine`, MX en Microsoft 365.
- Caen en Promociones (Gmail) / Otros (Outlook), NO en spam. Ahí nace el "no me llegó" (10 contactos jun-jul).
- Zoho `send_mail` solo registra `status: "sent"` — no existe delivered ni bounced. NADIE puede afirmar que un correo llegó; `lib/honestidad-entrega.ts` degrada esas afirmaciones.
- PENDIENTE: DMARC sin `rua=` — nadie recibe reportes. Una línea de DNS, riesgo cero, es el único instrumento para el problema grande (137 contactos sin correo de clave, sistema de la PLATAFORMA, fuera de estos repos).

## Reglas de negocio CRM (29-jul-2026, petición de marketing vía Lalo)
- **NUNCA crear Deals directamente en Zoho**: todo deal nace de un LEAD CONVERTIDO (puede ser instantáneo — crear lead y convertir en el mismo acto), con el lead asociado al deal. Sin esa cadena, la tasa de conversión Lead→Deal queda incalculable. Aplica a create-from-vicky (CL/CO/MX), al preform/Borrador y a cualquier flujo nuevo.
- Un deal demuestra intención comercial del usuario; etapas: intención→"1. Trato Creado", discovery SIN llegar al preform→"3. En Levantamiento", reunión realizada→"2. Primera Reunion Realizada" (sin tilde), **preform visto EN ADELANTE (incluida la formal)**→"4. Propuesta Enviada / En Negociación" (confirmado por Lalo 30-jul), aceptada→"6. Listo para Cierre", onboarding listo→"7. Implementando"; a Facturando lo mueve el ejecutivo. **El stage NUNCA retrocede** (Lalo 30-jul): cada hito es un PISO — el deal sube a max(etapa actual, etapa del hito); la reunión solo mueve el deal si está en "1. Trato Creado", si ya está en 3/4+ se registra como actividad sin tocar el stage. Stage está bajo Blueprint: los deals NACEN en su etapa; updates de stage solo vía transiciones (los campos mandatorios de la transición van DENTRO del `data` del PUT, y cada deal tiene SU blueprint — GET sus transitions primero).
- Dedup antes de crear leads (teléfono y email); leads existentes se enriquecen solo en campos VACÍOS y su status solo sube (nunca pisar gestión de SDR).
- **PRINCIPIO RECTOR (cicatriz 24-jul, reafirmado por Lalo 30-jul): la verificación de duplicidad JAMÁS toca la conversación.** El candado antiguo de "proceso humano" llegó a negar cotizaciones a clientes reales. Todo dedup/re-notificación/renacimiento de lead corre POR DETRÁS (async best-effort o cron), nunca en el camino de la respuesta al cliente: si el CRM falla o duda, la conversación sigue igual y se reconcilia después. El CRM decide cómo se REGISTRA al cliente, nunca cómo se le ATIENDE.
- **Proceso de Gestión de Leads (doc marketing, 30-jul)** — reglas de re-contacto/duplicidad: (1) primer contacto → lead automático; (2) lead activo en etapas 1-3 → RE-NOTIFICAR al owner, sin lead nuevo; (3) lead "No Calificado": <3 meses del último contacto → reactivar a "1. No contactado"; >3 meses → lead NUEVO en etapa 1 (excepción legítima al "status solo sube" y al dedup); (4) deal en "Cierre Perdido" → lead NUEVO en etapa 1; (5) deal activo (etapas 1-7) → re-notificar al owner, sin lead nuevo; (6) deal en "8. Facturando" (cliente actual) → lead NUEVO en etapa 1 (nueva oportunidad).

- **FUTURO — asignación por tómbola (anunciado por Lalo 30-jul, AÚN NO implementar)**: la asignación de leads/oportunidades de Vicky pasará de responsables fijos (hoy: Eddyluz CL en cotizador, owners por país, round-robins propios) a entregarse TODO por tómbola, aunque Vicky cotice y responda dudas. Se activa recién con el VºBº de Victoria Luna, después de que ella haga la bajada de Vicky a su equipo de telemarketing. Al implementarlo revisar: EJEC_OWNER del cotizador, round-robin SDR CL/CO, owners de crm-hitos y eventos de seguimiento por dueño.

## Convenciones operativas
- Deploy agente: push a `vicky-v3` (+ espejo `claude/trusting-ritchie-EVZIT` con --force-with-lease). Producción real = alias `geovictoria-whatsapp-agent-git-vicky-v3-geo-victoria.vercel.app` (la rama "production" de Vercel es master viejo — no usar).
- Siempre `npx tsc --noEmit && git commit && git push` encadenado con && (gate estricto).
- Secretos: nunca en el repo — viven en Vercel env y vic_kv.
