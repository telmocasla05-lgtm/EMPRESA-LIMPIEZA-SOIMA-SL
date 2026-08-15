import { urlFirmadaFactura } from "@/lib/billing/factura";
import { createClient } from "@/lib/supabase/server";

// Descarga del PDF de una factura (SPEC-facturacion.md 3).
//
// El bucket `facturas` es privado y nunca se expone. Esta ruta valida la
// sesión, comprueba con la RLS que la factura es de la company del usuario
// (una de otra empresa sencillamente no aparece) y redirige a una URL firmada
// que caduca en 60 segundos.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("No autorizado", { status: 401 });

  const { data, error } = await supabase
    .from("invoices")
    .select("pdf_path")
    .eq("id", id)
    .maybeSingle();

  if (error) return new Response(error.message, { status: 500 });
  if (!data) return new Response("Factura no encontrada", { status: 404 });
  if (!data.pdf_path) {
    return new Response("Esta factura todavía no tiene PDF", { status: 404 });
  }

  return Response.redirect(await urlFirmadaFactura(supabase, data.pdf_path), 302);
}
