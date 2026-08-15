# SPEC — Módulo de facturación automática

Estado: **especificación aprobada, pendiente de implementar**
Fecha: 2026-08-13
Base: entrevista de decisiones (sección 1) + esquema actual en `supabase/migrations/`

---

## 0. Resumen en dos párrafos

Cada mes, el sistema convierte los fichajes de WhatsApp (`time_entries`) en una factura
por cliente. Empareja cada `entrada` con su `salida` para obtener jornadas, agrupa las
horas por centro, las multiplica por la tarifa que estaba vigente ese día y añade el IVA.
El día 1 de cada mes un proceso automático deja los **borradores** preparados; el
administrador los revisa y pulsa **Emitir**, y solo en ese momento la factura recibe
número, se congelan los importes y se genera el PDF.

La regla de oro es **no facturar a ciegas**: si un operario se dejó una salida sin fichar,
si hay un fichaje pendiente de revisión, si falta el centro o si falta la tarifa, la
factura de ese cliente queda bloqueada y el panel dice exactamente qué hay que arreglar.

---

## 1. Decisiones tomadas en la entrevista

| # | Tema | Decisión |
|---|------|----------|
| 1 | Entrada sin salida | No genera horas y **bloquea** la emisión de ese cliente hasta resolverla |
| 2 | Redondeo | Minutos reales; se redondea solo al presentar (2 decimales) |
| 3 | Fichajes `valid = false` | Se excluyen y **bloquean** la emisión |
| 4 | Líneas de factura | Una línea por centro |
| 5 | Tarifa | Por centro, heredando la del cliente si el centro no tiene |
| 6 | Cambio de tarifa | Historial con fecha de efecto; un cambio a mitad de mes parte la línea en dos |
| 7 | Cliente sin horas | No se genera factura; aparece en la lista "sin actividad" |
| 8 | Impuestos | IVA 21 % por defecto, configurable por cliente |
| 9 | Numeración | Serie anual por empresa: `2026/0001`, correlativa y sin huecos |
| 10 | Generación | Cron el día 1 crea borradores; la emisión es manual |
| 11 | PDF | Real, generado en servidor con **pdf-lib** (dependencia nueva aprobada), guardado en Supabase Storage |
| 12 | Corrección posterior | Factura **rectificativa** en serie propia; la original nunca se toca |
| 13 | Jornada a caballo de dos meses | Va entera al mes de la **entrada** |
| 14 | Entrega | Descarga desde el panel **y** aviso automático al cliente por WhatsApp al emitir (revisada, ver 1.1) |
| 15 | Permisos | `manager` ve y resuelve incidencias; solo `admin` emite, rectifica y anula |
| 16 | Cobro | Vencimiento y forma de pago por cliente; IBAN de la empresa en el PDF |

### 1.1 Decisiones revisadas después de la entrevista

**Decisión 14 (2026-08-15): el envío automático entra en el módulo.**

Al emitir, el cliente recibe un WhatsApp en su `contact_phone` con el número de
factura, el importe y un enlace de descarga del PDF. Estaba en "fuera de alcance"
por trabajo pendiente, no por criterio: sin él, cada factura emitida obliga a
descargarla del panel y reenviarla a mano, que es justo lo que este SaaS viene a
quitar. Implementado en `lib/billing/aviso.ts`.

Tres reglas que lo acotan:

- **Nunca tumba una emisión.** Cuando llega el aviso la factura ya tiene número y
  valor legal. Si el cliente no tiene teléfono, si el PDF no se guardó o si Meta
  rechaza el envío, la factura se queda emitida y se avisa al admin de la company
  en `companies.phone`. El error jamás sube hasta deshacer la emisión.
- **El enlace del WhatsApp dura 30 días**, no 60 segundos (ver sección 3): el
  cliente abre el mensaje cuando le viene bien, y el plazo de pago habitual es de
  30 días. Es un enlace firmado sin sesión: quien lo tenga puede descargar esa
  factura —y solo esa— hasta que caduque. Asumido: expone menos que enviar el PDF
  adjunto por email, y es la factura de su propio destinatario.
- **No es configurable todavía.** No hay forma de desactivarlo por company ni por
  cliente. Si algún día hace falta, ahí es donde toca.

---

## 2. Modelo de datos

Todo vía migraciones nuevas (`npx supabase migration new <nombre>`). No se toca ninguna
migración ya aplicada. Toda tabla nueva lleva `company_id` y RLS, sin excepciones.

### 2.1 Datos fiscales que faltan

`companies` y `clients` no tienen hoy nada para emitir una factura legal.

```sql
alter table public.companies
  add column tax_id text,
  add column address text,
  add column postal_code text,
  add column city text,
  add column province text,
  add column iban text,
  add column logo_path text;

alter table public.clients
  add column tax_id text,
  add column address text,
  add column postal_code text,
  add column city text,
  add column province text,
  add column vat_rate numeric(5, 2) not null default 21.00,
  add column payment_terms_days integer not null default 30,
  add column payment_method text not null default 'transferencia'
    check (payment_method in ('transferencia', 'domiciliacion', 'efectivo', 'otro'));
```

Reglas:

- `companies.tax_id`, `address`, `postal_code`, `city` son **obligatorios para emitir**
  (no para guardar la empresa). Si faltan, el panel bloquea la emisión con un aviso que
  enlaza a la configuración de la empresa.
- Lo mismo con `clients.tax_id` y su dirección: sin NIF no se emite factura a ese cliente.
- `vat_rate` admite 0 para clientes exentos.

### 2.2 Historial de tarifas — `billing_rates`

Sustituye a `clients.hourly_rate` como fuente de verdad.

```sql
create table public.billing_rates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  -- center_id null = tarifa base del cliente, aplicable a todos sus centros
  center_id uuid references public.centers (id) on delete cascade,
  hourly_rate numeric(8, 2) not null check (hourly_rate >= 0),
  valid_from date not null,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null,
  -- Postgres 17: nulls not distinct evita dos tarifas base del mismo día
  constraint billing_rates_unique
    unique nulls not distinct (client_id, center_id, valid_from)
);

create index billing_rates_lookup_idx
  on public.billing_rates (client_id, center_id, valid_from desc);
```

**Migración de datos:** por cada `clients` con `hourly_rate` no nulo se inserta una fila
`(client_id, center_id = null, hourly_rate, valid_from = '2000-01-01')`, para que el
historial cubra cualquier mes pasado.

`clients.hourly_rate` se deja en la tabla, sin uso, y se elimina en una migración de
limpieza al final de la fase 3 (así un despliegue a medias no rompe
[clientes-view.tsx](app/dashboard/clientes/clientes-view.tsx)).

**Coherencia de company (patrón de `20260801135819_rls_coherencia_company.sql`):** la
política de `billing_rates` debe comprobar que `client_id` y `center_id` pertenecen a la
company del usuario, y además que el centro pertenece a ese cliente.

### 2.3 Facturas — `invoices`

```sql
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete restrict,

  kind text not null default 'ordinaria'
    check (kind in ('ordinaria', 'rectificativa')),
  rectifies_invoice_id uuid references public.invoices (id) on delete restrict,

  period_start date not null,
  period_end date not null,          -- inclusivo: último día del mes

  status text not null default 'borrador'
    check (status in ('borrador', 'emitida', 'anulada')),

  -- Numeración: null mientras es borrador
  series text,                       -- '2026' | 'R-2026'
  number integer,
  invoice_number text,               -- '2026/0001', para mostrar y buscar
  issue_date date,                   -- fecha de factura (Madrid)
  due_date date,
  issued_at timestamptz,
  issued_by uuid references public.profiles (id) on delete set null,

  -- Datos congelados al emitir (una factura no puede cambiar porque cambie el cliente)
  client_name text not null,
  client_tax_id text,
  client_address text,
  vat_rate numeric(5, 2) not null,
  payment_method text,
  payment_terms_days integer,

  total_hours numeric(10, 2) not null default 0,
  subtotal numeric(12, 2) not null default 0,
  vat_amount numeric(12, 2) not null default 0,
  total numeric(12, 2) not null default 0,

  pdf_path text,
  paid_at timestamptz,
  notes text,

  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null,

  constraint invoices_number_unique unique (company_id, series, number),
  constraint invoices_emitida_completa check (
    status <> 'emitida'
    or (series is not null and number is not null and issue_date is not null)
  ),
  constraint invoices_rectificativa_referencia check (
    (kind = 'rectificativa') = (rectifies_invoice_id is not null)
  )
);

-- Un solo borrador/factura viva por cliente y periodo (las rectificativas van aparte)
create unique index invoices_periodo_unico_idx
  on public.invoices (company_id, client_id, period_start)
  where kind = 'ordinaria' and status <> 'anulada';

create index invoices_company_period_idx
  on public.invoices (company_id, period_start desc);
create index invoices_pendientes_cobro_idx
  on public.invoices (company_id, due_date)
  where status = 'emitida' and paid_at is null;
```

### 2.4 Líneas — `invoice_lines`

Una línea por **centro y tramo de tarifa**. Si un centro cambió de precio el día 15, ese
centro genera dos líneas.

```sql
create table public.invoice_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  center_id uuid references public.centers (id) on delete set null,
  center_name text not null,         -- congelado
  description text not null,         -- 'Limpieza — Oficina Centro (01/03–14/03)'
  period_from date not null,
  period_to date not null,
  minutes integer not null,          -- minutos reales, para auditar
  hours numeric(10, 2) not null,     -- minutes/60 redondeado a 2 decimales
  hourly_rate numeric(8, 2) not null,
  amount numeric(12, 2) not null,    -- hours × hourly_rate
  position integer not null
);

create index invoice_lines_invoice_idx on public.invoice_lines (invoice_id, position);
```

### 2.5 Trazabilidad — `invoice_time_entries`

Qué jornadas concretas entraron en cada factura. Sirve para (a) justificar una factura
años después y (b) detectar que alguien corrigió un fichaje ya facturado.

```sql
create table public.invoice_time_entries (
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  entry_in_id uuid not null references public.time_entries (id) on delete restrict,
  entry_out_id uuid not null references public.time_entries (id) on delete restrict,
  company_id uuid not null references public.companies (id) on delete cascade,
  center_id uuid references public.centers (id) on delete set null,
  worker_id uuid not null references public.workers (id) on delete restrict,
  work_date date not null,           -- fecha Madrid de la entrada
  minutes integer not null,
  primary key (invoice_id, entry_in_id)
);

create index invoice_time_entries_entry_in_idx
  on public.invoice_time_entries (entry_in_id);
```

**Efecto lateral a documentar en el panel:** con `on delete restrict`, un operario con
horas ya facturadas no se puede borrar. Se marca inactivo con `workers.active = false`,
que ya existe. La UI de operarios debe explicarlo en vez de mostrar un error de base de
datos.

### 2.6 Contadores de numeración — `invoice_counters`

Correlativo sin huecos por empresa y serie, a prueba de dos personas emitiendo a la vez.

```sql
create table public.invoice_counters (
  company_id uuid not null references public.companies (id) on delete cascade,
  series text not null,
  last_number integer not null default 0,
  primary key (company_id, series)
);

create or replace function public.next_invoice_number(p_company uuid, p_series text)
returns integer
language sql
security definer
set search_path = ''
as $$
  insert into public.invoice_counters (company_id, series, last_number)
  values (p_company, p_series, 1)
  on conflict (company_id, series)
    do update set last_number = public.invoice_counters.last_number + 1
  returning last_number;
$$;
```

`on conflict do update` bloquea la fila: dos emisiones simultáneas se serializan y nunca
obtienen el mismo número. El número se pide **al final de la transacción de emisión**,
justo antes del commit; el PDF se genera después, de modo que un fallo del PDF no
consume ni desperdicia un número (se reintenta la generación, no la emisión).

`invoice_counters` no es una tabla de datos de negocio consultable: RLS activada, **sin
ninguna política** (solo accesible por `service_role` y por la función `security definer`).

---

## 3. RLS y permisos

Función auxiliar, mismo patrón que `user_company_id()`:

```sql
create or replace function public.user_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select role from public.profiles where id = (select auth.uid())
$$;
```

| Tabla | select | insert / update / delete |
|-------|--------|--------------------------|
| `billing_rates` | company | solo `admin`, con coherencia de company y de cliente↔centro |
| `invoices` | company | solo `admin` |
| `invoice_lines` | company | solo `admin` |
| `invoice_time_entries` | company | ninguna (lo escribe el servidor con `service_role`) |
| `invoice_counters` | ninguna | ninguna |

Los `manager` ven todo el módulo en modo lectura y siguen pudiendo corregir fichajes
(política de `time_entries` ya existente), que es como resuelven las incidencias.

**Inmutabilidad de lo emitido** — trigger `before update` en `invoices`:

```
Si OLD.status = 'emitida' y cambia cualquier columna que no sea
paid_at, notes o pdf_path  →  raise exception.
Si OLD.status = 'anulada'  →  no se admite ningún cambio.
```

Trigger equivalente en `invoice_lines`: prohibido insertar, modificar o borrar líneas de
una factura que no esté en `borrador`.

**Storage:** bucket privado `facturas`, ruta `<company_id>/<año>/<numero>.pdf`. Política
sobre `storage.objects`:

```sql
bucket_id = 'facturas'
and (storage.foldername(name))[1] = public.user_company_id()::text
```

La descarga **desde el panel** va por un route handler que valida la sesión y devuelve
una URL firmada de 60 segundos. Nunca se expone el bucket ni la `service_role` al
cliente.

El enlace que se manda al cliente por WhatsApp (decisión 14 revisada, ver 1.1) es la
excepción: se firma para 30 días, porque su destinatario no tiene sesión en el panel y
abre el mensaje cuando puede. Sigue siendo una URL firmada sobre el bucket privado, de
una sola factura y con caducidad.

---

## 4. Cálculo de horas

Código en `lib/billing/`. Fechas siempre en Europe/Madrid vía `lib/dates.ts`.

### 4.1 Emparejado de fichajes

Ventana de lectura: desde `madridDayStart(primer día del mes)` hasta
`madridNextDayStart(último día del mes) + 24 h`. El margen de 24 h existe para poder
cerrar una jornada nocturna que empieza el día 31 y termina el 1 del mes siguiente
(decisión 13).

Para cada operario, sus fichajes ordenados por `created_at` ascendente:

| Situación | Resultado |
|-----------|-----------|
| `entrada` sin jornada abierta | Se abre jornada |
| `entrada` con jornada ya abierta | La anterior queda huérfana → incidencia `entrada_sin_salida`; se abre la nueva |
| `salida` con jornada abierta | Se cierra jornada |
| `salida` sin jornada abierta | Incidencia `salida_sin_entrada` |
| Fin de la ventana con jornada abierta | Incidencia `entrada_sin_salida` |

Una jornada cerrada es **facturable** solo si cumple todo esto:

1. Los dos fichajes tienen `valid = true`.
2. Los dos tienen `center_id` no nulo **y el mismo**.
3. Duración > 0 minutos.
4. Duración ≤ 16 h.

Si falla algo, la jornada no se factura y genera la incidencia correspondiente.

`minutos = round((salida.created_at − entrada.created_at) / 60000)`.

**Mes de imputación:** `madridDateOf(entrada.created_at)`. La jornada del 31/03 22:00 →
01/04 06:00 se factura entera en marzo. Nunca se parte.

### 4.2 Incidencias

Se calculan al vuelo (no hay tabla): así se actualizan solas en cuanto un jefe corrige un
fichaje, sin necesidad de reprocesar nada.

| Código | Qué significa | Cómo se resuelve |
|--------|---------------|------------------|
| `entrada_sin_salida` | El operario no fichó la salida | Un jefe añade o corrige el fichaje |
| `salida_sin_entrada` | Salida suelta | Igual |
| `fichaje_no_valido` | `valid = false` (fuera de radio, duplicado…) | Revisar y validar o descartar |
| `sin_centro` | `center_id` nulo (centro borrado) | Reasignar el centro |
| `centro_distinto` | Entró en un centro y salió en otro | Corregir uno de los dos |
| `duracion_excesiva` | Jornada > 16 h | Corregir horas |
| `sin_tarifa` | No hay tarifa vigente para ese centro ese día | Dar de alta la tarifa |
| `faltan_datos_fiscales` | Falta NIF o dirección del cliente o de la empresa | Completar la ficha |

Cada incidencia se atribuye al cliente del centro implicado (mirando el centro de la
entrada y, si no hay, el de la salida). **Toda incidencia bloquea la emisión de la
factura de su cliente.**

Caso especial: si ninguno de los dos fichajes tiene centro, la incidencia no se puede
atribuir a ningún cliente. Va a una bandeja **"Sin asignar"** en la pantalla de cierre,
que bloquea el botón "Emitir todas" pero no la emisión individual de un cliente concreto.

### 4.3 Resolución de tarifa

Para una jornada en el centro `C` (del cliente `CL`) con fecha `D`:

1. Tarifa del centro: `billing_rates` con `center_id = C` y `valid_from <= D`, la de
   `valid_from` más alta.
2. Si no hay: tarifa base del cliente, `center_id is null` y `client_id = CL`, misma regla.
3. Si no hay: incidencia `sin_tarifa`.

Como el histórico se consulta por fecha, una factura antigua se puede reconstruir años
después con los mismos importes.

### 4.4 Agrupación y tramos

Las jornadas facturables se agrupan por `(center_id, tarifa aplicada)` y, dentro de cada
grupo, por tramo continuo de fechas. Un centro que cambió de 14 € a 15 € el día 15 produce:

```
Limpieza — Oficina Centro (01/03–14/03)   38,25 h × 14,00 €  =   535,50 €
Limpieza — Oficina Centro (15/03–31/03)   41,50 h × 15,00 €  =   622,50 €
```

Orden de las líneas: por nombre de centro, y dentro de cada centro por fecha de inicio.

### 4.5 Aritmética del dinero

Nada de decimales en coma flotante acumulados. Los cálculos se hacen con **enteros**:
minutos, centésimas de hora y céntimos.

```
minutosLinea        = suma de minutos de las jornadas del grupo   (entero)
horasCentesimas     = redondeoHalfUp(minutosLinea × 100 / 60)     (entero)
importeCentimos     = redondeoHalfUp(horasCentesimas × tarifaCentimos / 10000)
subtotalCentimos    = suma de importeCentimos de las líneas
ivaCentimos         = redondeoHalfUp(subtotalCentimos × vatRate / 100)
totalCentimos       = subtotalCentimos + ivaCentimos
totalHoras          = redondeoHalfUp(suma de minutos del periodo × 100 / 60) / 100
```

El importe de cada línea se calcula con las **horas ya redondeadas a 2 decimales**, no con
los minutos exactos: así el cliente puede coger la calculadora, multiplicar lo que ve
impreso y le cuadra al céntimo.

`redondeoHalfUp` opera sobre el valor absoluto y restaura el signo, porque las
rectificativas llevan importes negativos y `Math.round(-0.5)` en JavaScript devuelve `-0`.

`total_hours` de la cabecera se calcula desde los minutos totales del periodo, así que
puede diferir en 0,01 h de la suma de las horas de las líneas. Es correcto y esperado; el
PDF muestra las horas por línea, no una suma de horas.

---

## 5. Ciclo de vida de una factura

```
      cron día 1 / botón "Preparar mes"
                   │
                   ▼
              ┌──────────┐   recalcular (al abrir la pantalla o a mano)
              │ borrador │◄──────────────┐
              └────┬─────┘               │
                   │  Emitir (admin, sin incidencias)
                   ▼
              ┌──────────┐
              │ emitida  │──► marcar cobrada (paid_at)
              └────┬─────┘
                   │  Rectificar (admin)
                   ▼
        ┌────────────────────────┐
        │ rectificativa (emitida)│  serie R-2026, referencia a la original
        └────────────────────────┘
```

### 5.1 Borrador

- Sin número, sin PDF, sin valor legal.
- Se **recalcula por completo** (líneas borradas y reescritas) al crearlo, al abrir la
  pantalla de cierre y al pulsar "Recalcular". Siempre refleja los fichajes de ahora mismo.
- Se puede borrar. No consume número, así que borrarlo no deja huecos.

### 5.2 Emisión

Todo dentro de una transacción, con el cliente Supabase del usuario (respeta RLS, exige
`admin`):

1. Recalcular el periodo desde cero.
2. Verificar que **no hay ninguna incidencia** de ese cliente. Si la hay → error con la lista.
3. Verificar datos fiscales de empresa y cliente.
4. Verificar `total_hours > 0` (decisión 7: sin horas no hay factura).
5. Congelar en la cabecera: `client_name`, `client_tax_id`, `client_address`, `vat_rate`,
   `payment_method`, `payment_terms_days`, importes.
6. `issue_date = madridToday()`, `due_date = issue_date + payment_terms_days`.
7. Escribir `invoice_time_entries` con las jornadas incluidas.
8. `series = <año de issue_date>`, `number = next_invoice_number(company, series)`,
   `invoice_number = '<series>/<number con 4 dígitos>'`, `status = 'emitida'`.
9. Commit.
10. **Fuera de la transacción:** generar el PDF y guardar `pdf_path`. Si falla, la factura
    queda emitida y correcta con un aviso "PDF pendiente" y un botón para reintentar.

### 5.3 Rectificativas

Disparador: un fichaje incluido en una factura emitida se modifica después
(`time_entries.edited_at > invoices.issued_at`, cruzando por `invoice_time_entries`). El
panel muestra un aviso en la factura afectada y en el listado.

Al pulsar "Rectificar":

1. Se recalcula el periodo con los datos actuales.
2. Se crea una factura `kind = 'rectificativa'`, `rectifies_invoice_id` apuntando a la
   original, con líneas de **diferencia** (horas e importes, que pueden ser negativos)
   respecto a lo ya facturado en ese periodo, incluidas rectificativas anteriores.
3. Serie propia `R-<año>`, contador independiente: `R-2026/0001`.
4. Si la diferencia total es 0 € → no se emite nada y se avisa de que no hay diferencia.
5. La original **nunca** se modifica. Si la rectificativa anula el total, la original pasa
   a `anulada` (único camino a ese estado) y queda registrada como tal, sin reutilizar
   su número.

El PDF de una rectificativa indica "Factura rectificativa" y la factura y fecha que rectifica.

---

## 6. Generación automática

Route handler `app/api/cron/facturacion/route.ts`, mismo patrón que
[ausencias/route.ts](app/api/cron/ausencias/route.ts): comprueba `CRON_SECRET` en la
cabecera `authorization` y usa `createAdminClient()` (`service_role`, sin RLS) para
recorrer todas las companies.

```json
{ "path": "/api/cron/facturacion", "schedule": "0 5 1 * *" }
```

Vercel programa en UTC: `05:00 UTC` son las 06:00 en Madrid en invierno y las 07:00 en
verano. Para un proceso nocturno da igual; el periodo que factura se calcula siempre con
`lib/dates.ts`, no con la hora del cron.

Qué hace cada pasada, por cada company:

1. Periodo = mes natural anterior a `madridToday()`.
2. Por cada cliente con al menos una jornada facturable o alguna incidencia en el periodo:
   crear el borrador si no existe ya uno (idempotente gracias a
   `invoices_periodo_unico_idx`). Si ya existe un borrador, se recalcula. Si ya hay una
   factura **emitida** para ese cliente y periodo, no se toca nada.
3. Los clientes sin horas y sin incidencias no generan nada.
4. Log resumen: `[facturacion] Cierre de 2026-07: 12 borradores, 3 con incidencias, 2 sin actividad`.

Es idempotente: se puede reejecutar tantas veces como haga falta. Existe además un botón
**"Preparar mes"** en el panel que ejecuta exactamente la misma función para el mes que se
esté mirando, por si el cron falló o se quiere adelantar el cierre.

---

## 7. PDF

**Dependencia nueva aprobada: `pdf-lib` (^1.17.1)** — JavaScript puro, sin navegador
headless ni binarios nativos, funciona en el runtime Node de Vercel. Es la única
dependencia que añade este módulo.

- Fuentes estándar `Helvetica` / `Helvetica-Bold` con codificación WinAnsi, que cubre
  acentos, `ñ`, `º` y `€`. Hay un test específico para esto (sección 9).
- Tamaño A4 vertical. Formato español: fechas `dd/mm/aaaa`, decimales con coma, miles con
  punto, importes con `€` al final.

Contenido:

```
┌─────────────────────────────────────────────────────────┐
│ [logo]  RAZÓN SOCIAL              FACTURA  2026/0001    │
│         NIF · dirección           Fecha:      01/08/2026│
│         CP ciudad (provincia)     Vencimiento:31/08/2026│
├─────────────────────────────────────────────────────────┤
│ FACTURAR A                                              │
│ Cliente · NIF · dirección completa                      │
├─────────────────────────────────────────────────────────┤
│ Periodo facturado: julio de 2026                        │
├──────────────────────────────┬───────┬────────┬─────────┤
│ Concepto                     │ Horas │ €/hora │ Importe │
├──────────────────────────────┼───────┼────────┼─────────┤
│ Limpieza — Oficina Centro    │ 38,25 │  14,00 │  535,50 │
│   (01/07–14/07)              │       │        │         │
│ Limpieza — Oficina Centro    │ 41,50 │  15,00 │  622,50 │
│   (15/07–31/07)              │       │        │         │
│ Limpieza — Nave Norte        │ 22,00 │  13,50 │  297,00 │
├──────────────────────────────┴───────┴────────┼─────────┤
│                              Base imponible   │ 1.455,00│
│                              IVA 21 %         │   305,55│
│                              TOTAL            │ 1.760,55│
├─────────────────────────────────────────────────────────┤
│ Forma de pago: transferencia · 30 días                  │
│ IBAN: ESxx xxxx xxxx xxxx xxxx xxxx                     │
└─────────────────────────────────────────────────────────┘
```

- Paginación automática si las líneas no caben, con "Página X de Y" y repetición de
  cabecera de tabla.
- Se guarda en Storage al emitir y **no se regenera nunca** salvo que `pdf_path` esté
  vacío: el PDF que se descargó el cliente y el que hay archivado son el mismo archivo.

---

## 8. Panel

### `/dashboard/facturacion` — cierre del mes

- Selector de mes (por defecto, el mes anterior).
- Tres contadores arriba: **listas para emitir** · **con incidencias** · **sin actividad**.
- Tabla de clientes: cliente · horas · base · IVA · total · estado.
  - `Bloqueada` en rojo con el número de incidencias; al desplegar, cada incidencia con
    operario, fecha y enlace directo al fichaje en [fichajes](app/dashboard/fichajes).
  - `Lista` en verde con botón **Emitir** (solo `admin`).
  - `Emitida` con su número y enlace al PDF.
- Bandeja **"Sin asignar"** si hay incidencias sin cliente deducible.
- Botón **Emitir todas las listas** (solo `admin`), deshabilitado si hay bandeja sin asignar.
- Botón **Preparar mes** / **Recalcular**.

### `/dashboard/facturacion/[id]` — ficha de factura

Cabecera con datos congelados, líneas, desglose de impuestos, descarga del PDF, marcar
como cobrada, crear rectificativa, y el detalle de jornadas incluidas
(`invoice_time_entries`) para poder defender la factura ante el cliente.

### `/dashboard/facturas` — histórico

Listado por año con filtros (cliente, estado, cobrada/pendiente) y avisos de vencidas sin
cobrar y de facturas con fichajes modificados después de emitir.

### Cambios en pantallas existentes

- [clientes-view.tsx](app/dashboard/clientes/clientes-view.tsx): datos fiscales, IVA,
  condiciones de cobro, y la tarifa pasa a ser un **historial** (importe + "válida desde",
  con las anteriores visibles). Deja de escribir `clients.hourly_rate`.
- [centros](app/dashboard/centros): tarifa propia opcional, con texto "si se deja vacío se
  usa la tarifa del cliente" y su propio historial.
- Configuración de empresa: razón social, NIF, dirección, IBAN, logo.

Todos los textos en español (CLAUDE.md).

---

## 9. Tests (Vitest)

Lógica pura en `lib/billing/`, testeada sin base de datos con fichajes de mentira.

**Emparejado** (`lib/billing/__tests__/pairing.test.ts`)
- Entrada y salida normales → una jornada con los minutos correctos.
- Entrada sin salida → 0 jornadas + incidencia `entrada_sin_salida`.
- Salida sin entrada → incidencia `salida_sin_entrada`.
- Dos entradas seguidas → la primera huérfana, la segunda se cierra bien.
- Entrada 31/03 22:00 → salida 01/04 06:00: 8 h imputadas a **marzo**, y no vuelven a
  aparecer al calcular abril.
- Jornada de 20 h → `duracion_excesiva`.
- Entrada en centro A y salida en centro B → `centro_distinto`.
- Fichaje con `valid = false` → `fichaje_no_valido`, no suma horas.
- Jornada que cruza el cambio de hora de octubre (día de 25 h) → los minutos reales son
  los que marca el reloj, no los de la hora local.

**Tarifas** (`rates.test.ts`)
- El centro gana a la base del cliente.
- Sin tarifa de centro se hereda la del cliente.
- Cambio a mitad de mes → dos tramos con las fechas y horas correctas.
- Una tarifa con `valid_from` futura no se aplica a días anteriores.
- Sin ninguna tarifa vigente → `sin_tarifa`.

**Importes** (`amounts.test.ts`)
- 38 h 15 min → 38,25 h → × 14,00 € = 535,50 €.
- Minutos que no caen redondos (por ejemplo 2.497 min) → las horas de la línea multiplicadas
  por la tarifa cuadran con el importe impreso.
- IVA 0 % en cliente exento.
- Importes negativos de una rectificativa redondean bien (comprobar el caso `-0,005`).
- Ninguna operación usa suma de decimales en coma flotante.

**Numeración** (test de integración contra Supabase local)
- Dos emisiones concurrentes → números distintos y consecutivos.
- Borrar un borrador no consume número.
- El 1 de enero la serie reinicia en 0001.
- Las rectificativas usan su propio contador `R-<año>`.

**PDF** (`pdf.test.ts`)
- Se genera un PDF no vacío con "Facturación Ñoño S.L., 1.455,00 €, 21 %" sin lanzar
  excepción de codificación.
- Una factura de 60 líneas genera más de una página.

Ejecutar solo el test afectado, no toda la suite (CLAUDE.md).

---

## 10. Plan de implementación

| Fase | Contenido | Entregable comprobable |
|------|-----------|------------------------|
| 1 | Migración de datos fiscales + `billing_rates` + copia de `hourly_rate`. UI de tarifas con historial y de datos fiscales. | Se pueden configurar tarifas con fecha de efecto |
| 2 | `lib/billing/`: emparejado, incidencias, tarifas, importes. Tests. | Cálculo correcto verificado con tests |
| 3 | Migración de `invoices`, `invoice_lines`, `invoice_time_entries`, `invoice_counters`, RLS y triggers. Pantalla de cierre con borradores y emisión. | Emitir una factura real con número |
| 4 | PDF con pdf-lib + Storage + descarga firmada. | Descargar el PDF |
| 5 | Cron día 1 + botón "Preparar mes". | Borradores solos el día 1 |
| 6 | Rectificativas, detección de fichajes modificados, marcar cobrada, histórico. | Ciclo completo |
| 7 | Limpieza: eliminar `clients.hourly_rate`. | — |

`npm run typecheck` al terminar cada fase.

---

## 11. Fuera de alcance (por ahora)

- Envío automático por **email**. El WhatsApp al emitir sí está hecho (decisión 14
  revisada, ver 1.1); el campo de email del cliente y el proveedor de correo quedan para
  más adelante.
- Desactivar el aviso de WhatsApp por company o por cliente: hoy se envía siempre.
- Abonos parciales, pagos a cuenta, conciliación bancaria: solo hay `paid_at` (cobrada
  sí/no).
- Recargo de equivalencia, IRPF, operaciones intracomunitarias, multi-divisa.
- Presupuestos y contratos.
- Exportación contable (CSV/Facturae) para la gestoría.

## 12. Riesgo a confirmar con tu gestoría

España tiene en marcha el reglamento antifraude (**Verifactu**), que obliga a que los
programas de facturación cumplan requisitos concretos: registro de facturación encadenado,
huella, código QR en la factura y, en su caso, envío a la AEAT. **Este diseño no lo
implementa.** El calendario de obligación depende del tipo de empresa y ha sufrido varias
prórrogas, así que conviene preguntar a tu gestoría desde cuándo te afecta antes de usar
estas facturas como las oficiales de la empresa.

La buena noticia: el diseño ya guarda lo más difícil de añadir después (numeración
correlativa sin huecos, inmutabilidad de lo emitido, rectificativas con referencia y
trazabilidad completa hasta el fichaje). Encadenar los registros y añadir el QR sería una
fase adicional, no rehacer el módulo.
