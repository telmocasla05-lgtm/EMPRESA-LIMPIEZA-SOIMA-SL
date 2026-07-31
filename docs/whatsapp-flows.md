# Flujos de conversación de WhatsApp

## Flujo actual: eco de recepción

1. El operario envía un mensaje de texto al número de WhatsApp de la empresa.
2. El webhook (`/api/whatsapp/webhook`) valida la firma y responde 200; el
   procesado sigue en background.
3. Se identifica al worker por su teléfono (`workers.phone`, con o sin `+`).
4. El mensaje se guarda en `whatsapp_messages` (direction `inbound`).
5. Se responde por WhatsApp: `Recibido: [texto]`.

Casos límite:

- Teléfono no registrado en `workers`: se ignora el mensaje (solo queda en
  los logs del servidor).
- Mensajes que no son de texto (audio, imagen…): se guardan con su `type` y
  `content` nulo, y no se responde.
