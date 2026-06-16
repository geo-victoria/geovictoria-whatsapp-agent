# Acción de código de Botmaker — Vicky V3 (con soporte de notas de voz)

Esta es la acción de código que Botmaker ejecuta al recibir un mensaje y que
hace POST al webhook `/api/vic-botmaker-v3`. Reemplaza la versión anterior
(que descartaba las notas de voz porque `context.message.MESSAGE` viene vacío
en un audio).

## Qué cambia respecto de la versión anterior
1. **Ya no descarta los audios.** Antes, si el texto venía vacío (nota de voz),
   el guard `if (!phone || !msg)` cortaba y nunca llamaba al webhook.
2. **Extrae la URL del audio** probando los nombres de campo más comunes de
   Botmaker, y si el propio `MESSAGE` es una URL de audio, la usa.
3. **Reenvía `audioURL`** en el body. El webhook ya lo lee (`body.audioURL`) y
   transcribe con Groq/Whisper.
4. **Loguea el objeto del mensaje** (`msgObj=...`) para confirmar el nombre real
   del campo de la URL del audio en la primera prueba (ver nota al final).

## Cómo validar el nombre real del campo
Envía UNA nota de voz de prueba al bot y mira en los logs de Botmaker la línea
`[Vicky V3] msgObj={...}`. Ahí aparece la estructura real del mensaje de audio.
- Si `audio=` salió con la URL → ya quedó funcionando.
- Si `audio=` salió vacío → en `msgObj` se ve el campo correcto (p. ej.
  `MEDIA_URL`, `fileUrl`, `media.url`, etc.); se agrega ese campo a la lista
  `audioURL = ( ... )` y listo.

## Código

```js
// Vicky V3 — lee el texto y, si es nota de voz, la URL del audio.
const phone = (context.userData.PLATFORM_CONTACT_ID || '').toString();
let   msg   = (context.message.MESSAGE || '').toString();

// URL del audio de una nota de voz. Botmaker la entrega en el objeto del
// mensaje; probamos los campos conocidos. Si MESSAGE mismo es una URL de
// audio, la tratamos como tal.
const m = context.message || {};
let audioURL = (
  m.MEDIA_URL || m.AUDIO_URL || m.FILE_URL || m.MEDIA || m.FILE || m.AUDIO || m.URL || ''
).toString();

const looksLikeAudio = /^https?:\/\/\S+\.(ogg|oga|opus|mp3|m4a|aac|wav|amr)(\?|$)/i;
if (!audioURL && looksLikeAudio.test(msg)) {
  audioURL = msg;
  msg = '';
}

bmconsole.log('[Vicky V3] IN contact=' + phone + ' msg=' + JSON.stringify(msg).slice(0, 120) + ' audio=' + JSON.stringify(audioURL).slice(0, 160));
// Diagnóstico (quitar una vez confirmado el campo del audio):
bmconsole.log('[Vicky V3] msgObj=' + JSON.stringify(m).slice(0, 500));

// Procesamos si hay texto O si hay audio (nota de voz sin texto).
if (!phone || (!msg && !audioURL)) {
  bmconsole.log('[Vicky V3] WARN sin phone o sin (msg/audio)');
  result.done();
} else {
  rp({
    method: 'POST',
    uri: 'https://geovictoria-whatsapp-agent-git-vicky-v3-geo-victoria.vercel.app/api/vic-botmaker-v3',
    headers: {
      'Content-Type': 'application/json',
      'x-secret': 'gv-botmaker-2026'
    },
    body: JSON.stringify({ contact: phone, message: msg || '__audio__', audioURL: audioURL }),
    timeout: 55000
  })
  .then(response => {
    const data = JSON.parse(response);
    bmconsole.log('[Vicky V3] OUT reply=' + JSON.stringify(data.reply).slice(0, 120));
    if (data.handoff) {
      result.gotoRule('transferir_agente');
      return; // OK: está dentro de la función del .then
    }
    if (data.reply && data.reply.trim()) {
      result.text(data.reply);
    }
    if (data.pdfUrl) {
      result.file(data.pdfUrl);
    }
  })
  .catch(err => {
    bmconsole.log('[Vicky V3] Error: ' + err.message);
    result.text('Estoy teniendo problemas técnicos. Un ejecutivo te contactará pronto.');
  })
  .finally(() => result.done());
}
```
