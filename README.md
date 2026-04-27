# GeoVictoria WhatsApp Agent

Proyecto aislado para WhatsApp + agente Vic.

## Endpoints

- `GET /api/whatsapp/geovictoria/webhook` verificacion Meta
- `POST /api/whatsapp/geovictoria/webhook` mensajes entrantes
- `POST /api/vic-sales-agent` respuesta del agente
- `GET /api/conversations` auditoria de conversaciones

## Variables de entorno

Obligatorias:

- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_VERIFY_TOKEN`
- `ANTHROPIC_API_KEY` (o `OPENAI_API_KEY`)

Recomendadas:

- `WHATSAPP_APP_SECRET`
- `ANTHROPIC_SALES_AGENT_MODEL` (default: `claude-sonnet-4-5-20250929`)
- `ADMIN_API_SECRET` (protege `/api/conversations`)
- `CONVERSATION_INACTIVITY_MINUTES` (default: `20`)

Persistencia durable en Supabase:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Integraciones externas opcionales:

- `CRM_LEAD_WEBHOOK_URL` (recomendado: `https://geovictoria-whatsapp-agent.vercel.app/api/crm/zoho-lead`)
- `CONVERSATION_WEBHOOK_URL`
- `EVALUATION_WEBHOOK_URL`

Credenciales para alta directa en Zoho CRM (si usas `/api/crm/zoho-lead`):

- `ZOHO_ACCOUNTS_DOMAIN` (ej. `https://accounts.zoho.com`)
- `ZOHO_API_DOMAIN` (ej. `https://www.zohoapis.com`)
- `ZOHO_CLIENT_ID`
- `ZOHO_CLIENT_SECRET`
- `ZOHO_REFRESH_TOKEN`
- `ZOHO_CRM_LEADS_MODULE` (opcional, default: `Leads`)

## Activar persistencia Supabase

1. Ejecutar SQL: [docs/supabase-schema.sql](/C:/Users/Eduardo/geovictoria-whatsapp-agent/docs/supabase-schema.sql)
2. Cargar `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` en Vercel.
3. Redeploy.

Con Supabase configurado, `/api/conversations` responde con `source: "supabase"`.
