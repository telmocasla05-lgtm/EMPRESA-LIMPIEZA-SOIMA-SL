import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Test de integración contra el proyecto real de Supabase: verifica que la RLS
// del módulo de facturación aísla por company. Un usuario de la empresa A no
// puede leer —ni tocar— las facturas, líneas ni trazabilidad de la empresa B.
// Usa service_role SOLO aquí (Node, nunca en código accesible desde el
// cliente) para sembrar y limpiar datos.

try {
  process.loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)));
} catch {
  // Sin .env.local: las variables pueden venir del entorno.
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !anonKey || !serviceRoleKey) {
  // Este test es crítico: si no puede ejecutarse debe fallar, no saltarse.
  throw new Error(
    "Test crítico de RLS sin configurar: rellena NEXT_PUBLIC_SUPABASE_URL, " +
      "NEXT_PUBLIC_SUPABASE_ANON_KEY y SUPABASE_SERVICE_ROLE_KEY en .env.local " +
      "y aplica las migraciones (npx supabase db push) antes de ejecutarlo.",
  );
}

const admin = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const clientA = createClient(url, anonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const suffix = randomUUID().slice(0, 8);
const password = `Prueba-${randomUUID()}`;

let companyAId: string;
let companyBId: string;
let userAId: string;
let userBId: string;
let clienteAId: string;
let clienteBId: string;
let facturaAId: string;
let facturaBId: string;
let lineaBId: string;
let fichajeBEntradaId: string;

function must<T>(result: {
  data: T;
  error: { message: string } | null;
}): NonNullable<T> {
  if (result.error) throw new Error(result.error.message);
  if (result.data === null || result.data === undefined) {
    throw new Error("Respuesta sin datos");
  }
  return result.data as NonNullable<T>;
}

// Siembra una empresa completa: cliente, centro, operario, una jornada
// fichada y una factura con su línea y su trazabilidad.
async function sembrarEmpresa(nombre: string, marca: string) {
  const company = must(
    await admin.from("companies").insert({ name: nombre }).select("id").single(),
  );
  const companyId = company.id as string;

  const cliente = must(
    await admin
      .from("clients")
      .insert({ company_id: companyId, name: `Cliente ${marca}` })
      .select("id")
      .single(),
  );

  const centro = must(
    await admin
      .from("centers")
      .insert({
        company_id: companyId,
        client_id: cliente.id,
        name: `Centro ${marca}`,
      })
      .select("id")
      .single(),
  );

  const operario = must(
    await admin
      .from("workers")
      .insert({
        company_id: companyId,
        full_name: `Operario ${marca}`,
        phone: `+34600${suffix}${marca}`,
      })
      .select("id")
      .single(),
  );

  const fichajes = must(
    await admin
      .from("time_entries")
      .insert([
        {
          company_id: companyId,
          worker_id: operario.id,
          center_id: centro.id,
          type: "entrada",
          created_at: "2026-07-06T06:00:00Z",
        },
        {
          company_id: companyId,
          worker_id: operario.id,
          center_id: centro.id,
          type: "salida",
          created_at: "2026-07-06T14:00:00Z",
        },
      ])
      .select("id, type"),
  );
  const entrada = fichajes.find((f: { type: string }) => f.type === "entrada")!;
  const salida = fichajes.find((f: { type: string }) => f.type === "salida")!;

  // Se crea como borrador: el trigger invoice_lines_solo_borrador prohíbe
  // añadir líneas a una factura ya emitida, igual que en la emisión real.
  const factura = must(
    await admin
      .from("invoices")
      .insert({
        company_id: companyId,
        client_id: cliente.id,
        period_start: "2026-07-01",
        period_end: "2026-07-31",
        client_name: `Cliente ${marca}`,
        client_tax_id: `B0000000${marca === "A" ? 1 : 2}`,
        vat_rate: 21,
        total_hours: 8,
        subtotal: 112,
        vat_amount: 23.52,
        total: 135.52,
      })
      .select("id")
      .single(),
  );

  const linea = must(
    await admin
      .from("invoice_lines")
      .insert({
        company_id: companyId,
        invoice_id: factura.id,
        center_id: centro.id,
        center_name: `Centro ${marca}`,
        description: `Limpieza — Centro ${marca} (01/07–31/07)`,
        period_from: "2026-07-01",
        period_to: "2026-07-31",
        minutes: 480,
        hours: 8,
        hourly_rate: 14,
        amount: 112,
        position: 1,
      })
      .select("id")
      .single(),
  );

  must(
    await admin
      .from("invoice_time_entries")
      .insert({
        invoice_id: factura.id,
        entry_in_id: entrada.id,
        entry_out_id: salida.id,
        company_id: companyId,
        center_id: centro.id,
        worker_id: operario.id,
        work_date: "2026-07-06",
        minutes: 480,
      })
      .select("invoice_id"),
  );

  // Emitir: borrador -> emitida es la única transición que permite el
  // trigger de inmutabilidad.
  const numero = must(
    await admin.rpc("next_invoice_number", {
      p_company: companyId,
      p_series: "2026",
    }),
  );
  must(
    await admin
      .from("invoices")
      .update({
        status: "emitida",
        series: "2026",
        number: numero,
        invoice_number: `2026/${String(numero).padStart(4, "0")}`,
        issue_date: "2026-08-01",
        due_date: "2026-08-31",
        issued_at: new Date().toISOString(),
      })
      .eq("id", factura.id)
      .select("id"),
  );

  return {
    companyId,
    clienteId: cliente.id as string,
    facturaId: factura.id as string,
    lineaId: linea.id as string,
    entradaId: entrada.id as string,
  };
}

describe("RLS: aislamiento de facturación entre companies", () => {
  beforeAll(async () => {
    const empresaA = await sembrarEmpresa(`Empresa A ${suffix}`, "A");
    const empresaB = await sembrarEmpresa(`Empresa B ${suffix}`, "B");

    companyAId = empresaA.companyId;
    clienteAId = empresaA.clienteId;
    facturaAId = empresaA.facturaId;

    companyBId = empresaB.companyId;
    clienteBId = empresaB.clienteId;
    facturaBId = empresaB.facturaId;
    lineaBId = empresaB.lineaId;
    fichajeBEntradaId = empresaB.entradaId;

    const { data: userA, error: userAError } =
      await admin.auth.admin.createUser({
        email: `fact-a-${suffix}@example.com`,
        password,
        email_confirm: true,
      });
    if (userAError) throw userAError;
    userAId = userA.user.id;

    const { data: userB, error: userBError } =
      await admin.auth.admin.createUser({
        email: `fact-b-${suffix}@example.com`,
        password,
        email_confirm: true,
      });
    if (userBError) throw userBError;
    userBId = userB.user.id;

    must(
      await admin
        .from("profiles")
        .insert([
          { id: userAId, company_id: companyAId, full_name: "Admin A", role: "admin" },
          { id: userBId, company_id: companyBId, full_name: "Admin B", role: "admin" },
        ])
        .select("id"),
    );

    const { error: signInError } = await clientA.auth.signInWithPassword({
      email: `fact-a-${suffix}@example.com`,
      password,
    });
    if (signInError) throw signInError;
  }, 90_000);

  afterAll(async () => {
    if (userAId) await admin.auth.admin.deleteUser(userAId);
    if (userBId) await admin.auth.admin.deleteUser(userBId);
    // Borra en cascada clientes, centros, fichajes, facturas y sus líneas.
    if (companyAId) await admin.from("companies").delete().eq("id", companyAId);
    if (companyBId) await admin.from("companies").delete().eq("id", companyBId);
  }, 90_000);

  it("no lee facturas de otra company", { timeout: 20_000 }, async () => {
    // Sin filtro: solo aparecen las propias.
    const visibles = must(
      await clientA.from("invoices").select("id, company_id"),
    );
    expect(visibles.length).toBeGreaterThan(0);
    expect(
      visibles.every(
        (f: { company_id: string }) => f.company_id === companyAId,
      ),
    ).toBe(true);
    expect(visibles.map((f: { id: string }) => f.id)).toContain(facturaAId);

    // Filtrando por la company ajena: nada.
    const ajenas = must(
      await clientA.from("invoices").select("id").eq("company_id", companyBId),
    );
    expect(ajenas).toEqual([]);

    // Apuntando al id exacto de la factura de B: tampoco.
    const porId = must(
      await clientA.from("invoices").select("id").eq("id", facturaBId),
    );
    expect(porId).toEqual([]);

    // Ni por su número de factura.
    const porNumero = must(
      await clientA
        .from("invoices")
        .select("id, invoice_number")
        .not("invoice_number", "is", null),
    );
    expect(
      porNumero.every(
        (f: { id: string }) => f.id !== facturaBId,
      ),
    ).toBe(true);
  });

  it("no lee líneas ni trazabilidad de otra company", { timeout: 20_000 }, async () => {
    const lineas = must(
      await clientA.from("invoice_lines").select("id, company_id"),
    );
    expect(lineas.length).toBeGreaterThan(0);
    expect(
      lineas.every((l: { company_id: string }) => l.company_id === companyAId),
    ).toBe(true);
    expect(lineas.map((l: { id: string }) => l.id)).not.toContain(lineaBId);

    const lineasPorFactura = must(
      await clientA.from("invoice_lines").select("id").eq("invoice_id", facturaBId),
    );
    expect(lineasPorFactura).toEqual([]);

    const jornadas = must(
      await clientA
        .from("invoice_time_entries")
        .select("invoice_id, company_id"),
    );
    // Con datos: si esto llegara vacío, el resto de la comprobación no
    // demostraría nada.
    expect(jornadas.length).toBeGreaterThan(0);
    expect(
      jornadas.every(
        (j: { company_id: string }) => j.company_id === companyAId,
      ),
    ).toBe(true);

    const jornadasAjenas = must(
      await clientA
        .from("invoice_time_entries")
        .select("invoice_id")
        .eq("entry_in_id", fichajeBEntradaId),
    );
    expect(jornadasAjenas).toEqual([]);
  });

  it("no escribe facturas en otra company", { timeout: 20_000 }, async () => {
    // Insertar con el company_id ajeno.
    const { error: errorCompanyAjena } = await clientA.from("invoices").insert({
      company_id: companyBId,
      client_id: clienteBId,
      period_start: "2026-07-01",
      period_end: "2026-07-31",
      client_name: "Intruso",
      vat_rate: 21,
    });
    expect(errorCompanyAjena).not.toBeNull();

    // Con el company_id propio pero apuntando a un cliente de B: lo corta la
    // comprobación de coherencia de company de la política.
    const { error: errorClienteAjeno } = await clientA.from("invoices").insert({
      company_id: companyAId,
      client_id: clienteBId,
      period_start: "2026-06-01",
      period_end: "2026-06-30",
      client_name: "Intruso",
      vat_rate: 21,
    });
    expect(errorClienteAjeno).not.toBeNull();

    // Modificar la factura de B: la RLS no deja ver la fila, así que no
    // actualiza nada.
    const actualizadas = must(
      await clientA
        .from("invoices")
        .update({ notes: "Modificado desde otra company" })
        .eq("id", facturaBId)
        .select("id"),
    );
    expect(actualizadas).toEqual([]);

    // Borrarla tampoco.
    const borradas = must(
      await clientA.from("invoices").delete().eq("id", facturaBId).select("id"),
    );
    expect(borradas).toEqual([]);

    // La factura de B sigue intacta.
    const facturaB = must(
      await admin
        .from("invoices")
        .select("notes, status")
        .eq("id", facturaBId)
        .single(),
    );
    expect(facturaB.notes).toBeNull();
    expect(facturaB.status).toBe("emitida");
  });

  it("no lee el contador de numeración de nadie", { timeout: 20_000 }, async () => {
    // Las dos empresas han emitido, así que sus contadores existen...
    const reales = must(
      await admin
        .from("invoice_counters")
        .select("company_id")
        .in("company_id", [companyAId, companyBId]),
    );
    expect(reales.length).toBe(2);

    // ...pero invoice_counters tiene RLS activada y ninguna política: ni
    // siquiera la propia company lo ve desde el panel.
    const contadores = must(
      await clientA.from("invoice_counters").select("company_id, series"),
    );
    expect(contadores).toEqual([]);
  });

  it("el aislamiento no es un falso positivo: con service_role se ven las dos", {
    timeout: 20_000,
  }, async () => {
    // Contraprueba: los datos de B existen de verdad y son legibles saltándose
    // la RLS. Si este test pasara y los anteriores también, el aislamiento es
    // real y no el efecto de una siembra vacía.
    const todas = must(
      await admin
        .from("invoices")
        .select("id, company_id")
        .in("company_id", [companyAId, companyBId]),
    );
    expect(todas.length).toBe(2);
    expect(todas.map((f: { id: string }) => f.id).sort()).toEqual(
      [facturaAId, facturaBId].sort(),
    );

    // Y desde el panel de A, exactamente una: la suya.
    const deA = must(
      await clientA
        .from("invoices")
        .select("id")
        .in("company_id", [companyAId, companyBId]),
    );
    expect(deA.map((f: { id: string }) => f.id)).toEqual([facturaAId]);
  });
});
