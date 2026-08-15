# SPEC — Módulo de incidencias

Estado: **especificación aprobada, pendiente de implementar**
Fecha: 2026-08-15
Base: entrevista de decisiones (sección 1) + código actual del webhook
(`app/api/whatsapp/webhook/route.ts`, `lib/whatsapp/`) y esquema en
`supabase/migrations/`

---

## 0. Resumen en dos párrafos

Un operario que se encuentra un problema en un centro —una fregona rota, el papel
agotado, un cristal partido, un suelo mojado sin señalizar— lo cuenta por WhatsApp
como lo contaría por teléfono: escribe una frase, manda una foto, o las dos cosas.
El sistema decide con IA si ese mensaje es un fichaje, una incidencia o ruido; si
es una incidencia la clasifica en uno de cuatro tipos, deduce el centro del fichaje
que el operario tiene abierto, guarda la foto en Storage y avisa por WhatsApp al
responsable de ese tipo. La incidencia queda registrada con estado **abierta**.

Desde el panel, el jefe la ve en la nueva sección **Incidencias**, la pasa a **en
curso** mientras la gestiona y la cierra como **resuelta** escribiendo qué se hizo.
En ese momento el operario recibe un WhatsApp con la nota de cierre. La regla de
oro es **no perder nunca un reporte**: si la IA falla, si la foto no se puede
descargar, si no hay responsable configurado o si no se sabe el centro, la
incidencia se abre igual —como "sin clasificar" si hace falta— y el panel dice qué
falta por completar.

---

## 1. Decisiones tomadas en la entrevista

| #  | Tema                          | Decisión |
|----|-------------------------------|----------|
| 1  | Fichaje vs incidencia         | Las palabras clave de fichaje mandan siempre; el resto lo clasifica la **IA** (fichaje / incidencia / ruido) |
| 2  | Tipos de incidencia           | Material roto, falta de stock, desperfecto en el centro, seguridad (+ `sin_clasificar` técnico) |
| 3  | Foto o audio sin texto        | Se **abre la incidencia ya** como `sin_clasificar` y el bot pide una descripción |
| 4  | Centro                        | El del **fichaje de entrada abierto**; si no hay, la incidencia queda sin centro |
| 5  | Responsable                   | **Uno por tipo**, configurable por empresa; sin configurar cae en `companies.phone` |
| 6  | Urgencia                      | **Prioridad automática por tipo**: seguridad = alta, resto = normal. Sin reavisos |
| 7  | Cierre                        | **Solo desde el panel**, con **nota de cierre obligatoria** y auditoría de quién y cuándo |
| 8  | Aviso de vuelta al operario   | **Solo al resolver**, incluyendo la nota del jefe |
| 9  | Alcance de la IA              | **Texto + foto (visión)**. Los audios no se clasifican: entran como `sin_clasificar` |
| 10 | Fallo de la IA                | La incidencia **se abre igual** como `sin_clasificar`, prioridad normal, aviso al teléfono de la empresa |
| 11 | Agrupación                    | **Ventana de 5 minutos**: lo que llegue después se adjunta a la incidencia abierta más reciente |
| 12 | Aviso al cliente              | **No**. El módulo es interno; ya decidirá el jefe si llama al cliente |
| 13 | Modelo                        | **Claude Opus 5** (`claude-opus-5`) vía `@anthropic-ai/sdk` (dependencia nueva aprobada) |
| 14 | Fotos                         | Bucket **privado** `incidencias` en Supabase Storage + enlace firmado desde el panel |
| 15 | Panel                         | Sección propia **Incidencias** + contador de abiertas en la vista **Hoy** |

### 1.1 Supuestos que no se preguntaron (marcados para revisión)

- **Fichaje pendiente + incidencia a la vez.** Si el operario escribió `entro`
  (queda `workers.pending_action = 'entrada'`) y antes de mandar la ubicación
  envía una foto de un problema, el fichaje **no se pierde**: se abre la
  incidencia y la respuesta termina recordando *"Sigo esperando tu ubicación para
  la entrada."* `pending_action` solo lo limpia el flujo de fichaje.
- **Permisos.** `manager` y `admin` ven y resuelven incidencias (mismo criterio
  que la decisión 15 de `SPEC-facturacion.md`). Configurar los **responsables**
  es solo de `admin`.
- **Sin redimensionar imágenes.** Se envían a la IA tal como llegan de WhatsApp.
  Redimensionar abarataría el coste pero exige una librería nueva (`sharp`), y
  CLAUDE.md pide proponerla antes.
- **Sin borrado automático de fotos.** Se descartó la caducidad en la entrevista;
  si el almacenamiento crece, se añade después con un cron.

---

## 2. Modelo de datos

Migración nueva: `npx supabase migration new incidencias`.
Toda tabla lleva `company_id not null` y política RLS por company (CLAUDE.md).

### 2.1 `incidents`

```sql
create table public.incidents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  -- Número correlativo por empresa: es lo que se dice por WhatsApp ("#12").
  ref integer not null,
  worker_id uuid not null references public.workers (id) on delete cascade,
  -- Nullable: el operario puede reportar sin estar fichado (decisión 4).
  center_id uuid references public.centers (id) on delete set null,

  type text not null default 'sin_clasificar'
    check (type in ('material_roto', 'falta_stock', 'desperfecto',
                    'seguridad', 'sin_clasificar')),
  priority text not null default 'normal' check (priority in ('alta', 'normal')),
  status text not null default 'abierta'
    check (status in ('abierta', 'en_curso', 'resuelta')),

  -- Lo que escribió el operario (texto suelto o pie de foto). Null si solo mandó
  -- una foto o un audio y todavía no ha descrito nada.
  description text,

  -- Traza de la clasificación, para poder auditar por qué salió ese tipo.
  ai_model text,
  ai_summary text,
  ai_confidence text check (ai_confidence in ('alta', 'media', 'baja')),
  ai_error text,
  classified_at timestamptz,

  -- Aviso al responsable: se guarda a qué teléfono se avisó para no repetirlo.
  notified_phone text,
  notified_at timestamptz,

  resolved_by uuid references public.profiles (id) on delete set null,
  resolved_at timestamptz,
  resolution_note text,
  -- Aviso de cierre al operario (decisión 8).
  worker_notified_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (company_id, ref),

  -- Resolver exige nota y auditoría: sin esto el estado 'resuelta' no dice nada.
  constraint incidents_resuelta_completa check (
    status <> 'resuelta' or (
      resolved_at is not null
      and resolved_by is not null
      and resolution_note is not null
      and length(trim(resolution_note)) > 0
    )
  )
);

create index incidents_company_id_idx on public.incidents (company_id);
create index incidents_status_idx on public.incidents (company_id, status);
create index incidents_worker_recent_idx on public.incidents (worker_id, created_at desc);
```

`sin_clasificar` **no es un quinto tipo de negocio**: es el estado técnico de una
incidencia que la IA no pudo tipificar (fallo, foto sola, audio). El panel la
muestra en gris con un aviso de "pendiente de clasificar" y el jefe la corrige a
mano.

### 2.2 `incident_attachments`

```sql
create table public.incident_attachments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  incident_id uuid not null references public.incidents (id) on delete cascade,
  kind text not null check (kind in ('image', 'audio')),
  -- id de media en Meta: sirve para reintentar la descarga si falló.
  whatsapp_media_id text not null,
  mime_type text,
  -- Ruta dentro del bucket privado. Null si la descarga de Meta falló.
  storage_path text,
  download_error text,
  created_at timestamptz not null default now()
);

create index incident_attachments_incident_id_idx
  on public.incident_attachments (incident_id);
```

### 2.3 `incident_responsibles`

```sql
create table public.incident_responsibles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  type text not null
    check (type in ('material_roto', 'falta_stock', 'desperfecto', 'seguridad')),
  name text not null,
  -- Teléfono en formato internacional, con o sin '+', igual que workers.phone.
  phone text not null,
  created_at timestamptz not null default now(),
  unique (company_id, type)
);
```

No hay fila para `sin_clasificar`: esas incidencias avisan siempre a
`companies.phone`.

### 2.4 Numeración de `ref`

Mismo patrón que la emisión de facturas, pero **sin la exigencia legal de no dejar
huecos** (una incidencia borrada puede dejar un número muerto y no pasa nada):

```sql
create or replace function public.siguiente_ref_incidencia(p_company_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  siguiente integer;
begin
  -- Serializa por company: dos operarios reportando a la vez no colisionan.
  perform pg_advisory_xact_lock(hashtextextended(p_company_id::text, 0));
  select coalesce(max(ref), 0) + 1 into siguiente
  from public.incidents where company_id = p_company_id;
  return siguiente;
end;
$$;
```

### 2.5 RLS

```sql
alter table public.incidents enable row level security;
alter table public.incident_attachments enable row level security;
alter table public.incident_responsibles enable row level security;

-- Incidencias y adjuntos: aislamiento por company; admin y manager por igual.
create policy "incidents_tenant_isolation" on public.incidents
  for all using (company_id = public.user_company_id())
  with check (company_id = public.user_company_id());

create policy "incident_attachments_tenant_isolation" on public.incident_attachments
  for all using (company_id = public.user_company_id())
  with check (company_id = public.user_company_id());

-- Responsables: los ve toda la company, los edita solo el admin.
create policy "incident_responsibles_select" on public.incident_responsibles
  for select using (company_id = public.user_company_id());

create policy "incident_responsibles_write_admin" on public.incident_responsibles
  for all using (
    company_id = public.user_company_id() and public.user_role() = 'admin'
  )
  with check (
    company_id = public.user_company_id() and public.user_role() = 'admin'
  );
```

El webhook escribe con `service_role` (se salta la RLS), igual que hoy con
`time_entries` y `whatsapp_messages`.

### 2.6 Bucket `incidencias`

Privado, mismo criterio que `facturas`. Ruta:
`<company_id>/<incident_id>/<whatsapp_media_id>.<ext>`.

```sql
insert into storage.buckets (id, name, public)
values ('incidencias', 'incidencias', false)
on conflict (id) do nothing;

create policy "incidencias_select_own_company" on storage.objects
  for select using (
    bucket_id = 'incidencias'
    and (storage.foldername(name))[1] = public.user_company_id()::text
  );
```

**No hace falta política de escritura**: las fotos las sube siempre el webhook con
`service_role`, nunca el panel. La descarga va por un route handler que valida la
sesión y devuelve una URL firmada de 60 s; el bucket nunca se sirve público.

---

## 3. Flujo de WhatsApp

### 3.1 Orden de decisión de un mensaje entrante

Se ejecuta en `processIncomingMessage` (`lib/whatsapp/process-message.ts`), en
background con `after()` como ahora. El orden importa:

```
1. Teléfono no registrado / en varias empresas  → igual que hoy, se corta
2. Se guarda en whatsapp_messages               → igual que hoy (+ caption en content)
3. ¿type === "location"?                        → flujo de fichaje (sin cambios)
4. ¿type === "text" y parseIntent() acierta?    → flujo de fichaje (sin cambios)
5. ¿type === "text" | "image" | "audio"?        → flujo de incidencias (nuevo)
6. Cualquier otro tipo                          → solo log, como hoy
```

El paso 4 es la garantía de que **`entro` nunca acaba en la IA**: las palabras
clave se comparan sobre el mensaje completo normalizado y ganan siempre.

### 3.2 Flujo de incidencias

```
Operario                                    Sistema
   │  "se ha roto el carro de la 2ª planta"    │
   │──────────────────────────────────────────>│  clasifica con IA (texto)
   │                                           │  centro = fichaje abierto
   │                                           │  crea incidents (#12, abierta)
   │  "✅ Incidencia #12 registrada…"          │  avisa al responsable de tipo
   │<──────────────────────────────────────────│
   │  [foto]  (dentro de 5 min)                │
   │──────────────────────────────────────────>│  se adjunta a la #12, no crea otra
```

Pasos exactos:

1. **Ventana de agrupación (5 min).** Se busca la incidencia más reciente de ese
   `worker_id` con `created_at > now() - interval '5 minutes'` y `status = 'abierta'`.
   Si existe, el mensaje **se adjunta** a ella (ver 3.3). Si no, se crea una nueva.
2. **Descarga de media.** Para `image` y `audio` se descarga de Meta y se sube al
   bucket (ver 3.4). Si falla, la incidencia se abre igual con
   `incident_attachments.download_error` relleno.
3. **Clasificación.** Ver sección 4. Solo se llama a la IA si hay texto y/o imagen.
   Un audio suelto no se clasifica: entra como `sin_clasificar`.
4. **Centro.** Última entrada del worker sin salida posterior:
   ```sql
   select center_id from time_entries
   where worker_id = $1 and type = 'entrada'
   order by created_at desc limit 1
   ```
   Solo vale si **no hay una `salida` posterior**. Si no la hay → `center_id = null`.
   Los fichajes con `valid = false` cuentan: el operario está donde está aunque el
   fichaje esté pendiente de revisión.
5. **Alta.** `ref` desde `siguiente_ref_incidencia()`, `status = 'abierta'`,
   `priority = 'alta'` si `type = 'seguridad'`, si no `'normal'`.
6. **Aviso al responsable.** Ver sección 5. Nunca tumba el alta: si el envío falla,
   la incidencia queda creada con `notified_at = null` y el panel la marca como
   "aviso pendiente".
7. **Respuesta al operario.** Una sola respuesta, después de clasificar. Si la IA
   tarda más de 8 s se corta y se responde como `sin_clasificar` (ver 4.4).

### 3.3 Reglas de agrupación

Dentro de la ventana de 5 minutos:

- **Foto o audio** → se añade una fila a `incident_attachments`. Respuesta:
  `📎 Añadido a la incidencia #12.`
- **Texto, cuando la incidencia estaba `sin_clasificar`** → se guarda como
  `description`, se **reclasifica** con la IA (texto + primera foto si la hay), se
  actualiza `type` y `priority`. Respuesta con el tipo ya resuelto.
- **Texto, cuando la incidencia ya tenía tipo** → se concatena a `description`
  (`\n` de separación). **No se reclasifica**: el tipo ya lo decidió la IA con la
  información principal y reabrir esa decisión con cada frase suelta produciría
  cambios de responsable a mitad de camino.

**Reaviso tras reclasificar.** Solo se vuelve a avisar si el responsable calculado
es **distinto** del `notified_phone` ya guardado (p. ej. una foto sin texto que
avisó a `companies.phone` y al llegar "hay un cable pelado" pasa a seguridad).
Nunca se avisa dos veces al mismo teléfono por la misma incidencia.

### 3.4 Descarga de media de Meta (`lib/whatsapp/media.ts`)

Dos llamadas a la Graph API, ambas con `Authorization: Bearer $WHATSAPP_TOKEN`:

1. `GET https://graph.facebook.com/v23.0/{media_id}` → devuelve `{ url, mime_type }`.
2. `GET {url}` → los bytes. **La URL caduca en minutos**, por eso hay que
   descargarla en el momento y no guardarla.

Luego `supabase.storage.from("incidencias").upload(path, bytes, { contentType })`.

Mismos criterios que `lib/whatsapp/send.ts`: 3 intentos, backoff exponencial
(500 ms · 2ⁿ), timeout de 10 s por intento, y los 4xx que no son 429 no se
reintentan. Límite de tamaño: 8 MB; por encima se descarta el fichero y se guarda
`download_error` (WhatsApp ya comprime, así que en la práctica no se toca).

### 3.5 Textos de las respuestas al operario

Todos en español (CLAUDE.md), hora Europe/Madrid.

| Situación | Mensaje |
|---|---|
| Incidencia clasificada | `✅ Incidencia #12 registrada: *Material roto* en Oficinas Norte.\nAviso enviado a tu responsable.` |
| Sin centro | Igual, pero la primera línea acaba en `registrada: *Material roto*.` (sin centro) |
| Foto o audio sin texto | `📷 Recibido, incidencia #12 abierta.\n¿Me cuentas en una frase qué ha pasado? Así aviso a la persona correcta.` |
| Adjunto añadido | `📎 Añadido a la incidencia #12.` |
| Fallo de la IA | `⚠️ Incidencia #12 registrada, pero no he podido clasificarla. Ya está avisado tu responsable, que la revisará en el panel.` |
| Ruido (`gracias`, `ok`, `vale`) | *(sin respuesta y sin incidencia; solo queda en `whatsapp_messages`)* |
| Fichaje pendiente | Se añade al final: `Sigo esperando tu ubicación para la entrada.` |

---

## 4. Clasificación con IA

Fichero nuevo: `lib/ia/clasificar-incidencia.ts`.

### 4.1 Dependencia y configuración

- Dependencia nueva aprobada: **`@anthropic-ai/sdk`** (decisión 13).
- Variable de entorno nueva: **`ANTHROPIC_API_KEY`** (solo servidor; nunca
  `NEXT_PUBLIC_`).
- Modelo: **`claude-opus-5`**.
- `output_config.effort: "low"` — es una clasificación entre cinco etiquetas, no
  necesita razonamiento profundo, y `low` recorta latencia y coste.
- `max_tokens: 2000` (holgura: en Opus 5 el pensamiento está activo por defecto y
  cuenta contra `max_tokens`).
- `cache_control: { type: "ephemeral" }` sobre el bloque de sistema. El prompt de
  sistema debe ser **byte a byte idéntico** en cada llamada: nada de interpolar
  nombre de empresa, fecha ni id — todo eso va en el turno de usuario, o el caché
  no sirve de nada.

### 4.2 Entrada

- **Sistema** (fijo): explica que es un asistente de una empresa de limpieza, que
  recibe mensajes de operarios por WhatsApp, y define los cinco valores de `tipo`
  con un ejemplo corto cada uno. Advierte de que `entro`, `salgo`, `hola`, `ok`,
  `gracias` y similares **no son incidencias**.
- **Usuario**: el texto del operario y, si la hay, la primera imagen de la
  incidencia como bloque `image` en base64 (`media_type` el de Meta, normalmente
  `image/jpeg`).

### 4.3 Salida estructurada

Con `output_config.format` de tipo `json_schema` (nada de pedir "responde en JSON"
en el prompt): la API garantiza que el JSON valida contra el esquema.

```jsonc
{
  "type": "object",
  "additionalProperties": false,
  "required": ["intencion", "tipo", "resumen", "confianza"],
  "properties": {
    "intencion": { "type": "string", "enum": ["incidencia", "fichaje", "ruido"] },
    "tipo": {
      "type": "string",
      "enum": ["material_roto", "falta_stock", "desperfecto",
               "seguridad", "sin_clasificar"],
      "description": "sin_clasificar si intencion no es incidencia o no está claro"
    },
    "resumen": {
      "type": "string",
      "description": "Una frase de como mucho 100 caracteres, en español"
    },
    "confianza": { "type": "string", "enum": ["alta", "media", "baja"] }
  }
}
```

Tratamiento del resultado:

- `intencion === "ruido"` → no se crea incidencia, no se responde.
- `intencion === "fichaje"` → **no** se ficha (fichar exige ubicación); se responde
  con el mensaje de ayuda que ya existe: *"Escribe **entro** para fichar la entrada
  o **salgo** para la salida."*
- `intencion === "incidencia"` con `confianza === "baja"` → se abre igual, pero con
  el `tipo` que dijo la IA y una marca en el panel para que el jefe lo confirme.
- El esquema no admite `maxLength` (limitación de structured outputs), así que el
  límite de `resumen` va en la descripción y se trunca a 200 caracteres al guardar.

### 4.4 Fallos y límites

| Fallo | Comportamiento |
|---|---|
| Timeout (8 s) o error de red | 1 reintento; si vuelve a fallar → `sin_clasificar` + `ai_error` |
| `stop_reason === "refusal"` | Se comprueba **antes** de leer `content`; → `sin_clasificar` + `ai_error` |
| `429` / `5xx` | El SDK ya reintenta 2 veces solo; después → `sin_clasificar` |
| Sin `ANTHROPIC_API_KEY` | No se llama a la IA; todas las incidencias entran `sin_clasificar` y se registra un error en logs una sola vez |

En los cuatro casos **la incidencia se crea igual** (decisión 10) y se avisa a
`companies.phone`.

### 4.5 Coste estimado

Con Opus 5 ($5 / millón de tokens de entrada, $25 / millón de salida):

| Caso | Entrada aprox. | Coste aprox. |
|---|---|---|
| Solo texto | ~700 tokens | **~0,006 $** |
| Texto + foto | ~5 400 tokens | **~0,027 $** |

Unas 200 incidencias al mes con foto salen por **~5 $/mes**. Si el volumen se
dispara, las dos palancas son bajar a `claude-sonnet-5` (~40 % menos) o
redimensionar las fotos antes de enviarlas (requiere aprobar `sharp`).

---

## 5. Notificaciones

### 5.1 Al responsable, al abrir

Destinatario: `incident_responsibles.phone` del tipo; si no hay fila, o el tipo es
`sin_clasificar`, `companies.phone`. Si `companies.phone` también está vacío, no se
envía nada, se registra en logs y la incidencia queda con `notified_at = null`.

```
🔧 Incidencia #12 · Material roto
Oficinas Norte
Operario: Marta Ruiz
"Se ha roto la rueda del carro grande"
📷 1 foto — revísala en el panel
```

Para prioridad alta, la primera línea cambia:

```
🚨 URGENTE · Incidencia #12 · Seguridad
```

Variantes: sin centro se omite esa línea; sin descripción se pone
`(sin descripción todavía)`; sin fotos se omite la última línea.

Tras el envío se guardan `notified_at` y `notified_phone`.

### 5.2 Al operario, al resolver

Se dispara al pasar a `resuelta` desde el panel. Nunca tumba el cierre: si el envío
falla, la incidencia queda resuelta con `worker_notified_at = null` y el panel lo
indica (mismo criterio que el aviso de factura en `SPEC-facturacion.md` 1.1).

```
✅ Tu incidencia #12 (Material roto) está resuelta.
Nota: Carro nuevo entregado el lunes en el centro.
```

No hay aviso al pasar a **en curso** (decisión 8).

---

## 6. Panel

### 6.1 Sección `Incidencias`

Nueva entrada en la navegación de `app/dashboard/shell.tsx`, ruta
`app/dashboard/incidencias/`.

**Lista** (`page.tsx`), ordenada por prioridad alta primero y luego por fecha
descendente:

| Columna | Contenido |
|---|---|
| # | `ref`, en rojo si `priority = 'alta'` |
| Estado | Chip: abierta (ámbar) · en curso (azul) · resuelta (verde) |
| Tipo | Etiqueta; `sin_clasificar` en gris con aviso "pendiente de clasificar" |
| Centro | Nombre, o `—` si no se dedujo |
| Operario | `workers.full_name` |
| Resumen | `ai_summary`, o los primeros 80 caracteres de `description` |
| Fecha | Fecha y hora en Europe/Madrid |

Filtros: **estado** (por defecto abiertas + en curso), **tipo**, **centro** y rango
de fechas. Avisos visibles en la lista: `notified_at = null` → "aviso pendiente".

**Detalle** (`[id]/page.tsx`):

- Cabecera con `#ref`, tipo, prioridad y estado.
- Descripción completa, operario, centro, fecha y traza de la IA (modelo,
  confianza, error si lo hubo).
- Galería de adjuntos: cada foto por URL firmada de 60 s desde un route handler
  (`app/dashboard/incidencias/[id]/adjunto/[attachmentId]/route.ts`) que valida la
  sesión antes de firmar. Los adjuntos con `download_error` se muestran como "no se
  pudo descargar".
- **Corregir tipo**: selector de los cuatro tipos. Al cambiarlo se recalcula la
  prioridad y, si cambia el responsable, se ofrece reenviar el aviso.
- **Botón "En curso"**: cambia el estado, sin más.
- **Botón "Resuelta"**: abre un cuadro con la nota de cierre. La nota es
  **obligatoria** (la base de datos lo exige, ver 2.1); al guardar se rellenan
  `resolved_by`, `resolved_at` y `resolution_note` y se dispara el aviso al operario.
- Una incidencia resuelta puede reabrirse a `en curso`; al hacerlo se conserva la
  nota anterior como historial en la propia `resolution_note` y se limpian
  `resolved_at` / `resolved_by`.

### 6.2 Vista Hoy

En `app/dashboard/hoy-view.tsx`, junto a las ausencias: contador de **incidencias
abiertas** de la company, enlazando a la sección filtrada. Si hay alguna de
prioridad alta, el contador se muestra en rojo.

### 6.3 Configuración de responsables

Dentro de la propia sección (`app/dashboard/incidencias/responsables/`), visible
para todos y editable solo por `admin`: cuatro filas fijas (una por tipo) con
nombre y teléfono. Sin rellenar, el tipo cae en `companies.phone` y la pantalla lo
dice explícitamente.

---

## 7. Casos límite

| Caso | Comportamiento |
|---|---|
| Teléfono no registrado / en dos empresas | Igual que hoy: no se crea nada, solo logs y aviso al operario |
| Texto que es palabra clave de fichaje | Flujo de fichaje. La IA no llega a verlo |
| Texto de ruido (`ok`, `gracias`, `vale`) | Ni incidencia ni respuesta. Queda en `whatsapp_messages` |
| Foto sin texto | Incidencia `sin_clasificar` + petición de descripción |
| Audio (con o sin texto) | Igual que la foto: `sin_clasificar`, se guarda el audio, se pide descripción |
| Varias fotos seguidas | Todas a la misma incidencia si están dentro de los 5 min |
| Texto tras la ventana de 5 min | **Incidencia nueva**. El jefe puede cerrar la duplicada desde el panel |
| Operario sin fichaje abierto | Incidencia sin centro; el jefe lo asigna en el panel |
| Fallo de la IA | `sin_clasificar`, prioridad normal, aviso a `companies.phone` |
| Fallo al descargar la foto | Incidencia creada; el adjunto queda con `download_error` |
| Fallo al subir a Storage | Igual: `download_error` con el motivo. No se pierde la incidencia |
| Tipo sin responsable configurado | Aviso a `companies.phone` |
| `companies.phone` vacío también | No se envía nada; `notified_at = null` y "aviso pendiente" en el panel |
| Fallo al avisar al responsable | La incidencia queda creada; el panel muestra "aviso pendiente" |
| Fallo al avisar al operario tras resolver | La incidencia queda resuelta; `worker_notified_at = null` |
| Worker desactivado (`active = false`) | Se procesa igual: si sigue trabajando, su reporte vale |

---

## 8. Multi-tenant y seguridad

- Todas las tablas nuevas llevan `company_id not null` con RLS (sección 2.5).
- `incident_attachments.company_id` es **redundante** con el de la incidencia, y a
  propósito: permite que la política RLS filtre sin un `join` a `incidents`.
- La `company_id` de una incidencia sale siempre del `worker`, nunca del payload de
  WhatsApp.
- El webhook sigue usando `service_role` desde `lib/supabase/admin.ts`, que solo se
  importa desde código de servidor.
- `ANTHROPIC_API_KEY` solo en el servidor. La llamada a la IA vive en
  `lib/ia/clasificar-incidencia.ts`, importado exclusivamente desde el flujo del
  webhook.
- El bucket `incidencias` es privado y solo se lee por URL firmada de 60 s, previa
  validación de sesión.
- La firma del webhook (`x-hub-signature-256`) y la respuesta en menos de 5 s no
  cambian: todo el trabajo nuevo (descarga de media, IA, avisos) corre dentro del
  `after()` que ya existe.

---

## 9. Ficheros

### Nuevos

```
supabase/migrations/<ts>_incidencias.sql
lib/whatsapp/media.ts                       descarga de Meta + subida a Storage
lib/whatsapp/incidencias.ts                 alta, agrupación, centro, avisos
lib/ia/clasificar-incidencia.ts             llamada a Claude + esquema de salida
lib/incidencias/estado.ts                   transiciones y aviso de cierre (panel)
app/dashboard/incidencias/page.tsx          lista + filtros
app/dashboard/incidencias/[id]/page.tsx     detalle y acciones
app/dashboard/incidencias/[id]/adjunto/[attachmentId]/route.ts   URL firmada
app/dashboard/incidencias/responsables/page.tsx
docs/whatsapp-flows.md                      (sección nueva, ver abajo)
```

### Modificados

```
lib/whatsapp/process-message.ts   ramas de image/audio y texto no reconocido
app/dashboard/shell.tsx           entrada "Incidencias" en la navegación
app/dashboard/hoy-view.tsx        contador de incidencias abiertas
docs/whatsapp-flows.md            flujo de incidencias + tabla de casos límite
package.json                      @anthropic-ai/sdk
.env.example                      ANTHROPIC_API_KEY
```

`lib/whatsapp/time-entry.ts` **no se toca**: `parseIntent` sigue igual y conserva
la prioridad sobre la IA.

---

## 10. Tests (Vitest)

Solo el test afectado en cada cambio, no toda la suite (CLAUDE.md).

| Fichero | Qué cubre |
|---|---|
| `tests/incidencias-enrutado.test.ts` | `entro`/`salgo` no llegan nunca a la IA; texto libre sí; ruido no crea incidencia |
| `tests/incidencias-agrupacion.test.ts` | Ventana de 5 min: dentro adjunta, fuera crea nueva; reclasificación solo si estaba `sin_clasificar` |
| `tests/incidencias-centro.test.ts` | Entrada abierta → centro; entrada con salida posterior → sin centro; `valid = false` cuenta |
| `tests/incidencias-responsable.test.ts` | Tipo → responsable, fallback a `companies.phone`, sin teléfono → sin aviso |
| `tests/incidencias-mensajes.test.ts` | Textos exactos de los mensajes, incluido el prefijo 🚨 de seguridad |
| `tests/incidencias-ia.test.ts` | Fallo, timeout y `refusal` acaban en `sin_clasificar` sin perder la incidencia (SDK mockeado) |
| `tests/rls-incidencias.test.ts` | Aislamiento entre companies en las tres tablas; responsables solo editables por `admin` |

---

## 11. Fuera de alcance

- **Transcripción de audios.** Los audios se guardan y se pide texto, pero no se
  transcriben (decisión 9). Es la ampliación natural del módulo.
- **Aviso al cliente** cuando el desperfecto es en su centro (decisión 12).
- **Reavisos y escalado** si una incidencia de seguridad sigue abierta (decisión 6).
- **Consulta de incidencias por WhatsApp** por parte del operario o del jefe.
- **Coste de la incidencia** (piezas, horas) y su enlace con la facturación.
- **Borrado automático de fotos antiguas.**
