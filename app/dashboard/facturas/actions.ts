"use server";

// Acciones del panel de facturas.
//
// Van en el servidor, no en el componente cliente, por dos motivos: la emisión
// genera el PDF con pdf-lib (código de servidor, y de paso no engorda el
// bundle del navegador) y la generación de un borrador hace varias escrituras
// encadenadas. Todas usan el cliente Supabase de la SESIÓN, nunca service_role:
// así la RLS sigue exigiendo que quien emite sea admin de esa company
// (SPEC-facturacion.md 5.2).

import { revalidatePath } from "next/cache";
import { emitirFactura, generarBorrador } from "@/lib/billing/factura";
import { monthPeriod } from "@/lib/dates";
import { createClient } from "@/lib/supabase/server";

export type ResultadoAccion =
  | { ok: true; mensaje: string }
  | { ok: false; error: string };

function textoDeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function refrescar(invoiceId?: string) {
  revalidatePath("/dashboard/facturas");
  if (invoiceId) revalidatePath(`/dashboard/facturas/${invoiceId}`);
}

// Borrador → emitida: número correlativo, importes congelados y PDF.
// Es el paso con valor legal, así que a partir de aquí la factura ya no se
// puede modificar (trigger invoices_inmutabilidad).
export async function emitirFacturaAction(
  invoiceId: string,
): Promise<ResultadoAccion> {
  try {
    const emision = await emitirFactura({
      supabase: await createClient(),
      invoiceId,
    });
    refrescar(invoiceId);

    // El PDF y el aviso por WhatsApp van fuera de la transacción: si fallan,
    // la factura está emitida y es válida igualmente.
    const partes = [`Factura ${emision.invoiceNumber} emitida`];
    if (emision.pdfError) {
      partes.push(`el PDF no se pudo guardar (${emision.pdfError})`);
    }
    if (emision.aviso.cliente === "enviado") {
      partes.push("enviada al cliente por WhatsApp");
    } else if (emision.aviso.cliente === "sin_telefono") {
      partes.push(
        "no se pudo enviar al cliente: no tiene teléfono de contacto en su ficha",
      );
    } else if (emision.aviso.cliente === "error_envio") {
      partes.push(`no se pudo enviar al cliente por WhatsApp (${emision.aviso.error})`);
    }

    return { ok: true, mensaje: `${partes.join(", ")}.` };
  } catch (error) {
    return { ok: false, error: textoDeError(error) };
  }
}

// Cobro: paid_at es de los tres campos que el trigger deja tocar en una
// factura ya emitida, así que se puede marcar y desmarcar sin romper nada.
export async function marcarCobradaAction(
  invoiceId: string,
  cobrada: boolean,
): Promise<ResultadoAccion> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("invoices")
    .update({ paid_at: cobrada ? new Date().toISOString() : null })
    .eq("id", invoiceId);

  if (error) return { ok: false, error: error.message };
  refrescar(invoiceId);
  return {
    ok: true,
    mensaje: cobrada ? "Factura marcada como cobrada." : "Factura marcada como pendiente de cobro.",
  };
}

// "Generar ahora": el mismo cierre que hace el cron del día 1, pero para un
// solo cliente y el mes que se pida. Sirve para adelantarse al cron o para
// rehacer un borrador después de corregir un fichaje.
//
// Es idempotente: si ya hay borrador lo recalcula, y si la factura ya está
// emitida no la toca (habría que hacer una rectificativa).
export async function generarAhoraAction(
  clientId: string,
  periodo: string,
): Promise<ResultadoAccion> {
  try {
    const { periodStart, periodEnd } = monthPeriod(periodo);
    const resultado = await generarBorrador({
      supabase: await createClient(),
      clientId,
      periodStart,
      periodEnd,
    });
    refrescar();

    if (!resultado.creada) {
      return resultado.motivo === "ya_emitida"
        ? {
            ok: false,
            error:
              "Ese cliente ya tiene la factura de ese mes emitida. Para cambiarla hay que hacer una rectificativa.",
          }
        : {
            ok: false,
            error:
              "Ese cliente no tiene horas facturables en ese mes: no se genera factura.",
          };
    }

    const incidencias = resultado.incidencias.length;
    return {
      ok: true,
      mensaje:
        incidencias > 0
          ? `Borrador generado con ${incidencias} incidencia(s): hay que resolverlas antes de emitir.`
          : "Borrador generado.",
    };
  } catch (error) {
    return { ok: false, error: textoDeError(error) };
  }
}
