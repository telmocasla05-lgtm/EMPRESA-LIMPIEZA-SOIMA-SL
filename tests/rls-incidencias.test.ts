import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Test de integración contra el proyecto real de Supabase: verifica que la RLS
// del módulo de incidencias aísla por company. Un usuario de la empresa A no
// puede leer —ni tocar— las incidencias ni las notas de la empresa B.
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
let incidenciaAId: string;
let incidenciaBId: string;
let notaBId: string;
let operarioAId: string;
let operarioBId: string;
let centroBId: string;

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

// Siembra una empresa con cliente, centro, operario y una incidencia abierta
// con su nota de seguimiento.
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

  // Así la inserta el webhook: con service_role, saltándose la RLS.
  const incidencia = must(
    await admin
      .from("incidents")
      .insert({
        company_id: companyId,
        worker_id: operario.id,
        center_id: centro.id,
        type: marca === "A" ? "material_roto" : "seguridad",
        urgency: marca === "A" ? "normal" : "alta",
        status: "open",
        description: `Incidencia de la empresa ${marca}`,
        photo_url: `${companyId}/foto-${marca}.jpg`,
      })
      .select("id")
      .single(),
  );

  const nota = must(
    await admin
      .from("incident_updates")
      .insert({
        company_id: companyId,
        incident_id: incidencia.id,
        note: `Nota interna de la empresa ${marca}`,
      })
      .select("id")
      .single(),
  );

  return {
    companyId,
    centroId: centro.id as string,
    operarioId: operario.id as string,
    incidenciaId: incidencia.id as string,
    notaId: nota.id as string,
  };
}

describe("RLS: aislamiento de incidencias entre companies", () => {
  beforeAll(async () => {
    const empresaA = await sembrarEmpresa(`Empresa A ${suffix}`, "A");
    const empresaB = await sembrarEmpresa(`Empresa B ${suffix}`, "B");

    companyAId = empresaA.companyId;
    operarioAId = empresaA.operarioId;
    incidenciaAId = empresaA.incidenciaId;

    companyBId = empresaB.companyId;
    operarioBId = empresaB.operarioId;
    centroBId = empresaB.centroId;
    incidenciaBId = empresaB.incidenciaId;
    notaBId = empresaB.notaId;

    const { data: userA, error: userAError } =
      await admin.auth.admin.createUser({
        email: `inc-a-${suffix}@example.com`,
        password,
        email_confirm: true,
      });
    if (userAError) throw userAError;
    userAId = userA.user.id;

    const { data: userB, error: userBError } =
      await admin.auth.admin.createUser({
        email: `inc-b-${suffix}@example.com`,
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
      email: `inc-a-${suffix}@example.com`,
      password,
    });
    if (signInError) throw signInError;
  }, 90_000);

  afterAll(async () => {
    if (userAId) await admin.auth.admin.deleteUser(userAId);
    if (userBId) await admin.auth.admin.deleteUser(userBId);
    // Borra en cascada clientes, centros, operarios, incidencias y notas.
    if (companyAId) await admin.from("companies").delete().eq("id", companyAId);
    if (companyBId) await admin.from("companies").delete().eq("id", companyBId);
  }, 90_000);

  it("no lee incidencias de otra company", { timeout: 20_000 }, async () => {
    // Sin filtro: solo aparecen las propias.
    const visibles = must(
      await clientA.from("incidents").select("id, company_id"),
    );
    expect(visibles.length).toBeGreaterThan(0);
    expect(
      visibles.every(
        (i: { company_id: string }) => i.company_id === companyAId,
      ),
    ).toBe(true);
    expect(visibles.map((i: { id: string }) => i.id)).toContain(incidenciaAId);

    // Filtrando por la company ajena: nada.
    const ajenas = must(
      await clientA.from("incidents").select("id").eq("company_id", companyBId),
    );
    expect(ajenas).toEqual([]);

    // Apuntando al id exacto de la incidencia de B: tampoco.
    const porId = must(
      await clientA.from("incidents").select("id").eq("id", incidenciaBId),
    );
    expect(porId).toEqual([]);

    // Ni buscando por el operario o el centro de B.
    const porOperario = must(
      await clientA.from("incidents").select("id").eq("worker_id", operarioBId),
    );
    expect(porOperario).toEqual([]);

    const porCentro = must(
      await clientA.from("incidents").select("id").eq("center_id", centroBId),
    );
    expect(porCentro).toEqual([]);

    // Ni filtrando por lo que sí sabe de ella: es de seguridad y urgente.
    const porUrgencia = must(
      await clientA
        .from("incidents")
        .select("id, description")
        .eq("urgency", "alta"),
    );
    expect(porUrgencia.map((i: { id: string }) => i.id)).not.toContain(
      incidenciaBId,
    );
  });

  it("no lee notas de incidencias de otra company", { timeout: 20_000 }, async () => {
    const notas = must(
      await clientA.from("incident_updates").select("id, company_id, note"),
    );
    // Con datos: si esto llegara vacío, el resto no demostraría nada.
    expect(notas.length).toBeGreaterThan(0);
    expect(
      notas.every((n: { company_id: string }) => n.company_id === companyAId),
    ).toBe(true);
    expect(notas.map((n: { id: string }) => n.id)).not.toContain(notaBId);
    expect(
      notas.every((n: { note: string }) => !n.note.includes("empresa B")),
    ).toBe(true);

    // Entrando por el id de la incidencia de B: tampoco.
    const porIncidencia = must(
      await clientA
        .from("incident_updates")
        .select("id")
        .eq("incident_id", incidenciaBId),
    );
    expect(porIncidencia).toEqual([]);
  });

  it("no escribe incidencias en otra company", { timeout: 20_000 }, async () => {
    // Insertar con el company_id ajeno.
    const { error: errorCompanyAjena } = await clientA.from("incidents").insert({
      company_id: companyBId,
      worker_id: operarioBId,
      type: "material_roto",
      description: "Intruso",
    });
    expect(errorCompanyAjena).not.toBeNull();

    // Con el company_id propio pero apuntando al operario de B: lo corta la
    // comprobación de coherencia de company de la política.
    const { error: errorOperarioAjeno } = await clientA
      .from("incidents")
      .insert({
        company_id: companyAId,
        worker_id: operarioBId,
        type: "material_roto",
        description: "Intruso",
      });
    expect(errorOperarioAjeno).not.toBeNull();

    // Y con operario propio pero centro de B: igual.
    const { error: errorCentroAjeno } = await clientA.from("incidents").insert({
      company_id: companyAId,
      worker_id: operarioAId,
      center_id: centroBId,
      type: "material_roto",
      description: "Intruso",
    });
    expect(errorCentroAjeno).not.toBeNull();

    // Asignar una incidencia propia a un jefe de B: lo corta assigned_to.
    const { error: errorAsignadoAjeno } = await clientA
      .from("incidents")
      .update({ assigned_to: userBId })
      .eq("id", incidenciaAId);
    expect(errorAsignadoAjeno).not.toBeNull();

    // Modificar la incidencia de B: la RLS no deja ver la fila, así que no
    // actualiza nada.
    const actualizadas = must(
      await clientA
        .from("incidents")
        .update({ status: "resolved", resolved_at: new Date().toISOString() })
        .eq("id", incidenciaBId)
        .select("id"),
    );
    expect(actualizadas).toEqual([]);

    // Borrarla tampoco.
    const borradas = must(
      await clientA.from("incidents").delete().eq("id", incidenciaBId).select("id"),
    );
    expect(borradas).toEqual([]);

    // Escribir una nota en la incidencia de B tampoco.
    const { error: errorNotaAjena } = await clientA
      .from("incident_updates")
      .insert({
        company_id: companyAId,
        incident_id: incidenciaBId,
        note: "Intruso",
      });
    expect(errorNotaAjena).not.toBeNull();

    // La incidencia de B sigue intacta.
    const incidenciaB = must(
      await admin
        .from("incidents")
        .select("status, resolved_at, assigned_to")
        .eq("id", incidenciaBId)
        .single(),
    );
    expect(incidenciaB.status).toBe("open");
    expect(incidenciaB.resolved_at).toBeNull();
    expect(incidenciaB.assigned_to).toBeNull();
  });

  it("el aislamiento no es un falso positivo: con service_role se ven las dos", {
    timeout: 20_000,
  }, async () => {
    // Contraprueba: los datos de B existen de verdad y son legibles saltándose
    // la RLS. Si este test pasara y los anteriores también, el aislamiento es
    // real y no el efecto de una siembra vacía.
    const todas = must(
      await admin
        .from("incidents")
        .select("id, company_id")
        .in("company_id", [companyAId, companyBId]),
    );
    expect(todas.length).toBe(2);
    expect(todas.map((i: { id: string }) => i.id).sort()).toEqual(
      [incidenciaAId, incidenciaBId].sort(),
    );

    // Y desde el panel de A, exactamente una: la suya.
    const deA = must(
      await clientA
        .from("incidents")
        .select("id")
        .in("company_id", [companyAId, companyBId]),
    );
    expect(deA.map((i: { id: string }) => i.id)).toEqual([incidenciaAId]);
  });
});
