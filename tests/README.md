# Evals de Vicky

Suite de regresión. La regla es una sola:

> **Cada bug que llegó a un cliente real se convierte en un caso acá.**

Hasta el 26-jul-2026 el ciclo de mejora de Vicky era: cliente sufre el bug →
screenshot por WhatsApp → parche en producción. Sin red. Esta suite existe para
que un bug ya pagado no se pueda volver a pagar.

Cada test lleva en el nombre el caso real que lo originó (contacto, fecha) para
que se entienda por qué existe y nadie lo borre por "parece redundante".

## Correr

```bash
npm test          # toda la suite
npm run test:watch
```

Sin dependencias nuevas: `node:test` + el type-stripping nativo de Node 22.

## Qué se puede testear hoy

Solo módulos **puros** — sin `import` de `@/…`, de red ni de Supabase. El
type-stripping de Node no resuelve los alias de `tsconfig`, y un test que
necesita Zoho vivo no es un test.

Cubierto hoy:

| Archivo | Caso real que lo originó |
|---|---|
| `ruteo-pais.test.ts` | Master Bot rutea por canal, no por prefijo (26-jul) |
| `links-de-tools.test.ts` | Link de la demo borrado en el cierre de Pablo (25-jul) |
| `horario-habil.test.ts` | 12 mensajes a las 23:20 en Chile (24-jul) |
| `senal-espera.test.ts` | Tamara pidió no ser contactada hasta el martes (24-jul) |
| `estilo-vicky.test.ts` | Reglas de CLAUDE.md: nada de "Oye", nada de voseo |
| `identificadores.test.ts` | RUT/NIT/RFC = el Identifier del alta de empresa (26-jul) |
| `onboarding-borrador.test.ts` | El alta es irreversible: validar y confirmar antes de crear |
| `onboarding-fase.test.ts` | Pago → fase onboarding; el borrador sobrevive entre mensajes |
| `onboarding-frontera.test.ts` | La frontera del cerebro (decisión de arquitectura, 26-jul) |
| `honestidad-entrega.test.ts` | Vicky afirmó que el correo llegó sin poder saberlo (26-jul) |

## Lo que falta y por qué

Los guardrails que más fallan — descuento, reunión, contacto, allowlist — viven
**inline** dentro de `app/api/vic-botmaker-*/route.ts`, mezclados con I/O. No
son importables sin extraerlos a un módulo, y ese refactor toca la ruta caliente
de venta. Queda para después del arranque del Loop v2.

Cuando se extraigan, entran acá los ~29 disparos de la auditoría del 25-jul
(≈19 falsos positivos): el caso Jorge (+56954172536, 6 muletillas seguidas), el
caso Pablo (20% → 10%), la trampa de la capacitación "100% de descuento",
"agendemos" leído como "agendé", Iván Darío y los duplicados.

## Regla para escribir un caso

Las expectativas se validan **contra lo que el negocio quiere**, no contra lo
que el código hace hoy. Si un test se escribe copiando la salida actual, lo
único que garantiza es que el bug no cambie. Cuando un caso nuevo falla, la
pregunta es si está mal el código o está mal la expectativa — y esa la responde
un humano, no el test.
