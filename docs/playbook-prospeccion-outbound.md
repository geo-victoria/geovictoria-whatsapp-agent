# Playbook — Vicky proactiva (leads del formulario web)

> Spec acordada (jul-2026). Vicky contacta proactivamente a los leads que llenan
> el formulario "Solicita una cotización o demo" del sitio. Principio rector:
> **velocity-first** — contactar en <5 min multiplica la calificación (~21×,
> MIT/InsideSales) y el 78% compra al que responde primero. Vicky responde en
> segundos 24/7: el toque 0 instantáneo es el arma; la cadencia es red de
> seguridad.

## 0. Entrada y ruteo (vive en Zoho)
- Fuente: formulario web (nombre, apellido, correo, empresa, teléfono, rango de
  empleados, ¿usa GeoVictoria?).
- **El Workflow de Zoho filtra y asigna a Vicky SOLO:** ≤49 empleados (rangos
  "1-19" y "20-49") **y** "¿Usas GeoVictoria?" = No.
- 50+ → ejecutivo/enterprise. Cliente actual → soporte. (Nada de eso llega a Vicky.)

## 1. Toque 0 (construido — Fase 1)
- Workflow de Zoho → `POST /api/vic-outbound-lead` (whatsapp-agent) **on-create,
  sin batch ni delay**.
- El endpoint: (1) envía la plantilla HSM de apertura vía Botmaker, (2) persiste
  la apertura de Vicky + los datos del formulario en la conversación (bloque
  interno `[Datos del formulario web: ...]`), para que al responder el lead,
  Vicky tenga todo el contexto.
- Seguro por defecto (sin `OUTBOUND_TEMPLATE_LEAD` no envía) · dedup (si la
  conversación existe, no toca) · excluye números internos.

### Contrato del webhook (para el Workflow de Zoho)
```
POST https://<host>/api/vic-outbound-lead
Headers: Content-Type: application/json · x-cron-secret: <vic_kv.followup_cron_secret>
Body: {
  "nombre": "María", "apellido": "Pérez", "empresa": "Comercial XYZ",
  "telefono": "+56912345678", "email": "maria@xyz.cl",
  "empleadosRango": "20 - 49", "zohoLeadId": "3525045..."
}
```

### Plantilla de apertura (aprobar en Meta vía Botmaker)
- Nombre sugerido: `vicky_lead_formulario` · categoría Utility · es_CL
- Variables por nombre: `nombre`, `empresa`
- Texto:
  > Hola {{nombre}} 👋 Soy Vicky de GeoVictoria. Recibimos tu solicitud de
  > cotización para {{empresa}}. Te ayudo a armarla al tiro por acá — ¿avanzamos?
- Configurar env `OUTBOUND_TEMPLATE_LEAD=<nombre en Botmaker>` para activar.

## 2. Calificación (BANT-lite: "calificar cotizando")
El formulario ya pre-calificó (progressive profiling). Vicky solo:
1. Confirma el **número exacto** de empleados (el rango no basta para el tramo).
2. Descubre **modalidad** (app/web/reloj) — su flujo normal.
3. **Cotiza de inmediato** → el micro-cierre ("¿te hace sentido?") revela el
   presupuesto/objeción → negocia o cierra. El presupuesto no se pregunta: se
   muestra el precio rápido.
4. Al cierre falta **solo el RUT** (email vino del formulario).
Ramas: caliente → cotiza · tibio → `programar_seguimiento` · >50 real → deriva.

## 3. Cadencia multicanal (solo si NO responde; se corta al primer reply)
| Toque | Cuándo | Canal | Intención | Fase |
|---|---|---|---|---|
| 0 | **<5 min del formulario** ⚡ | WhatsApp (plantilla) | Apertura: "recibimos tu solicitud" | **F1 ✅** |
| 1 | +1-2 h (mismo día) | Email | Respaldo: "te escribí por WhatsApp" + cert. DT | F2 |
| 2 | Día 1 | WhatsApp | Nudge consultivo corto | F2 |
| 3 | Día 2-3 | Dapta (voz) | Llamada IA a no-respondedores | F3 |
| 4 | Día 5 | Email | Valor: caso/beneficio | F2 |
| 5 | Día 7-8 | WhatsApp | Cierre cordial + puerta abierta | F2 |
Sin respuesta tras toque 5 → no-responde → nurture largo / humano.

## 4. Handoffs
- >50 exacto o cliente actual → ejecutivo/soporte (como siempre).
- Cierre/post-venta → Anderson.
- Voz (Dapta/Botmaker Callbots): bloqueante = confirmar endpoint de disparo por API.

## 5. Medición
Enviados → respondieron → calificados → cotizados → vendidos, por toque y canal.
El funnel dashboard ya mide preform→cotización→aceptada; falta instrumentar la
tasa de respuesta del toque 0 cuando haya volumen.

## Estado
- **F1 (WhatsApp toque 0): construida** — endpoint + modo prospección en el
  prompt. Falta: aprobar plantilla + setear `OUTBOUND_TEMPLATE_LEAD` + crear el
  Workflow en Zoho apuntando al endpoint.
- F2 (email, toques 1/2/4/5): por construir (orquestación de cadencia).
- F3 (voz): por evaluar (Dapta vs Botmaker Callbots).
