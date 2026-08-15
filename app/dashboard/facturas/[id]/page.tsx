import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  FacturaDetalle,
  type FacturaDetallada,
  type LineaFactura,
} from "./factura-detalle";

export default async function FacturaPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Sin filtro por company: la RLS ya la limita a la del usuario, así que una
  // factura de otra empresa simplemente no aparece.
  const { data: factura } = await supabase
    .from("invoices")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!factura) notFound();

  const [{ data: lineas }, { data: perfil }] = await Promise.all([
    supabase
      .from("invoice_lines")
      .select("id, center_name, description, period_from, period_to, hours, hourly_rate, amount")
      .eq("invoice_id", id)
      .order("position"),
    supabase.from("profiles").select("role").eq("id", user.id).maybeSingle(),
  ]);

  return (
    <FacturaDetalle
      factura={factura as FacturaDetallada}
      lineas={(lineas ?? []) as LineaFactura[]}
      esAdmin={perfil?.role === "admin"}
    />
  );
}
