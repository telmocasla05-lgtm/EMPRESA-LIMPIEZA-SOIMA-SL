import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BUCKET_FACTURAS,
  emitirFactura,
  generarBorrador,
  urlFirmadaFactura,
} from "@/lib/billing/factura";
import { madridInstant } from "@/lib/dates";

// Test de integración contra el proyecto real de Supabase: la numeración
// correlativa y el bloqueo de emisiones simultáneas dependen del comportamiento
// de Postgres, así que no se pueden comprobar con dobles.

try {
  process.loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)));
} catch {
  // Sin .env.local: las variables pueden venir del entorno.
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  throw new Error(
    "Test de facturación sin configurar: rellena NEXT_PUBLIC_SUPABASE_URL y " +
      "SUPABASE_SERVICE_ROLE_KEY en .env.local y aplica las migraciones.",
  );
}

const admin: SupabaseClient = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const suffix = randomUUID().slice(0, 8);
const JULIO = { periodStart: "2026-07-01", periodEnd: "2026-07-31" };

let companyId: string;
let contadorOperarios = 0;
const rutasSubidas: string[] = [];

function must<T>(result: { data: T; error: { message: string } | null }): NonNullable<T> {
  if (result.error) throw new Error(result.error.message);
  if (result.data === null || result.data === undefined) {
    throw new Error("Respuesta sin datos");
  }
  return result.data as NonNullable<T>;
}

// Crea un cliente con su centro, sus datos fiscales y su PROPIO operario.
//
// El operario tiene que ser distinto en cada cliente: el emparejado mira la
// secuencia completa de fichajes de cada persona, así que reutilizar uno solo
// haría que pareciera estar fichando a la vez en centros de clientes distintos
// —una incidencia real, pero un artefacto del test.
async function crearCliente(nombre: string, hourlyRate: number, vatRate = 21) {
  const cliente = must(
    await admin
      .from("clients")
      .insert({
        company_id: companyId,
        name: nombre,
        hourly_rate: hourlyRate,
        vat_rate: vatRate,
        tax_id: `A${Math.floor(Math.random() * 90000000) + 10000000}`,
        address: "Avenida de la Paz 20",
        postal_code: "08001",
        city: "Barcelona",
        province: "Barcelona",
        payment_terms_days: 30,
        payment_method: "transferencia",
      })
      .select("id")
      .single(),
  );

  const centro = must(
    await admin
      .from("centers")
      .insert({
        company_id: companyId,
        client_id: cliente.id,
        name: `Centro de ${nombre}`,
      })
      .select("id")
      .single(),
  );

  contadorOperarios += 1;
  const operario = must(
    await admin
      .from("workers")
      .insert({
        company_id: companyId,
        full_name: `Operario de ${nombre}`,
        phone: `+34600${suffix}${contadorOperarios}`,
      })
      .select("id")
      .single(),
  );

  return {
    clientId: cliente.id as string,
    centerId: centro.id as string,
    workerId: operario.id as string,
  };
}

// Ficha una jornada completa en un centro.
async function ficharJornada(
  centerId: string,
  workerId: string,
  fecha: string,
  desde: string,
  hasta: string,
  extra: { valid?: boolean } = {},
) {
  must(
    await admin
      .from("time_entries")
      .insert([
        {
          company_id: companyId,
          worker_id: workerId,
          center_id: centerId,
          type: "entrada",
          valid: extra.valid ?? true,
          created_at: madridInstant(fecha, desde).toISOString(),
        },
        {
          company_id: companyId,
          worker_id: workerId,
          center_id: centerId,
          type: "salida",
          valid: extra.valid ?? true,
          created_at: madridInstant(fecha, hasta).toISOString(),
        },
      ])
      .select("id"),
  );
}

describe("generación y emisión de facturas", () => {
  beforeAll(async () => {
    const company = must(
      await admin
        .from("companies")
        .insert({
          name: `Facturación Ñoño ${suffix} S.L.`,
          tax_id: "B12345678",
          address: "Calle Mayor 1",
          postal_code: "28001",
          city: "Madrid",
          province: "Madrid",
          iban: "ES91 2100 0418 4502 0005 1332",
        })
        .select("id")
        .single(),
    );
    companyId = company.id;
  }, 60_000);

  afterAll(async () => {
    if (rutasSubidas.length > 0) {
      await admin.storage.from(BUCKET_FACTURAS).remove(rutasSubidas);
    }
    if (companyId) await admin.from("companies").delete().eq("id", companyId);
  }, 60_000);

  it("crea el borrador con su desglose por centro", { timeout: 30_000 }, async () => {
    const { clientId, centerId, workerId } = await crearCliente(`Normal ${suffix}`, 14);
    // 38 h 15 min en total: 3 jornadas de 8 h + una de 14 h 15 min.
    await ficharJornada(centerId, workerId, "2026-07-06", "08:00", "16:00");
    await ficharJornada(centerId, workerId, "2026-07-07", "08:00", "16:00");
    await ficharJornada(centerId, workerId, "2026-07-08", "08:00", "16:00");
    await ficharJornada(centerId, workerId, "2026-07-09", "06:00", "20:15");

    const resultado = await generarBorrador({
      supabase: admin,
      clientId,
      ...JULIO,
    });

    expect(resultado.creada).toBe(true);
    if (!resultado.creada) return;

    const factura = must(
      await admin
        .from("invoices")
        .select("*")
        .eq("id", resultado.invoiceId)
        .single(),
    );

    // Borrador: sin número, sin PDF, sin valor legal (SPEC 5.1).
    expect(factura.status).toBe("borrador");
    expect(factura.invoice_number).toBeNull();
    expect(factura.number).toBeNull();
    expect(factura.pdf_path).toBeNull();

    expect(Number(factura.total_hours)).toBe(38.25);
    expect(Number(factura.subtotal)).toBe(535.5);
    expect(Number(factura.vat_amount)).toBe(112.46);
    expect(Number(factura.total)).toBe(647.96);

    const lineas = must(
      await admin
        .from("invoice_lines")
        .select("*")
        .eq("invoice_id", resultado.invoiceId),
    );
    expect(lineas).toHaveLength(1);
    expect(Number(lineas[0].hours)).toBe(38.25);
    expect(Number(lineas[0].hourly_rate)).toBe(14);
    expect(Number(lineas[0].amount)).toBe(535.5);
  });

  it("recalcular el borrador no lo duplica", { timeout: 30_000 }, async () => {
    const { clientId, centerId, workerId } = await crearCliente(`Recalculo ${suffix}`, 10);
    await ficharJornada(centerId, workerId, "2026-07-06", "08:00", "16:00");

    const primera = await generarBorrador({ supabase: admin, clientId, ...JULIO });
    expect(primera.creada).toBe(true);

    // Aparece una jornada más y se vuelve a preparar el mes.
    await ficharJornada(centerId, workerId, "2026-07-07", "08:00", "12:00");
    const segunda = await generarBorrador({ supabase: admin, clientId, ...JULIO });

    expect(segunda.creada).toBe(true);
    if (!primera.creada || !segunda.creada) return;
    expect(segunda.invoiceId).toBe(primera.invoiceId);

    const facturas = must(
      await admin.from("invoices").select("id").eq("client_id", clientId),
    );
    expect(facturas).toHaveLength(1);

    // Las líneas se reescriben enteras, no se acumulan.
    const lineas = must(
      await admin
        .from("invoice_lines")
        .select("hours")
        .eq("invoice_id", segunda.invoiceId),
    );
    expect(lineas).toHaveLength(1);
    expect(Number(lineas[0].hours)).toBe(12);
  });

  it("un cliente sin horas no genera factura", { timeout: 30_000 }, async () => {
    const { clientId } = await crearCliente(`Sin horas ${suffix}`, 14);

    const resultado = await generarBorrador({ supabase: admin, clientId, ...JULIO });

    expect(resultado).toEqual({ creada: false, motivo: "sin_actividad" });

    const facturas = must(
      await admin.from("invoices").select("id").eq("client_id", clientId),
    );
    expect(facturas).toEqual([]);
  });

  it("los fichajes no válidos no dan horas y bloquean la emisión", {
    timeout: 30_000,
  }, async () => {
    const { clientId, centerId, workerId } = await crearCliente(`Bloqueado ${suffix}`, 14);
    await ficharJornada(centerId, workerId, "2026-07-06", "08:00", "16:00");
    await ficharJornada(centerId, workerId, "2026-07-07", "08:00", "16:00", { valid: false });

    const resultado = await generarBorrador({ supabase: admin, clientId, ...JULIO });
    expect(resultado.creada).toBe(true);
    if (!resultado.creada) return;

    // Solo la jornada válida.
    expect(resultado.totalHours).toBe(8);
    expect(resultado.incidencias).toHaveLength(1);
    expect(resultado.incidencias[0].codigo).toBe("fichaje_no_valido");

    await expect(
      emitirFactura({ supabase: admin, invoiceId: resultado.invoiceId }),
    ).rejects.toThrow(/incidencia/i);

    // Sigue siendo borrador y sin número.
    const factura = must(
      await admin
        .from("invoices")
        .select("status, invoice_number")
        .eq("id", resultado.invoiceId)
        .single(),
    );
    expect(factura.status).toBe("borrador");
    expect(factura.invoice_number).toBeNull();
  });

  it("emite con número, trazabilidad y PDF en Storage", {
    timeout: 60_000,
  }, async () => {
    const { clientId, centerId, workerId } = await crearCliente(`Emisión ${suffix}`, 14);
    await ficharJornada(centerId, workerId, "2026-07-06", "08:00", "16:00");
    await ficharJornada(centerId, workerId, "2026-07-07", "08:00", "16:00");

    const borrador = await generarBorrador({ supabase: admin, clientId, ...JULIO });
    expect(borrador.creada).toBe(true);
    if (!borrador.creada) return;

    const emision = await emitirFactura({
      supabase: admin,
      invoiceId: borrador.invoiceId,
      issueDate: "2026-08-01",
    });
    if (emision.pdfPath) rutasSubidas.push(emision.pdfPath);

    expect(emision.pdfError).toBeUndefined();
    expect(emision.series).toBe("2026");
    expect(emision.invoiceNumber).toMatch(/^2026\/\d{4}$/);
    expect(emision.pdfPath).toBe(
      `${companyId}/2026/${emision.invoiceNumber.replace("/", "-")}.pdf`,
    );

    const factura = must(
      await admin
        .from("invoices")
        .select("*")
        .eq("id", borrador.invoiceId)
        .single(),
    );
    expect(factura.status).toBe("emitida");
    expect(factura.issue_date).toBe("2026-08-01");
    expect(factura.due_date).toBe("2026-08-31"); // 30 días
    expect(factura.pdf_path).toBe(emision.pdfPath);
    expect(Number(factura.total_hours)).toBe(16);
    expect(Number(factura.subtotal)).toBe(224);

    // Trazabilidad hasta el fichaje.
    const jornadas = must(
      await admin
        .from("invoice_time_entries")
        .select("work_date, minutes")
        .eq("invoice_id", borrador.invoiceId),
    );
    expect(jornadas).toHaveLength(2);
    expect(jornadas.every((j: { minutes: number }) => j.minutes === 480)).toBe(true);

    // El PDF está de verdad en Storage y es un PDF con los datos correctos.
    const descarga = await admin.storage
      .from(BUCKET_FACTURAS)
      .download(emision.pdfPath!);
    if (descarga.error) throw new Error(descarga.error.message);

    const bytes = new Uint8Array(await descarga.data.arrayBuffer());
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");

    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getTitle()).toContain(emision.invoiceNumber);

    // Y el bucket es privado: la descarga va por URL firmada.
    const firmada = await urlFirmadaFactura(admin, emision.pdfPath!);
    expect(firmada).toContain("token=");
  });

  it("no se puede emitir dos veces la misma factura", {
    timeout: 60_000,
  }, async () => {
    const { clientId, centerId, workerId } = await crearCliente(`Doble ${suffix}`, 12);
    await ficharJornada(centerId, workerId, "2026-07-10", "08:00", "16:00");

    const borrador = await generarBorrador({ supabase: admin, clientId, ...JULIO });
    if (!borrador.creada) throw new Error("no se creó el borrador");

    const primera = await emitirFactura({
      supabase: admin,
      invoiceId: borrador.invoiceId,
      issueDate: "2026-08-01",
    });
    if (primera.pdfPath) rutasSubidas.push(primera.pdfPath);

    await expect(
      emitirFactura({ supabase: admin, invoiceId: borrador.invoiceId }),
    ).rejects.toThrow(/borrador/i);
  });

  it("da números distintos y consecutivos aunque se emita a la vez", {
    timeout: 120_000,
  }, async () => {
    const cuantas = 8;

    // Ocho clientes, cada uno con su borrador listo.
    const borradores: string[] = [];
    for (let i = 0; i < cuantas; i += 1) {
      const { clientId, centerId, workerId } = await crearCliente(
        `Concurrente ${i} ${suffix}`,
        10,
      );
      await ficharJornada(centerId, workerId, "2026-07-15", "08:00", "16:00");
      const borrador = await generarBorrador({ supabase: admin, clientId, ...JULIO });
      if (!borrador.creada) throw new Error("no se creó el borrador");
      borradores.push(borrador.invoiceId);
    }

    // Todas a la vez: es aquí donde dos emisiones podrían pillar el mismo
    // número si next_invoice_number no bloqueara la fila del contador.
    const emisiones = await Promise.all(
      borradores.map((invoiceId) =>
        emitirFactura({ supabase: admin, invoiceId, issueDate: "2026-08-01" }),
      ),
    );
    for (const emision of emisiones) {
      if (emision.pdfPath) rutasSubidas.push(emision.pdfPath);
    }

    const numeros = emisiones.map((e) => e.number).sort((a, b) => a - b);

    // Ni un duplicado.
    expect(new Set(numeros).size).toBe(cuantas);
    // Y correlativos, sin huecos.
    for (let i = 1; i < numeros.length; i += 1) {
      expect(numeros[i]).toBe(numeros[i - 1] + 1);
    }

    // El número formateado cuadra con la serie.
    for (const emision of emisiones) {
      expect(emision.invoiceNumber).toBe(
        `2026/${String(emision.number).padStart(4, "0")}`,
      );
    }

    // El contador de la company refleja el último número entregado.
    const contador = must(
      await admin
        .from("invoice_counters")
        .select("last_number")
        .eq("company_id", companyId)
        .eq("series", "2026")
        .single(),
    );
    expect(contador.last_number).toBe(Math.max(...numeros));
  });

  it("el contador aguanta 20 peticiones simultáneas de número", {
    timeout: 60_000,
  }, async () => {
    const serie = `TEST-${suffix}`;
    const cuantas = 20;

    // Contraprueba: 20 lecturas simultáneas del contador (lo que haría una
    // implementación ingenua del tipo "leer el último y sumar uno") ven todas
    // el mismo valor. Es la prueba de que estas llamadas SÍ se solapan de
    // verdad y de que sin bloqueo habría números repetidos.
    const ingenuo = await Promise.all(
      Array.from({ length: cuantas }, async () => {
        const { data } = await admin
          .from("invoice_counters")
          .select("last_number")
          .eq("company_id", companyId)
          .eq("series", serie)
          .maybeSingle();
        return (data?.last_number ?? 0) + 1;
      }),
    );
    expect(new Set(ingenuo).size).toBeLessThan(cuantas);

    // Y ahora la de verdad: next_invoice_number bloquea la fila del contador,
    // así que las 20 se serializan.
    const numeros = await Promise.all(
      Array.from({ length: cuantas }, async () => {
        const { data, error } = await admin.rpc("next_invoice_number", {
          p_company: companyId,
          p_series: serie,
        });
        if (error) throw new Error(error.message);
        return data as number;
      }),
    );

    expect(new Set(numeros).size).toBe(cuantas);
    expect([...numeros].sort((a, b) => a - b)).toEqual(
      Array.from({ length: cuantas }, (_, i) => i + 1),
    );
  });

  it("borrar un borrador no consume número", { timeout: 60_000 }, async () => {
    const antes = must(
      await admin
        .from("invoice_counters")
        .select("last_number")
        .eq("company_id", companyId)
        .eq("series", "2026")
        .single(),
    );

    const { clientId, centerId, workerId } = await crearCliente(`Descartado ${suffix}`, 10);
    await ficharJornada(centerId, workerId, "2026-07-20", "08:00", "16:00");
    const borrador = await generarBorrador({ supabase: admin, clientId, ...JULIO });
    if (!borrador.creada) throw new Error("no se creó el borrador");

    must(
      await admin
        .from("invoices")
        .delete()
        .eq("id", borrador.invoiceId)
        .select("id"),
    );

    const despues = must(
      await admin
        .from("invoice_counters")
        .select("last_number")
        .eq("company_id", companyId)
        .eq("series", "2026")
        .single(),
    );
    expect(despues.last_number).toBe(antes.last_number);
  });

  it("no emite si faltan los datos fiscales del cliente", {
    timeout: 30_000,
  }, async () => {
    const { clientId, centerId, workerId } = await crearCliente(`Sin NIF ${suffix}`, 14);
    await ficharJornada(centerId, workerId, "2026-07-21", "08:00", "16:00");
    must(
      await admin
        .from("clients")
        .update({ tax_id: null })
        .eq("id", clientId)
        .select("id"),
    );

    const borrador = await generarBorrador({ supabase: admin, clientId, ...JULIO });
    if (!borrador.creada) throw new Error("no se creó el borrador");

    await expect(
      emitirFactura({ supabase: admin, invoiceId: borrador.invoiceId }),
    ).rejects.toThrow(/NIF del cliente/);
  });

  it("aplica el IVA del cliente, incluido el exento", {
    timeout: 30_000,
  }, async () => {
    const { clientId, centerId, workerId } = await crearCliente(`Exento ${suffix}`, 20, 0);
    await ficharJornada(centerId, workerId, "2026-07-22", "08:00", "18:00");

    const borrador = await generarBorrador({ supabase: admin, clientId, ...JULIO });
    if (!borrador.creada) throw new Error("no se creó el borrador");

    const factura = must(
      await admin
        .from("invoices")
        .select("subtotal, vat_rate, vat_amount, total")
        .eq("id", borrador.invoiceId)
        .single(),
    );

    expect(Number(factura.subtotal)).toBe(200);
    expect(Number(factura.vat_rate)).toBe(0);
    expect(Number(factura.vat_amount)).toBe(0);
    expect(Number(factura.total)).toBe(200);
  });
});
