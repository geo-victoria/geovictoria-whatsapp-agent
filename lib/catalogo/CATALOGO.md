# Catálogo de productos de Vicky

Este directorio define qué productos puede cotizar Vicky V3. La premisa rectora del sistema es:

> **Solo se cotiza lo que existe en el catálogo Y tiene `disponibleParaVicky === true`.**

Cualquier intento de cotizar algo fuera del catálogo, o algo con el flag en `false`, hace que la tool falle con un error legible que Vicky puede comunicar al prospecto o usar para derivar a soporte.

**Scope actual**: 1 a 50 trabajadores.

---

## Estructura

```
lib/catalogo/
├── tipos.ts              ← Types compartidos (no editar salvo extender el modelo)
├── modulos.ts            ← Módulos de software con tiers de precio
├── hardware.ts           ← Hardware de marcaje (Sense Face 2A, etc.)
├── index.ts              ← Re-exports + helpers (obtenerTierAplicable, etc.)
└── CATALOGO.md           ← Este archivo
```

---

## Modelo de tiers de precio

Los módulos pueden tener varios precios según el rango de usuarios. Por ejemplo, Asistencia para 2-10 personas es un precio fijo (0.60 UF total), pero para 11-50 cambia a precio por usuario en tres tramos (0.07, 0.065, 0.055 UF). El tramo de 1 persona es un micro-plan fijo aparte (0.25 UF).

Esto se modela con un array `tiers`:

```typescript
tiers: [
  { minUsuarios: 1, maxUsuarios: 1, modalidad: "fijo", precioUF: 0.25 },
  { minUsuarios: 2, maxUsuarios: 10, modalidad: "fijo", precioUF: 0.6 },
  { minUsuarios: 11, maxUsuarios: 20, modalidad: "por_usuario", precioUF: 0.07 },
  { minUsuarios: 21, maxUsuarios: 30, modalidad: "por_usuario", precioUF: 0.065 },
  { minUsuarios: 31, maxUsuarios: 50, modalidad: "por_usuario", precioUF: 0.055 },
]
```

El helper `obtenerTierAplicable(modulo, userCount)` busca automáticamente cuál tier aplica para el `userCount` que recibió la tool.

Para módulos que tienen precio uniforme en todo el rango (ej. Vacaciones), se declara un solo tier que cubre 1-50:

```typescript
tiers: [{ minUsuarios: 1, maxUsuarios: 50, modalidad: "por_usuario", precioUF: 0.022 }]
```

---

## Mínimos globales

Algunos módulos requieren mínimo de trabajadores para activarse. Por ejemplo, Reporte y VictorIA requieren 5+ trabajadores. Esto se modela con `minUsuariosTotal`:

```typescript
{
  id: "reporte",
  nombre: "Reporte",
  minUsuariosTotal: 5,  // ← requiere 5+ trabajadores
  tiers: [
    { minUsuarios: 5, maxUsuarios: 10, modalidad: "por_usuario", precioUF: 0.015 },
    { minUsuarios: 11, maxUsuarios: 20, modalidad: "por_usuario", precioUF: 0.013 },
    { minUsuarios: 21, maxUsuarios: 50, modalidad: "por_usuario", precioUF: 0.012 },
  ],
  disponibleParaVicky: false,
}
```

Si una empresa tiene 3 trabajadores y Vicky intenta cotizar Reporte, la tool va a generar una advertencia (no falla la cotización entera, solo omite ese módulo y notifica).

---

## Casos de uso comunes

### 1. Habilitar un producto declarado pero deshabilitado

Por ejemplo: querés que Vicky empiece a ofrecer Reporte (que ahora aplica para 5-50 trabajadores).

1. Abrí `modulos.ts`.
2. Buscá el objeto con `id: 'reporte'`.
3. Cambiá `disponibleParaVicky: false` → `disponibleParaVicky: true`.
4. Commit & push.

Vercel auto-deploya. Vicky lo va a ofrecer en la próxima conversación a empresas con 5+ trabajadores.

### 2. Deshabilitar un producto temporalmente

Mismo flujo pero al revés. Vicky deja de ofrecerlo inmediatamente. Si un prospecto pregunta por él, Vicky responde que para esa consulta lo deriva a un ejecutivo.

### 3. Cambiar un precio

Por ejemplo: el tier 21-30 de Asistencia sube a 0.085 UF por usuario.

1. `modulos.ts` → buscar `id: 'asistencia'` → encontrar el tier de `minUsuarios: 21, maxUsuarios: 30` → cambiar `precioUF: 0.08` → `precioUF: 0.085`.
2. Commit & push.

**Importante**: hay que coordinar el cambio con el equipo de la cotizadora oficial. Si Vicky cotiza 0.085 UF y la cotizadora oficial todavía dice 0.08, el cliente al abrir el link va a ver una discrepancia.

### 4. Agregar un producto nuevo

1. Verificar que el producto existe en la cotizadora oficial (`catalogoEquipos` o `pricingTiers` del `index.html`).
2. Agregar entrada al array correspondiente en este repo, con el mismo `id`.
3. Definir tiers según los rangos de la cotizadora oficial.
4. `disponibleParaVicky: false` por defecto al agregar.
5. Validar conversacionalmente y recién cambiar el flag a `true`.

### 5. Extender el scope a más rangos en el futuro

Si en algún momento Vicky tiene que cubrir 51-100 o más:

1. Cambiar `SCOPE_MAX_USUARIOS` en `lib/tools/cotizar-referencial.ts` y `generar-link-cotizadora.ts`.
2. Agregar tiers nuevos a cada módulo en `modulos.ts` para cubrir los nuevos rangos.
3. Actualizar el system prompt (mención de "1-50" → nuevo límite).

El refactor se mantiene contenido: la estructura de tiers ya está pensada para extenderse aditivamente.

---

## Convenciones

### IDs

- Siempre minúsculas, con guion bajo si tienen palabras compuestas.
- Deben coincidir EXACTAMENTE con los del `index.html` de la cotizadora oficial.
- Una vez asignado a un producto, no se cambia.

### Precios

- Siempre en UF.
- IVA se aplica al final, no se incluye en el precio del catálogo.
- Si un hardware no se vende (solo arriendo), `ventaUF: 0` y `modalidadesDisponibles: ["arriendo"]`.

### Disponibilidad

- `disponibleParaVicky: false` es el default seguro al agregar un producto nuevo. Solo activar cuando esté validado conversacionalmente.

### Tiers

- Los rangos NO deben solaparse (ej. `1-10` y `11-20`, nunca `1-10` y `10-20`).
- El primer tier debe empezar en 1 (o en `minUsuariosTotal` si el módulo tiene mínimo global).
- El último tier debe cubrir hasta `SCOPE_MAX_USUARIOS` (actualmente 50).

---

## Cómo verificar que un cambio fue bien aplicado

Después de cualquier modificación al catálogo:

1. **Compilación**: `pnpm build`. Si hay typos o tipos mal definidos, falla acá.
2. **Verificación visual en `/vic-v3`**: el system prompt incluye el catálogo. Preguntale a Vicky "¿qué módulos ofrecés?". Debería listar exactamente los que tienen `disponibleParaVicky: true`, con sus tiers.
3. **Verificación funcional**: simulá la conversación completa para distintos tamaños (7, 20, 45 trabajadores). Verificá en el debug pane que la tool aplica el tier correcto en cada caso.

---

## Path evolutivo del catálogo

Esta es la segunda iteración (scope 1-50 con tiers). Mejoras planificadas según se necesiten:

| Mejora | Cuándo hacerla |
|---|---|
| Endpoint `/api/catalogo` en cotizador oficial, consumido por Vicky | Cuando la duplicación duela: primer error de precio incoherente |
| Tabla Supabase + UI admin para editar sin deploy | Cuando se sumen varios productos por mes |
| Soporte para hardware con tiers de cantidad/descuento | Cuando se quiera reflejar `sf2aDiscountTiers` exacto |
| Catálogo multilingual | Si Vicky atiende prospectos en otros países |
| Validación en tiempo de build de cobertura de rangos | Para evitar olvidar un rango al agregar tiers |

Cada una de estas mejoras es opcional. El catálogo actual está pensado para que cada mejora sea aditiva, no destructiva.
