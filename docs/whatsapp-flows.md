# Flujos de conversación de WhatsApp

## Qué quiere el operario: clasificación del mensaje

Antes de tratar un mensaje como fichaje se decide qué intención tiene
(`lib/whatsapp/process-message.ts`). El orden importa:

```
1. ¿Palabra clave exacta de fichaje?  → flujo de fichaje (sin IA)
2. ¿Foto o audio?                     → flujo de incidencias (sin clasificar intención)
3. Resto de textos                    → clasificación con la API de Claude
4. Cualquier otro tipo                → solo se guarda, sin respuesta
```

El paso 1 es la garantía de que **`entro` nunca depende de la IA**: es el caso
más frecuente, tiene que funcionar aunque la API esté caída y no cuesta nada.

La clasificación devuelve una de tres intenciones, y el prompt vive aparte, en
`lib/whatsapp/intent.ts`, para poder afinarlo sin tocar el flujo:

| Intención | Ejemplos | Respuesta |
|---|---|---|
| `fichaje` | "ya he llegado", "acabo por hoy" | Mensaje de ayuda: `*entro*` / `*salgo*` (sin ubicación no se ficha) |
| `incidencia` | "se ha roto la fregona", "no queda papel" | Se abre la incidencia y se confirma |
| `desconocido` | "gracias", "hola jefe", ambiguos | Se le pide que aclare si quiere fichar o reportar |

Detalles de la llamada: modelo `claude-opus-5`, `effort: "low"`, salida
estructurada con esquema JSON (la API garantiza el formato) y 8 s de tiempo
máximo. Requiere `ANTHROPIC_API_KEY` (solo servidor).

**Si la clasificación falla** —falta la clave, timeout, rechazo o error de
red— el mensaje entra como **incidencia sin clasificar** y se avisa al
operario. Es deliberado: perder un reporte (un cable pelado, un suelo mojado)
cuesta mucho más que una incidencia de más, que el jefe cierra desde el panel.

> Pendiente del módulo de incidencias (`SPEC-incidencias.md`): **el listado y
> el detalle en el panel**. Lo único que hay de pantalla es la configuración de
> responsables; el resto solo se ve consultando la tabla `incidents` en
> Supabase.

## Flujo de incidencias

```
Operario                                    Sistema
   │  "se ha roto el carro de la 2ª planta"    │
   │──────────────────────────────────────────>│  1. audio → Whisper
   │                                           │  2. tipo y urgencia → Claude
   │                                           │  3. centro = fichaje abierto
   │                                           │  4. alta en incidents (open)
   │  "📋 Incidencia registrada: …"            │  5. foto → bucket privado
   │<──────────────────────────────────────────│
```

El alta vive en `lib/whatsapp/incidencias.ts`. Pasos, en orden:

1. **Adjunto.** Foto y audio se bajan de la Graph API en dos llamadas
   (`lib/whatsapp/media.ts`): primero los metadatos, después los bytes — esa
   segunda URL caduca en minutos, así que no se guarda. Límite de 8 MB.
2. **Audio → texto.** La nota de voz se transcribe con **Whisper**
   (`lib/ia/transcribir-audio.ts`, `OPENAI_API_KEY`) y la transcripción hace de
   descripción. Es la única llamada del proyecto a un modelo que no es Claude.
3. **Tipo y urgencia.** `lib/ia/clasificar-incidencia.ts` manda a Claude el
   texto y, si la hay, **la foto** (visión, base64). Mismos parámetros que la
   clasificación de intención: `claude-opus-5`, `effort: "low"`, salida
   estructurada. Solo se llama si hay algo que leer.

   | Tipo | Ejemplo |
   |---|---|
   | `material_roto` | "se ha roto la fregona", "la aspiradora echa humo" |
   | `falta_stock` | "no queda papel", "se ha acabado la lejía" |
   | `desperfecto` | "hay un cristal partido", "el grifo gotea" |
   | `seguridad` | "hay un cable pelado", "suelo mojado sin señalizar" |
   | `sin_clasificar` | La IA falló, o solo hay una foto sin describir |

   La urgencia la decide la IA, con una regla que manda sobre ella:
   **`seguridad` siempre es `alta`**.
4. **Centro.** El del fichaje de entrada abierto: se lee el último movimiento
   del operario en `time_entries` y, si es una `entrada`, se toma su centro. Si
   es una `salida` o no hay ninguno, la incidencia queda **sin centro** y el
   jefe se lo asigna en el panel. Los fichajes pendientes de revisión
   (`valid = false`) cuentan: el operario está donde está.
5. **Alta** en `incidents` con `status = 'open'`.
6. **Foto** al bucket privado `incidencias`, en
   `<company_id>/<incident_id>/<media_id>.<ext>`, y la ruta en `photo_url`
   (una ruta, no una URL pública: el panel la sirve firmada a 60 s).
7. **Aviso al responsable** por WhatsApp (`lib/incidencias/aviso.ts`).

### A quién se avisa

`incident_responsibles` guarda un responsable por tipo y empresa, configurable
en **Panel → Incidencias → Responsables** (solo admin; los manager lo ven). El
orden es:

```
1. ¿Hay responsable para ese tipo?   → a su teléfono
2. Si no, o si es sin_clasificar     → al teléfono de la empresa (companies.phone)
3. Si la empresa tampoco tiene       → no se avisa: queda "aviso pendiente"
```

`sin_clasificar` nunca tiene responsable a propósito: una incidencia que la IA
no pudo tipificar no tiene dueño natural, así que la coge quien manda.

El mensaje lleva tipo, centro, operario, descripción y el enlace de la foto
(firmado, **7 días**: el responsable abre el WhatsApp cuando puede):

```
🔧 Incidencia · Material roto
Oficinas Norte
Operario: Marta Ruiz
"Se ha roto la rueda del carro grande"
📷 Foto (el enlace caduca en 7 días): https://…
```

Con urgencia alta la primera línea pasa a `🚨 URGENTE · Incidencia · Seguridad`.
Sin centro se omite esa línea; sin descripción se pone `(sin descripción
todavía)`; sin foto no hay última línea.

Tras el envío se guardan `notified_phone` y `notified_at`. Si el envío falla,
**la incidencia queda creada** con `notified_at` a null: el aviso nunca tumba
el alta.

Respuestas al operario:

| Situación | Mensaje |
|---|---|
| Clasificada | `📋 Incidencia registrada: [tipo]. Nos ponemos en ello.` |
| Sin clasificar (falló la IA) | `⚠️ No he entendido bien tu mensaje, así que lo he registrado…` |
| Foto o audio sin nada que leer | `📷 Recibido, he abierto una incidencia. ¿Me cuentas…?` |

**Regla de oro: no perder nunca un reporte.** Si falla la descarga del adjunto,
la transcripción, la clasificación o la subida a Storage, la incidencia se abre
igual y lo que falte queda a la vista en el panel. Solo un error de la propia
inserción en `incidents` corta el flujo.

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
| Texto no reconocido | Lo clasifica la IA (ver sección anterior) |
| Company sin centros con coordenadas | Aviso de contactar con el responsable, no se registra |
| Teléfono no registrado en `workers` | "Contacta con tu responsable", no se guarda nada |
| Imagen o audio | Se abre una incidencia sin descripción y se pide que la cuente |
| Otros tipos (sticker, contacto…) | Se guarda en `whatsapp_messages`, sin respuesta |

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
