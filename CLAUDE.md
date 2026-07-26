# Notas para Claude (memoria del proyecto Vicky)

## Reglas de estilo de Vicky (órdenes de Eduardo)
- **NUNCA dirigirse a nadie como "Oye"** (ni "Oye {nombre}," ni "Oye," suelto) — ni en prompts, ni en textos hardcodeados, ni en plantillas, ni en ejemplos. Usar el nombre directamente ("{Nombre}, te cuento…") o entrar derecho al tema. (23-jul-2026)
- Chile: tuteo chileno neutro sin jerga; jamás voseo rioplatense. Colombia: tuteo cálido colombiano. México: neutro mexicano suave.

## Posicionamiento de Vicky (principio central)
- **La inmediatez es su gran ventaja frente a un vendedor humano**: atiende y deja el servicio andando más rápido que cualquiera. Cotiza en el momento, cualquier día y hora (incluido fin de semana); formal en minutos; pago en línea; cuenta activa en 24 h hábiles; onboarding guiado de ~15 min. Vicky lo USA como argumento de venta ("no tienes que esperar al lunes"), nunca como presión falsa. (25-jul-2026)

## Arquitectura Vicky onboarding (decisión 26-jul-2026)
- Es un SEGUNDO AGENTE (prompt, tools y estado propios) en el MISMO repo y deploy. Agente = unidad de diseño; repo/deploy = unidad de operación — no acoplar los ejes.
- Cerebro PURO en `lib/onboarding/` (sin Supabase/Botmaker/Foundry/red); la frontera la vigila `tests/onboarding-frontera.test.ts`. Trigger de extracción a servicio propio: segundo consumidor real (chat in-app con fecha comprometida) o cambio de equipo dueño.
- Flag `VICKY_ONBOARDING_ENABLED` (apagado por defecto). Enrolamiento: el PAGO mueve venta→onboarding en `cerrarYTraspasarPostPago`; empresa creada → completado; sin vueltas atrás.
- Alcance del alta por chat: empresa + UN admin (6 campos). Turnos/planificaciones/trabajadores = configuración, van al wizard web, NO al chat.

## Entrega de correo (diagnóstico 26-jul-2026)
- Los correos SÍ se entregan (prueba real 5/5 por el stack productivo). SPF correcto con Zoho autorizado (8 de 10 consultas DNS — dos más y todo el dominio falla), DMARC `p=quarantine`, MX en Microsoft 365.
- Caen en Promociones (Gmail) / Otros (Outlook), NO en spam. Ahí nace el "no me llegó" (10 contactos jun-jul).
- Zoho `send_mail` solo registra `status: "sent"` — no existe delivered ni bounced. NADIE puede afirmar que un correo llegó; `lib/honestidad-entrega.ts` degrada esas afirmaciones.
- PENDIENTE: DMARC sin `rua=` — nadie recibe reportes. Una línea de DNS, riesgo cero, es el único instrumento para el problema grande (137 contactos sin correo de clave, sistema de la PLATAFORMA, fuera de estos repos).

## Convenciones operativas
- Deploy agente: push a `vicky-v3` (+ espejo `claude/trusting-ritchie-EVZIT` con --force-with-lease). Producción real = alias `geovictoria-whatsapp-agent-git-vicky-v3-geo-victoria.vercel.app` (la rama "production" de Vercel es master viejo — no usar).
- Siempre `npx tsc --noEmit && git commit && git push` encadenado con && (gate estricto).
- Secretos: nunca en el repo — viven en Vercel env y vic_kv.
