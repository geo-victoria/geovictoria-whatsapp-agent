# wa-espejo — espejo solo-lectura del WhatsApp de un ejecutivo

Replica a Supabase (`vic_wa_espejo_mensajes`) todo lo que entra y sale del
WhatsApp Business del celular de un ejecutivo, vinculándose como "dispositivo
vinculado" (mismo mecanismo que WhatsApp Web). El número sigue viviendo en el
celular; el ejecutivo no cambia nada. **Este proceso jamás envía mensajes.**

## Por qué NO corre en Vercel

Necesita un WebSocket persistente con los servidores de WhatsApp. Vercel es
serverless (los procesos mueren tras cada request). Se despliega en cualquier
host de procesos largos: Railway, Fly.io, Render o un VPS.

## Deploy en Railway (recomendado, ~5 min)

1. railway.app → New Project → Deploy from GitHub repo → elegir este repo.
2. Settings → Root Directory: `workers/wa-espejo` (usa el Dockerfile).
3. Variables:
   - `SUPABASE_URL` — la misma del agente
   - `SUPABASE_SERVICE_ROLE_KEY` — la misma del agente
   - `WA_SESSION_ID` — identificador del ejecutivo, ej `emujica`
4. Deploy. En los logs aparece `QR publicado`.

## Vinculación (una sola vez por ejecutivo)

1. Abrir `https://<agente>/api/vic-admin-wa-espejo?session=<WA_SESSION_ID>&key=<CRON_SECRET>`
   — la página muestra el QR vigente (rota sola cada ~1 min).
2. En el celular del ejecutivo: WhatsApp Business → Dispositivos vinculados →
   Vincular dispositivo → escanear.
3. La página pasa a "conectado". Listo: desde ese momento todo se espeja.

Si el ejecutivo desvincula el dispositivo desde su celular, el worker limpia
la sesión y vuelve a pedir QR al reiniciarse.

## Una sesión por ejecutivo

Cada número corporativo = un servicio con su propio `WA_SESSION_ID`. Para un
segundo ejecutivo se duplica el servicio en Railway cambiando esa variable.

## Datos

- `vic_wa_espejo_mensajes`: session_id, chat (jid y teléfono limpio), from_me,
  autor, tipo (texto/imagen/audio/...), texto, timestamps. Media (07-ago,
  pedido Lalo — leer comprobantes de pago): imágenes, audios y documentos se
  DESCARGAN y suben al bucket privado `wa-espejo` de Supabase Storage
  (media_path/media_mime); el cron `vic-wa-espejo-lector` del agente (Vercel,
  cada 5 min) los convierte a texto — visión Claude para imagen/PDF,
  ElevenLabs para notas de voz — y lo deja en media_texto. El worker solo
  acarrea bytes: las claves de IA nunca viven en Railway.
- `vic_wa_espejo_estado`: credenciales de la sesión (el proceso puede morir y
  renacer en otra máquina sin re-escanear).

## Reglas de diseño

- Solo lectura: no existe (ni debe agregarse) ninguna llamada a sendMessage.
- `markOnlineOnConnect: false`: si el espejo se marcara "en línea", el celular
  del ejecutivo dejaría de recibir notificaciones push.
- `syncFullHistory: false`: espeja desde la vinculación en adelante.
