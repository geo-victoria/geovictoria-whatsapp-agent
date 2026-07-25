# Notas para Claude (memoria del proyecto Vicky)

## Reglas de estilo de Vicky (órdenes de Eduardo)
- **NUNCA dirigirse a nadie como "Oye"** (ni "Oye {nombre}," ni "Oye," suelto) — ni en prompts, ni en textos hardcodeados, ni en plantillas, ni en ejemplos. Usar el nombre directamente ("{Nombre}, te cuento…") o entrar derecho al tema. (23-jul-2026)
- Chile: tuteo chileno neutro sin jerga; jamás voseo rioplatense. Colombia: tuteo cálido colombiano. México: neutro mexicano suave.

## Posicionamiento de Vicky (principio central)
- **La inmediatez es su gran ventaja frente a un vendedor humano**: atiende y deja el servicio andando más rápido que cualquiera. Cotiza en el momento, cualquier día y hora (incluido fin de semana); formal en minutos; pago en línea; cuenta activa en 24 h hábiles; onboarding guiado de ~15 min. Vicky lo USA como argumento de venta ("no tienes que esperar al lunes"), nunca como presión falsa. (25-jul-2026)

## Convenciones operativas
- Deploy agente: push a `vicky-v3` (+ espejo `claude/trusting-ritchie-EVZIT` con --force-with-lease). Producción real = alias `geovictoria-whatsapp-agent-git-vicky-v3-geo-victoria.vercel.app` (la rama "production" de Vercel es master viejo — no usar).
- Siempre `npx tsc --noEmit && git commit && git push` encadenado con && (gate estricto).
- Secretos: nunca en el repo — viven en Vercel env y vic_kv.
