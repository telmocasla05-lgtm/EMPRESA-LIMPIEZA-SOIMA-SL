# Flujos de conversación de WhatsApp

## Flujo de fichaje (entrada/salida)

```
Operario                          Sistema
   │  "entro" / "hola"               │
   │────────────────────────────────>│  guarda pending_action = entrada
   │      "📍 comparte tu ubicación" │
   │<────────────────────────────────│
   │  [ubicación]                    │
   │────────────────────────────────>│  centro más cercano + radio + secuencia
   │  "✅ Entrada registrada en …"   │  inserta time_entry, limpia pending_action
   │<────────────────────────────────│
```

1. El operario escribe una palabra clave:
   - **Entrada:** `entro`, `entrada`, `hola`
   - **Salida:** `salgo`, `salida`, `me voy`
   - La comparación ignora mayúsculas, tildes y signos (`¡Hola!` vale),
     pero debe ser el mensaje completo (`hola jefe` no dispara nada).
2. El sistema guarda la acción pendiente en `workers.pending_action` y pide
   la ubicación.
3. Cuando llega la ubicación:
   - Busca el centro **más cercano** de la company del worker (Haversine).
   - Valida que la distancia ≤ `centers.radius_meters`.
   - Comprueba la coherencia con el último fichaje del worker.
   - Inserta en `time_entries` y limpia `pending_action`.
4. Respuestas (hora siempre en Europe/Madrid):
   - Todo correcto: `✅ Entrada registrada en [centro] a las [hora]`
   - Fuera de radio: se registra con `valid = false` y se avisa con la
     distancia y el radio permitido, "pendiente de revisión".

## Casos límite

| Caso | Comportamiento |
|---|---|
| Doble entrada (última = entrada sin salida) | Se registra con `valid = false`, se avisa al operario |
| Salida sin entrada previa | Se registra con `valid = false`, se avisa al operario |
| Fuera de radio | Se registra con `valid = false`, aviso con distancia y radio |
| Ubicación sin acción pendiente | Se pide escribir `entro` o `salgo` primero |
| Texto no reconocido | Mensaje de ayuda con las palabras clave |
| Company sin centros con coordenadas | Aviso de contactar con el responsable, no se registra |
| Teléfono no registrado en `workers` | "Contacta con tu responsable", no se guarda nada |
| Mensaje no texto/ubicación (audio, imagen…) | Se guarda en `whatsapp_messages`, sin respuesta |

`valid = false` siempre significa **pendiente de revisión por un jefe** en el
panel (las políticas RLS permiten a los jefes corregir `time_entries` de su
company).

Todo mensaje entrante se guarda en `whatsapp_messages` (salvo los de
teléfonos no registrados, que solo quedan en logs).

> Nota: este flujo sustituye al eco inicial ("Recibido: …") que existía
> durante la puesta en marcha del webhook.
