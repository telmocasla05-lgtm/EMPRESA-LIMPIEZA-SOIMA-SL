import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Test de integración contra el proyecto real de Supabase: verifica que la
// RLS aísla los datos por company. Usa service_role SOLO aquí (Node, nunca
// en código accesible desde el cliente) para sembrar y limpiar datos.

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
let workerBId: string;

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

describe("RLS: aislamiento entre companies", () => {
  beforeAll(async () => {
    const companies = must(
      await admin
        .from("companies")
        .insert([
          { name: `Empresa A ${suffix}` },
          { name: `Empresa B ${suffix}` },
        ])
        .select("id"),
    );
    [companyAId, companyBId] = companies.map((c: { id: string }) => c.id);

    const { data: userA, error: userAError } =
      await admin.auth.admin.createUser({
        email: `rls-a-${suffix}@example.com`,
        password,
        email_confirm: true,
      });
    if (userAError) throw userAError;
    userAId = userA.user.id;

    const { data: userB, error: userBError } =
      await admin.auth.admin.createUser({
        email: `rls-b-${suffix}@example.com`,
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

    const workers = must(
      await admin
        .from("workers")
        .insert([
          { company_id: companyAId, full_name: "Trabajador A", phone: `+34600${suffix}1` },
          { company_id: companyBId, full_name: "Trabajador B", phone: `+34600${suffix}2` },
        ])
        .select("id, company_id"),
    );
    workerBId = workers.find(
      (w: { company_id: string }) => w.company_id === companyBId,
    )!.id;

    const { error: signInError } = await clientA.auth.signInWithPassword({
      email: `rls-a-${suffix}@example.com`,
      password,
    });
    if (signInError) throw signInError;
  }, 60_000);

  afterAll(async () => {
    if (userAId) await admin.auth.admin.deleteUser(userAId);
    if (userBId) await admin.auth.admin.deleteUser(userBId);
    if (companyAId) await admin.from("companies").delete().eq("id", companyAId);
    if (companyBId) await admin.from("companies").delete().eq("id", companyBId);
  }, 60_000);

  it("no lee workers de otra company", { timeout: 20_000 }, async () => {
    const visible = must(
      await clientA.from("workers").select("id, company_id"),
    );
    expect(visible.length).toBeGreaterThan(0);
    expect(
      visible.every((w: { company_id: string }) => w.company_id === companyAId),
    ).toBe(true);

    const foreign = must(
      await clientA.from("workers").select("id").eq("company_id", companyBId),
    );
    expect(foreign).toEqual([]);

    const byId = must(
      await clientA.from("workers").select("id").eq("id", workerBId),
    );
    expect(byId).toEqual([]);
  });

  it("no lee la company ajena ni sus profiles", { timeout: 20_000 }, async () => {
    const companies = must(await clientA.from("companies").select("id"));
    expect(companies.map((c: { id: string }) => c.id)).toEqual([companyAId]);

    const profiles = must(
      await clientA.from("profiles").select("id, company_id"),
    );
    expect(profiles.length).toBeGreaterThan(0);
    expect(
      profiles.every(
        (p: { company_id: string }) => p.company_id === companyAId,
      ),
    ).toBe(true);
  });

  it("no escribe en la company ajena", { timeout: 20_000 }, async () => {
    const { error: insertError } = await clientA.from("workers").insert({
      company_id: companyBId,
      full_name: "Intruso",
      phone: `+34600${suffix}9`,
    });
    expect(insertError).not.toBeNull();

    const updated = must(
      await clientA
        .from("workers")
        .update({ full_name: "Modificado" })
        .eq("id", workerBId)
        .select("id"),
    );
    expect(updated).toEqual([]);

    const workerB = must(
      await admin
        .from("workers")
        .select("full_name")
        .eq("id", workerBId)
        .single(),
    );
    expect(workerB.full_name).toBe("Trabajador B");
  });
});
