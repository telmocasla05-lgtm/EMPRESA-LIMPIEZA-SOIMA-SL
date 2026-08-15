import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepararCierreMes, resumenCierre } from "@/lib/billing/cierre";
import { madridInstant } from "@/lib/dates";
import { GET } from "@/app/api/cron/facturacion/route";

// El cierre mensual se prueba contra un Supabase en memoria, no contra dobles
// de generarBorrador: así el test ejercita el generador de verdad (incluida su
// idempotencia) y lo único fingido es el almacenamiento. La numeración y las
// restricciones de Postgres siguen cubiertas por billing-factura.test.ts, que
// va contra el proyecto real.

const JULIO = { periodStart: "2026-07-01", periodEnd: "2026-07-31" };
const CRON_SECRET = "secreto-de-test";
// 15 de agosto de 2026: el mes anterior de Madrid es julio.
const QUINCE_DE_AGOSTO = new Date("2026-08-15T10:00:00Z");

type Fila = Record<string, unknown>;
type Almacen = Record<string, Fila[]>;

// Fallo inyectado: simula un error de base de datos (una restricción violada,
// una caída) en una sola fila, para comprobar que no arrastra a las demás.
type Rotura = {
  tabla: string;
  cuando: (valores: Fila) => boolean;
  mensaje: string;
};

// Valores por defecto que pone Postgres al insertar (migración de
// facturación). Sin ellos, un borrador recién creado no se reconocería a sí
// mismo en la pasada siguiente y el cierre lo duplicaría.
const DEFECTOS: Record<string, Fila> = {
  invoices: { kind: "ordinaria", status: "borrador" },
};

function comparable(valor: unknown): number | string {
  const texto = String(valor);
  const instante = Date.parse(texto);
  return Number.isNaN(instante) ? texto : instante;
}

// Constructor de consultas encadenables al estilo de postgrest-js: filtra
// sobre las filas del almacén y se puede esperar con await en cualquier punto.
class Consulta {
  constructor(private filas: Fila[]) {}

  eq(columna: string, valor: unknown) {
    this.filas = this.filas.filter((fila) => fila[columna] === valor);
    return this;
  }

  neq(columna: string, valor: unknown) {
    this.filas = this.filas.filter((fila) => fila[columna] !== valor);
    return this;
  }

  gte(columna: string, valor: unknown) {
    this.filas = this.filas.filter(
      (fila) => comparable(fila[columna]) >= comparable(valor),
    );
    return this;
  }

  lte(columna: string, valor: unknown) {
    this.filas = this.filas.filter(
      (fila) => comparable(fila[columna]) <= comparable(valor),
    );
    return this;
  }

  order(columna: string) {
    this.filas = [...this.filas].sort((a, b) =>
      String(a[columna]).localeCompare(String(b[columna])),
    );
    return this;
  }

  single() {
    if (this.filas.length !== 1) {
      return Promise.resolve({
        data: null,
        error: { message: `Se esperaba 1 fila y hay ${this.filas.length}` },
      });
    }
    return Promise.resolve({ data: this.filas[0], error: null });
  }

  then(resolver: (resultado: { data: Fila[]; error: null }) => unknown) {
    return Promise.resolve(resolver({ data: this.filas, error: null }));
  }
}

function crearSupabaseFalso(almacen: Almacen, roturas: Rotura[] = []) {
  let contador = 0;

  return {
    from(tabla: string) {
      const filas = (almacen[tabla] ??= []);

      return {
        select: () => new Consulta([...filas]),

        insert: (valores: Fila | Fila[]) => {
          const entrantes = Array.isArray(valores) ? valores : [valores];
          const rota = roturas.find(
            (rotura) =>
              rotura.tabla === tabla && entrantes.some((fila) => rotura.cuando(fila)),
          );
          const nuevas = entrantes.map((fila) => ({
            id: `${tabla}-${(contador += 1)}`,
            ...DEFECTOS[tabla],
            ...fila,
          }));
          const ejecutar = () => {
            if (rota) return { data: null, error: { message: rota.mensaje } };
            filas.push(...nuevas);
            return { data: nuevas, error: null };
          };

          return {
            select: () => ({
              single: () => {
                const resultado = ejecutar();
                return Promise.resolve(
                  resultado.error
                    ? { data: null, error: resultado.error }
                    : { data: resultado.data![0], error: null },
                );
              },
            }),
            then: (resolver: (resultado: unknown) => unknown) =>
              Promise.resolve(resolver(ejecutar())),
          };
        },

        update: (valores: Fila) => ({
          eq: (columna: string, valor: unknown) => {
            for (const fila of filas) {
              if (fila[columna] === valor) Object.assign(fila, valores);
            }
            return Promise.resolve({ error: null });
          },
        }),

        delete: () => ({
          eq: (columna: string, valor: unknown) => {
            almacen[tabla] = filas.filter((fila) => fila[columna] !== valor);
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
  };
}

let almacen: Almacen;
let contadorOperarios = 0;

const estado = vi.hoisted(() => ({ supabase: null as unknown }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => estado.supabase,
}));

function supabase() {
  return estado.supabase as never;
}

// Cliente completo: ficha fiscal, su centro y su propio operario (el
// emparejado mira la secuencia de fichajes de cada persona, así que compartir
// operario entre clientes inventaría incidencias de "centro distinto").
function crearCliente(
  companyId: string,
  nombre: string,
  hourlyRate = 14,
): { clientId: string; centerId: string; workerId: string } {
  const clientId = `cliente-${nombre}`;
  const centerId = `centro-${nombre}`;
  contadorOperarios += 1;

  (almacen.clients ??= []).push({
    id: clientId,
    company_id: companyId,
    name: nombre,
    hourly_rate: hourlyRate,
    vat_rate: 21,
    tax_id: "B12345678",
    address: "Calle Mayor 1",
    postal_code: "28001",
    city: "Madrid",
    province: "Madrid",
    payment_method: "transferencia",
    payment_terms_days: 30,
  });

  (almacen.centers ??= []).push({
    id: centerId,
    company_id: companyId,
    client_id: clientId,
    name: `Centro de ${nombre}`,
  });

  return { clientId, centerId, workerId: `operario-${contadorOperarios}` };
}

function ficharJornada(
  companyId: string,
  centro: { centerId: string; workerId: string },
  fecha: string,
  desde: string,
  hasta: string,
  extra: { valid?: boolean } = {},
) {
  const entries = (almacen.time_entries ??= []);
  for (const [tipo, hora] of [
    ["entrada", desde],
    ["salida", hasta],
  ] as const) {
    entries.push({
      id: `fichaje-${entries.length + 1}`,
      company_id: companyId,
      worker_id: centro.workerId,
      center_id: centro.centerId,
      type: tipo,
      valid: extra.valid ?? true,
      created_at: madridInstant(fecha, hora).toISOString(),
    });
  }
}

function facturas(clientId: string): Fila[] {
  return (almacen.invoices ?? []).filter((f) => f.client_id === clientId);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(QUINCE_DE_AGOSTO);
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  almacen = { clients: [], centers: [], time_entries: [], invoices: [], invoice_lines: [] };
  contadorOperarios = 0;
  estado.supabase = crearSupabaseFalso(almacen);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("prepararCierreMes", () => {
  it("genera un borrador por cada cliente con actividad de todas las companies", async () => {
    const uno = crearCliente("company-a", "Ana", 14);
    const dos = crearCliente("company-a", "Berta", 10);
    const tres = crearCliente("company-b", "Carlos", 20);
    crearCliente("company-b", "Sin actividad", 12);

    ficharJornada("company-a", uno, "2026-07-06", "08:00", "16:00");
    ficharJornada("company-a", uno, "2026-07-07", "08:00", "16:00");
    ficharJornada("company-a", dos, "2026-07-06", "08:00", "12:00");
    ficharJornada("company-b", tres, "2026-07-10", "09:00", "14:00");

    const resultado = await prepararCierreMes({ supabase: supabase(), ...JULIO });

    expect(resultado).toMatchObject({
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      companies: 2,
      clientes: 4,
      borradores: 3,
      conIncidencias: 0,
      sinActividad: 1,
      yaEmitidas: 0,
      fallidos: [],
    });

    // Un borrador por cliente con horas, con sus importes y su línea.
    expect(almacen.invoices).toHaveLength(3);
    expect(almacen.invoice_lines).toHaveLength(3);

    const [factura] = facturas(uno.clientId);
    expect(factura.period_start).toBe("2026-07-01");
    expect(factura.period_end).toBe("2026-07-31");
    expect(factura.total_hours).toBe(16);
    expect(factura.subtotal).toBe(224); // 16 h × 14 €
    expect(facturas(dos.clientId)[0].subtotal).toBe(40); // 4 h × 10 €
    expect(facturas(tres.clientId)[0].subtotal).toBe(100); // 5 h × 20 €

    // El cliente sin fichajes no genera factura (decisión 7).
    expect(facturas("cliente-Sin actividad")).toEqual([]);
  });

  it("cuenta aparte los clientes con incidencias, que quedan bloqueados", async () => {
    const cliente = crearCliente("company-a", "Bloqueada");
    ficharJornada("company-a", cliente, "2026-07-06", "08:00", "16:00");
    // Sin salida: incidencia entrada_sin_salida.
    (almacen.time_entries ??= []).push({
      id: "fichaje-huerfano",
      company_id: "company-a",
      worker_id: cliente.workerId,
      center_id: cliente.centerId,
      type: "entrada",
      valid: true,
      created_at: madridInstant("2026-07-08", "08:00").toISOString(),
    });

    const resultado = await prepararCierreMes({ supabase: supabase(), ...JULIO });

    expect(resultado.borradores).toBe(1);
    expect(resultado.conIncidencias).toBe(1);
    expect(facturas(cliente.clientId)[0].total_hours).toBe(8);
  });

  it("reejecutarlo no duplica las facturas ya generadas", async () => {
    const cliente = crearCliente("company-a", "Repetida");
    ficharJornada("company-a", cliente, "2026-07-06", "08:00", "16:00");

    const primera = await prepararCierreMes({ supabase: supabase(), ...JULIO });
    expect(primera.borradores).toBe(1);
    const idOriginal = facturas(cliente.clientId)[0].id;

    // Mientras tanto aparece una jornada más y el cron vuelve a pasar.
    ficharJornada("company-a", cliente, "2026-07-07", "08:00", "12:00");
    const segunda = await prepararCierreMes({ supabase: supabase(), ...JULIO });

    expect(segunda.borradores).toBe(1);
    expect(facturas(cliente.clientId)).toHaveLength(1);
    // La misma factura, recalculada: no una nueva.
    expect(facturas(cliente.clientId)[0].id).toBe(idOriginal);
    expect(facturas(cliente.clientId)[0].total_hours).toBe(12);
    // Y las líneas se reescriben, no se acumulan.
    expect(almacen.invoice_lines).toHaveLength(1);
  });

  it("no toca la factura de un cliente que ya está emitida", async () => {
    const cliente = crearCliente("company-a", "Emitida");
    ficharJornada("company-a", cliente, "2026-07-06", "08:00", "16:00");
    almacen.invoices.push({
      id: "factura-emitida",
      company_id: "company-a",
      client_id: cliente.clientId,
      period_start: "2026-07-01",
      period_end: "2026-07-31",
      kind: "ordinaria",
      status: "emitida",
      invoice_number: "2026/0001",
      total_hours: 8,
      subtotal: 112,
    });

    const resultado = await prepararCierreMes({ supabase: supabase(), ...JULIO });

    expect(resultado.yaEmitidas).toBe(1);
    expect(resultado.borradores).toBe(0);
    expect(facturas(cliente.clientId)).toHaveLength(1);
    // Intacta: ni importes recalculados ni líneas nuevas.
    expect(facturas(cliente.clientId)[0]).toMatchObject({
      status: "emitida",
      invoice_number: "2026/0001",
      total_hours: 8,
    });
    expect(almacen.invoice_lines).toEqual([]);
  });

  it("un cliente que falla se registra en el log y no bloquea a los demás", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const primero = crearCliente("company-a", "Antes");
    const roto = crearCliente("company-a", "Roto");
    const ultimo = crearCliente("company-b", "Despues");
    ficharJornada("company-a", primero, "2026-07-06", "08:00", "16:00");
    ficharJornada("company-a", roto, "2026-07-06", "08:00", "16:00");
    ficharJornada("company-b", ultimo, "2026-07-06", "08:00", "16:00");

    // La factura de "Roto" revienta al escribirse (una restricción violada, la
    // base caída…). Los otros dos clientes no tienen por qué enterarse.
    estado.supabase = crearSupabaseFalso(almacen, [
      {
        tabla: "invoices",
        cuando: (fila) => fila.client_id === roto.clientId,
        mensaje: "duplicate key value violates unique constraint",
      },
    ]);

    const resultado = await prepararCierreMes({ supabase: supabase(), ...JULIO });

    // Los demás se han generado, incluido el que iba después del fallo.
    expect(resultado.borradores).toBe(2);
    expect(facturas(primero.clientId)).toHaveLength(1);
    expect(facturas(ultimo.clientId)).toHaveLength(1);
    expect(facturas(roto.clientId)).toEqual([]);

    // Y el fallo queda registrado con el cliente concreto y su company.
    expect(resultado.fallidos).toEqual([
      {
        companyId: "company-a",
        clientId: roto.clientId,
        clientName: "Roto",
        error: "duplicate key value violates unique constraint",
      },
    ]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain("[facturacion]");
    expect(error.mock.calls[0][0]).toContain(roto.clientId);

    expect(resumenCierre(resultado)).toBe(
      "[facturacion] Cierre de 2026-07: 2 borradores, 0 con incidencias, 0 sin actividad, 0 ya emitidas, 1 con error",
    );
  });

  it("con companyId cierra solo esa company", async () => {
    const propio = crearCliente("company-a", "Propio");
    const ajeno = crearCliente("company-b", "Ajeno");
    ficharJornada("company-a", propio, "2026-07-06", "08:00", "16:00");
    ficharJornada("company-b", ajeno, "2026-07-06", "08:00", "16:00");

    const resultado = await prepararCierreMes({
      supabase: supabase(),
      companyId: "company-a",
      ...JULIO,
    });

    expect(resultado).toMatchObject({ companies: 1, clientes: 1, borradores: 1 });
    expect(facturas(ajeno.clientId)).toEqual([]);
  });
});

describe("GET /api/cron/facturacion", () => {
  it("rechaza llamadas sin el secreto", async () => {
    const cliente = crearCliente("company-a", "Ana");
    ficharJornada("company-a", cliente, "2026-07-06", "08:00", "16:00");

    const response = await GET(new Request("http://localhost/api/cron/facturacion"));

    expect(response.status).toBe(401);
    expect(almacen.invoices).toEqual([]);
  });

  it("rechaza llamadas con un secreto incorrecto", async () => {
    const response = await GET(
      new Request("http://localhost/api/cron/facturacion", {
        headers: { authorization: "Bearer otro" },
      }),
    );

    expect(response.status).toBe(401);
  });

  it("el día 1 cierra el mes anterior de Madrid", async () => {
    // El cron corre el 1 de septiembre a las 05:00 UTC (06:00/07:00 Madrid):
    // el periodo es agosto entero, aunque el reloj del servidor esté en UTC.
    vi.setSystemTime(new Date("2026-09-01T05:00:00Z"));
    const cliente = crearCliente("company-a", "Ana");
    ficharJornada("company-a", cliente, "2026-08-10", "08:00", "16:00");
    // Julio no entra: es de otro periodo.
    ficharJornada("company-a", cliente, "2026-07-10", "08:00", "16:00");

    const response = await GET(
      new Request("http://localhost/api/cron/facturacion", {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      borradores: 1,
    });
    expect(facturas(cliente.clientId)[0].total_hours).toBe(8);
  });

  it("con ?periodo=AAAA-MM recupera un mes concreto", async () => {
    const cliente = crearCliente("company-a", "Ana");
    ficharJornada("company-a", cliente, "2026-02-10", "08:00", "16:00");

    const response = await GET(
      new Request("http://localhost/api/cron/facturacion?periodo=2026-02", {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
    );

    // Febrero de 2026 tiene 28 días.
    expect(await response.json()).toMatchObject({
      periodStart: "2026-02-01",
      periodEnd: "2026-02-28",
      borradores: 1,
    });
  });

  it("rechaza un periodo con formato inválido", async () => {
    const response = await GET(
      new Request("http://localhost/api/cron/facturacion?periodo=julio", {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
    );

    expect(response.status).toBe(400);
    expect(almacen.invoices).toEqual([]);
  });
});
