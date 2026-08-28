# WhatsApp Personal ↔ Claude (puente MCP)

Puente local para conectar **tu WhatsApp personal** con Claude: leer tus chats y
enviar respuestas desde Claude (claude.ai Desktop o Claude Code).

**Es completamente independiente de Vicky**: no toca su número, su webhook ni su
código. Corre solo en tu computador y se vincula a tu cuenta como un
"dispositivo vinculado" más (igual que WhatsApp Web).

## ⚠️ Advertencias — leer antes de usar

- Usa una librería **no oficial** (Baileys, protocolo de WhatsApp Web). Va contra
  los términos de servicio de WhatsApp y existe riesgo (bajo, pero real) de que
  Meta suspenda el número. Úsalo bajo tu propio criterio.
- La carpeta `auth/` que se crea al vincular **es la llave de tu cuenta**:
  quien la tenga puede leer y enviar mensajes como tú. No la copies, no la
  subas a ningún lado (ya está en `.gitignore`).
- Para desconectarlo en cualquier momento: WhatsApp → Ajustes → Dispositivos
  vinculados → cerrar la sesión del dispositivo, y borra la carpeta `auth/`.

## Requisitos

- Node.js 18 o superior
- Claude Desktop o Claude Code en el mismo computador

## Instalación

```bash
cd personal-whatsapp-mcp
npm install
```

## Paso 1 — Vincular tu WhatsApp (el QR)

```bash
node index.js link
```

Aparece un QR en la terminal. En tu teléfono: **WhatsApp → Ajustes →
Dispositivos vinculados → Vincular dispositivo** y escanéalo. Cuando diga
"Cuenta vinculada", listo. Esto se hace una sola vez (la sesión queda en `auth/`).

## Paso 2 — Conectarlo a Claude

**Claude Code** (terminal):

```bash
claude mcp add whatsapp-personal -- node /ruta/absoluta/a/personal-whatsapp-mcp/index.js
```

En Windows:

```bash
claude mcp add whatsapp-personal -- node C:\ruta\a\personal-whatsapp-mcp\index.js
```

**Claude Desktop**: en `claude_desktop_config.json` agrega:

```json
{
  "mcpServers": {
    "whatsapp-personal": {
      "command": "node",
      "args": ["/ruta/absoluta/a/personal-whatsapp-mcp/index.js"]
    }
  }
}
```

## Paso 3 — Usarlo

Pídele a Claude cosas como:

- "Lista mis chats recientes de WhatsApp"
- "Léeme los últimos mensajes de Kristel"
- "Busca en mis mensajes dónde hablamos de la matrícula"
- "Respóndele a Kristel que imprimo el Excel esta tarde"

Claude te pedirá confirmación antes de enviar cualquier mensaje.

## Herramientas expuestas

| Herramienta       | Qué hace                                            |
| ----------------- | --------------------------------------------------- |
| `listar_chats`    | Chats recientes con su último mensaje               |
| `leer_mensajes`   | Últimos mensajes de un chat (nombre, teléfono o jid)|
| `buscar_mensajes` | Búsqueda de texto en todo lo guardado               |
| `enviar_mensaje`  | Envía un texto desde tu cuenta                      |

## Limitaciones

- El puente guarda los mensajes que llegan **mientras está corriendo** (más el
  historial reciente que WhatsApp envía al vincular). No descarga todo tu
  historial antiguo.
- Solo texto (los adjuntos se muestran como `[imagen]`, `[audio]`, etc.).
- El proceso debe estar corriendo para que Claude pueda usarlo; Claude lo
  levanta automáticamente al iniciar sesión si lo registraste como MCP.
