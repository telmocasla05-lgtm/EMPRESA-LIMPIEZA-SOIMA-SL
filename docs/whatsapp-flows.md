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

## Aviso de turno del día siguiente (saliente, sin conversación)

Cada día a las **20:00 Europe/Madrid** un cron de Vercel
(`/api/cron/avisos-turnos`, protegido con `CRON_SECRET`) envía a cada
operario sus turnos de mañana aún no notificados:

- Un turno: `📅 Mañana: [centro], de [inicio] a [fin]`
- Varios turnos: `📅 Mañana tienes N turnos:` seguido de una línea `•` por
  turno, ordenados por hora de inicio.

Tras el envío se marca `shifts.notified = true`. Si el envío falla, el turno
queda sin marcar y se registra en logs; los turnos de workers desactivados se
omiten. Vercel Cron solo programa en UTC, así que hay dos pasadas (18:00 y
19:00 UTC) y el endpoint ejecuta solo la que cae a las 20:00 de Madrid
(`?force=1` la salta para pruebas manuales).

## Aviso de ausencia al admin (saliente, sin conversación)

Cada **15 minutos** un cron de Vercel (`/api/cron/ausencias`, protegido con
`CRON_SECRET`) busca turnos de hoy y de ayer (por los cercanos a medianoche)
que empezaron hace **más de 20 minutos** sin fichaje de entrada del worker.

El worker cuenta como presente si:

- tiene una **entrada** entre una hora antes del inicio y el fin del turno
  (las pendientes de revisión, `valid = false`, también cuentan), o
- al empezar el turno **seguía fichado** de un turno anterior (turnos
  encadenados con un único fichaje).

Cada ausencia se registra una sola vez en `absences` (única por turno) y se
avisa al **teléfono de la company** (`companies.phone`):

```
⚠️ [Nombre] no ha fichado en [centro] (turno de [hora])
Sustitutos disponibles: [hasta 5 workers activos sin turno a esa hora]
```

Si no hay nadie libre, la segunda línea dice
`No hay sustitutos disponibles sin turno a esa hora.`

`absences.notified = true` se marca tras el envío: **nunca se avisa dos veces
por la misma ausencia**. Si el envío falla, la pasada siguiente lo reintenta
sin volver a registrarla; los turnos de workers desactivados se omiten y las
ausencias del día se muestran en la vista **Hoy** del panel.
