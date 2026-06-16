# Acción de código de Botmaker — Vicky V3 (con soporte de notas de voz)

Acción que Botmaker ejecuta al recibir un mensaje; hace POST al webhook
`/api/vic-botmaker-v3`. Esta versión soporta notas de voz.

## Cómo entrega Botmaker una nota de voz (confirmado en producción)
- `context.message.MESSAGE` = `"__audio__"` (placeholder, NO viene vacío).
- `context.message.AUDIOS_URLS` = `["https://botm.cc/l/XXXX"]` (array con la URL).
- Esa URL devuelve los bytes del audio (ogg/opus) pero con el header
  `content-type: text/html` mal puesto — por eso el webhook fuerza `audio/ogg`
  al transcribir (ver `lib/transcribe-audio.ts`).

## Código (producción)

```js
// Vicky V3 — texto y notas de voz.
const phone = (context.userData.PLATFORM_CONTACT_ID || '').toString();
let   msg   = (context.message.MESSAGE || '').toString();

// Nota de voz: Botmaker pone MESSAGE = "__audio__" y la URL en AUDIOS_URLS[].
const audios = context.message.AUDIOS_URLS || [];
const audioURL = (Array.isArray(audios) && audios.length ? audios[0] : '').toString();
if (msg === '__audio__') { msg = ''; }

bmconsole.log('[Vicky V3] IN contact=' + phone + ' msg=' + JSON.stringify(msg).slice(0, 80) + ' audio=' + (audioURL ? 'si' : 'no'));

if (!phone || (!msg && !audioURL)) {
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
    if (data.handoff) { result.gotoRule('transferir_agente'); return; }
    if (data.reply && data.reply.trim()) { result.text(data.reply); }
    if (data.pdfUrl) { result.file(data.pdfUrl); }
  })
  .catch(err => {
    bmconsole.log('[Vicky V3] Error: ' + err.message);
    result.text('Estoy teniendo problemas técnicos. Un ejecutivo te contactará pronto.');
  })
  .finally(() => result.done());
}
```
