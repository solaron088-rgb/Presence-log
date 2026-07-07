# Presence Baileys Service

Servicio de monitoreo de presencia de WhatsApp usando Baileys directamente.

## Variables de entorno requeridas en EasyPanel

```
PORT=3000
N8N_WEBHOOK_URL=https://evolutionapi-monitor-n8n.zelwnc.easypanel.host/webhook/evolution-events
API_KEY=429683C4C977415CAAFCCE10F7D57E11
AUTH_DIR=/app/auth_info
```

## Endpoints

- GET  /health       — health check (sin auth)
- GET  /status       — estado de conexión
- GET  /qr           — obtener QR en base64
- POST /subscribe    — suscribirse a un número { "number": "50372107556" }
- POST /subscribe/bulk — suscribirse a varios { "numbers": ["503...","503..."] }
- POST /disconnect   — cerrar sesión

## Flujo

1. El servicio arranca y llama a connectToWhatsApp()
2. Genera un QR y lo manda al webhook de N8N (event: qrcode.updated)
3. Cuando escaneas el QR, se conecta y manda connection.update (state: open)
4. Llamas a POST /subscribe con el número que quieres monitorear
5. Baileys llama a presenceSubscribe(jid) — esto es lo que Evolution API no expone
6. Cuando el contacto se conecta/desconecta, llega el evento presence.update
7. El servicio lo manda al webhook de N8N con el mismo formato que Evolution API
