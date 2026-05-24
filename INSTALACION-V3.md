# Vicky V3 — Instalación en rama `feature/v3-tool-use-cotizadora`

Paquete de archivos listos para subir a la rama nueva. Cero modificación al código de V2 productivo.

**Scope de esta iteración**: prospectos con 1 a 50 trabajadores.

---

## 1. Estructura de archivos a agregar

```
app/
├── api/
│   └── vic-sales-agent-v3/
│       ├── route.ts                    ← endpoint nuevo
│       └── prompt.ts                    ← system prompt con catálogo dinámico
└── vic-v3/
    └── page.tsx                         ← página de chat de prueba

components/
└── geovictoria-sales-agent-v3.tsx       ← componente de chat (cliente, con debug pane)

lib/
├── agent-loop.ts                        ← ReAct loop (Claude tool use)
├── catalogo/                            ← ⭐ catálogo de productos con tiers
│   ├── tipos.ts                         ← types incluyendo TierPrecio
│   ├── modulos.ts                       ← módulos con array de tiers
│   ├── hardware.ts                      ← hardware de marcaje
│   ├── index.ts                         ← helpers (obtenerTierAplicable, etc.)
│   └── CATALOGO.md                      ← guía de mantenimiento
└── tools/
    ├── index.ts                         ← catálogo + dispatcher
    ├── cotizar-referencial.ts           ← scope 1-50 con tiers
    ├── generar-link-cotizadora.ts       ← scope 1-50, valida catálogo
    └── derivar-a-soporte.ts             ← handoff explícito (>50 trabajadores incluido)
```

**14 archivos nuevos**. Cero modificación de archivos existentes.

---

## 2. Dependencia nueva en `package.json`

```json
"@anthropic-ai/sdk": "^0.30.0"
```

Instalar con `pnpm add @anthropic-ai/sdk`.

---

## 3. Variables de entorno

Reutiliza la `ANTHROPIC_API_KEY` que ya tenés en Vercel.

Opcional:
```
ANTHROPIC_SALES_AGENT_MODEL_V3=claude-sonnet-4-5-20250929
```

---

## 4. Pasos operativos

```bash
git checkout -b feature/v3-tool-use-cotizadora

# Copiar los 14 archivos a sus ubicaciones (ver sección 1)

pnpm add @anthropic-ai/sdk
pnpm build  # verificar compilación

git add .
git commit -m "feat: v3 con tool use + catálogo de tiers (scope 1-50)

- endpoint /api/vic-sales-agent-v3 con ReAct loop
- 3 tools: cotizar_referencial, generar_link_cotizadora, derivar_a_soporte
- catálogo en lib/catalogo con flag disponibleParaVicky y tiers de precio
- scope 1-50 trabajadores con tier de Asistencia escalonado (fijo 1-10,
  por usuario 11-20, 21-30, 31-50)
- Sense Face 2A habilitado como dispositivo de marcaje opcional
- system prompt V3 dinámico (lee catálogo en cada request)
- página /vic-v3 con debug pane
- cero cambios al flujo productivo de V2"

git push -u origin feature/v3-tool-use-cotizadora
```

Vercel auto-deploya un preview. Accedés a `/vic-v3` en esa URL.

---

## 5. Qué está habilitado para Vicky en esta versión

### Módulos de software habilitados (6)

| ID | Nombre | Tiers de precio |
|---|---|---|
| `asistencia` | Control de Asistencia | 1-10: 0.75 UF fijo · 11-20: 0.09 UF/usuario · 21-30: 0.08 UF/usuario · 31-50: 0.07 UF/usuario |
| `vacaciones` | Vacaciones y Permisos | 1-50: 0.022 UF/usuario |
| `banco` | Banco de Horas | 1-50: 0.05 UF/usuario |
| `alertas` | Alertas | 1-50: 0.019 UF/usuario |
| `calendario` | Planificador Inteligente | 1-50: 0.014 UF/usuario |
| `documental` | Gestión Documental | 1-50: 0.012 UF/usuario |

### Módulos declarados pero deshabilitados (4)

Quedan declarados con sus tiers completos. Para habilitar uno, cambiar `disponibleParaVicky: false` → `true` en `lib/catalogo/modulos.ts`:

- `reporte` (mín 5 trabajadores): 5-10: 0.015 · 11-20: 0.013 · 21-50: 0.012
- `victoria` (mín 5 trabajadores): 5-10: 0.017 · 11-20: 0.015 · 21-50: 0.012
- `casino`: 1-20: 1.261 UF fijo · 21-50: 2.101 UF fijo
- `dashboard`: 1-50: 1.25 UF fijo

### Hardware habilitado (1)

| ID | Display Name | Modalidad | Precio |
|---|---|---|---|
| `senseface_2a` | Sense Face 2A | Arriendo | 0.25 UF/mes |

### Hardware declarado pero deshabilitado (15)

Todos los demás equipos de la cotizadora oficial están declarados con `disponibleParaVicky: false`. Habilitar uno = cambiar el flag.

---

## 6. Qué probar antes de mergear a `main`

### Casos felices — empresa chica (1-10)
- [ ] "Somos 7" → Vicky pregunta módulos.
- [ ] "Asistencia y vacaciones" → Vicky calcula con tier fijo de 0.75 UF para Asistencia.
- [ ] Vicky ofrece SF2A proactivamente, prospecto acepta 1 unidad.
- [ ] Preform muestra total mensual estimado.
- [ ] Confirmación → link entregado.

### Casos felices — empresa mediana (11-50)
- [ ] "Somos 25" → Vicky pregunta módulos.
- [ ] "Asistencia y banco de horas" → Vicky calcula con tier 21-30 de Asistencia (0.08 UF/usuario).
- [ ] El debug pane muestra el tier aplicado en `tierAplicado: "21-30 usuarios"`.
- [ ] Si pide 2 unidades de SF2A, advertencia aparece en `advertencias[]`.

### Casos de derivación
- [ ] "Somos 80" → Vicky deriva con motivo `fuera_de_rango_trabajadores`.
- [ ] "Quiero hablar con un humano" → deriva `solicitud_explicita_persona`.
- [ ] "Soy cliente, mi reloj no marca" → deriva `cliente_existente_problema`.
- [ ] "¿Tienen Reporte?" → deriva `fuera_de_scope` (porque está deshabilitado).

### Casos de borde
- [ ] Prospecto dice "100 personas" → derivación correcta.
- [ ] Prospecto dice "alrededor de 50" → Vicky pide número exacto antes de cotizar.
- [ ] RUT persona natural: aceptado sin pedir RUT empresa.
- [ ] Edge case 50 trabajadores: tier de Asistencia debe ser 31-50 (0.07 UF/usuario).

### Validación del catálogo gobernable
- [ ] Preguntá a Vicky "¿qué módulos ofrecés?". Debe listar exactamente los 6 habilitados con sus tiers.
- [ ] Habilitá temporalmente `reporte` en `lib/catalogo/modulos.ts`. Push. Verificá que Vicky empieza a ofrecerlo a empresas con 5+ trabajadores.
- [ ] Volvé a deshabilitar. Verificá que vuelve a derivar si lo piden.

### Validación arquitectónica
- [ ] El debug pane muestra las tools invocadas.
- [ ] Iteraciones del agent loop visibles.
- [ ] Tool result incluye `tierAplicado` para cada módulo.
- [ ] Advertencias visibles cuando aplican (módulos fuera de rango, hardware con cantidad > sugerida).

### Criterio final
- [ ] Cero markers convencionales en el código nuevo.
- [ ] El flujo V2 productivo (`/vic`, `/api/vic-botmaker`, `/api/vic-sales-agent`) sigue funcionando idéntico.

---

## 7. Cómo modificar el catálogo después

Toda la documentación de mantenimiento está en `lib/catalogo/CATALOGO.md`. Casos típicos:

- **Habilitar un producto**: cambiar `disponibleParaVicky: false` → `true`.
- **Cambiar un precio de un tier**: editar el `precioUF` del tier correspondiente.
- **Agregar producto nuevo**: agregar entrada al array, definir tiers.
- **Extender scope a más rangos**: actualizar `SCOPE_MAX_USUARIOS` y agregar tiers.

Después de cualquier cambio: commit, push, Vercel auto-deploya, el system prompt se regenera con el catálogo actualizado.

---

## 8. Si algo falla

- **Compila pero `/vic-v3` da 500**: revisar logs de Vercel del endpoint. Más común: `ANTHROPIC_API_KEY` no propagada al environment "Preview".
- **Vicky no aplica el tier correcto**: verificar en debug pane el campo `tierAplicado`. Si está mal, revisar los rangos en `modulos.ts` (no deben solaparse).
- **Una tool devuelve "no está habilitado"**: catálogo correcto, modelo intentó cotizar algo deshabilitado. Esperado.
- **Loop alcanza MAX_ITERATIONS (8)**: posible bug en una tool. Revisar logs.

---

Cualquier cosa, me decís y lo iteramos.
