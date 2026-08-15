// Acceso al bucket privado de facturas (SPEC-facturacion.md 3).
//
// Vive aparte de factura.ts para que el aviso por WhatsApp pueda firmar el
// enlace del PDF sin depender del módulo de emisión (que a su vez lo llama).

import { type SupabaseClient } from "@supabase/supabase-js";

export const BUCKET_FACTURAS = "facturas";

// URL de descarga temporal. El bucket es privado: nunca se expone, y la firma
// caduca en 60 segundos (SPEC 3).
export async function urlFirmadaFactura(
  supabase: SupabaseClient,
  pdfPath: string,
  segundos = 60,
): Promise<string> {
  const { data, error } = await supabase.storage
    .from(BUCKET_FACTURAS)
    .createSignedUrl(pdfPath, segundos);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}
