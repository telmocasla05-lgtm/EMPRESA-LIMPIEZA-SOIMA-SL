// Cierre mensual: prepara de una pasada los borradores de todos los clientes
// (SPEC-facturacion.md, sección 6).
//
// Lo usan dos sitios con la misma función, como pide el SPEC: el cron del día 1
// (app/api/cron/facturacion) sobre todas las companies con service_role, y el
// botón "Preparar mes" del panel sobre una sola company con la sesión del
// usuario (que respeta RLS).
//
// Dos propiedades que no se negocian:
//   - Idempotente: reejecutarlo no duplica nada. Lo garantiza generarBorrador
//     (reescribe el borrador que ya exista y no toca lo ya emitido) y, como
//     red de seguridad, el índice invoices_periodo_unico_idx.
//   - Aislado por cliente: si el cierre de un cliente falla, se registra y se
//     sigue con el resto. Un cliente roto no puede dejar sin facturar a los
//     demás, ni mucho menos a otra company.

import { type SupabaseClient } from "@supabase/supabase-js";
import { generarBorrador } from "@/lib/billing/factura";

export type FalloCierre = {
  companyId: string;
  clientId: string;
  clientName: string;
  error: string;
};

export type ResultadoCierreMes = {
  periodStart: string;
  periodEnd: string;
  companies: number;
  clientes: number;
  borradores: number;
  conIncidencias: number;
  sinActividad: number;
  yaEmitidas: number;
  fallidos: FalloCierre[];
};

type ClienteFila = {
  id: string;
  company_id: string;
  name: string;
};

export async function prepararCierreMes({
  supabase,
  periodStart,
  periodEnd,
  companyId,
}: {
  supabase: SupabaseClient;
  periodStart: string;
  periodEnd: string;
  // Sin companyId se recorren todas las companies (el cron). Con él, solo esa
  // (el botón del panel).
  companyId?: string;
}): Promise<ResultadoCierreMes> {
  let consulta = supabase.from("clients").select("id, company_id, name");
  if (companyId) consulta = consulta.eq("company_id", companyId);

  const { data, error } = await consulta.order("company_id").order("name");
  if (error) throw new Error(`Error consultando clientes: ${error.message}`);
  const clientes = (data ?? []) as ClienteFila[];

  const resultado: ResultadoCierreMes = {
    periodStart,
    periodEnd,
    companies: new Set(clientes.map((cliente) => cliente.company_id)).size,
    clientes: clientes.length,
    borradores: 0,
    conIncidencias: 0,
    sinActividad: 0,
    yaEmitidas: 0,
    fallidos: [],
  };

  // De uno en uno y no en paralelo: cada borrador hace varias consultas y
  // escrituras, y lanzarlos todos a la vez contra Postgres no acelera el
  // cierre, solo lo hace más frágil.
  for (const cliente of clientes) {
    try {
      const borrador = await generarBorrador({
        supabase,
        clientId: cliente.id,
        periodStart,
        periodEnd,
      });

      if (borrador.creada) {
        resultado.borradores += 1;
        if (borrador.incidencias.length > 0) resultado.conIncidencias += 1;
      } else if (borrador.motivo === "ya_emitida") {
        resultado.yaEmitidas += 1;
      } else {
        resultado.sinActividad += 1;
      }
    } catch (error) {
      // El fallo de un cliente se queda en ese cliente: se anota y se sigue.
      const mensaje = error instanceof Error ? error.message : String(error);
      console.error(
        `[facturacion] Cliente ${cliente.name} (${cliente.id}) de la company ${cliente.company_id}: ${mensaje}`,
      );
      resultado.fallidos.push({
        companyId: cliente.company_id,
        clientId: cliente.id,
        clientName: cliente.name,
        error: mensaje,
      });
    }
  }

  return resultado;
}

// Línea de log del cierre (SPEC 6, punto 4).
export function resumenCierre(resultado: ResultadoCierreMes): string {
  const mes = resultado.periodStart.slice(0, 7);
  const partes = [
    `${resultado.borradores} borradores`,
    `${resultado.conIncidencias} con incidencias`,
    `${resultado.sinActividad} sin actividad`,
    `${resultado.yaEmitidas} ya emitidas`,
  ];
  if (resultado.fallidos.length > 0) {
    partes.push(`${resultado.fallidos.length} con error`);
  }
  return `[facturacion] Cierre de ${mes}: ${partes.join(", ")}`;
}
