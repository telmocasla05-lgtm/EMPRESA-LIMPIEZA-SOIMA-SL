// Aviso por WhatsApp al cliente cuando su factura pasa a emitida.
//
// Regla de oro: esto NUNCA tumba una emisión. La factura ya tiene número y
// valor legal cuando llegamos aquí, así que cualquier problema del aviso
// (cliente sin teléfono, Meta caída, PDF que no se guardó) se resuelve
// avisando al admin de la company, no lanzando el error hacia arriba.

import { type SupabaseClient } from "@supabase/supabase-js";
import { formatEuros } from "@/lib/billing/importes";
import { urlFirmadaFactura } from "@/lib/billing/storage";
import { sendWhatsAppText } from "@/lib/whatsapp/send";

// El cliente abre el WhatsApp cuando le viene bien, no en los 60 segundos de
// la descarga del panel: el enlace dura lo que el plazo de pago habitual.
export const DIAS_ENLACE = 30;
const SEGUNDOS_ENLACE = DIAS_ENLACE * 24 * 60 * 60;

export type MotivoFallo = "sin_telefono" | "sin_pdf" | "error_envio";

export type ResultadoAviso = {
  cliente: "enviado" | MotivoFallo;
  // Solo cuando el aviso al cliente no ha salido.
  admin?: "enviado" | "sin_telefono" | "error_envio";
  error?: string;
};

export type ClienteAviso = {
  name: string;
  contact_name: string | null;
  contact_phone: string | null;
};

export type EmpresaAviso = {
  name: string;
  phone: string | null;
};

export function mensajeCliente({
  cliente,
  empresa,
  invoiceNumber,
  totalCentimos,
  url,
}: {
  cliente: ClienteAviso;
  empresa: EmpresaAviso;
  invoiceNumber: string;
  totalCentimos: number;
  url: string;
}): string {
  const saludo = cliente.contact_name?.trim() || cliente.name;
  return (
    `Hola ${saludo}: ya tienes la factura ${invoiceNumber} de ${empresa.name}, ` +
    `por ${formatEuros(totalCentimos)}.\n` +
    `Descárgala aquí (el enlace caduca en ${DIAS_ENLACE} días): ${url}`
  );
}

const EXPLICACION: Record<MotivoFallo, string> = {
  sin_telefono: "no tiene teléfono de contacto en su ficha",
  sin_pdf: "la factura se emitió sin PDF",
  error_envio: "falló el envío de WhatsApp",
};

export function mensajeAdmin({
  cliente,
  invoiceNumber,
  motivo,
}: {
  cliente: ClienteAviso;
  invoiceNumber: string;
  motivo: MotivoFallo;
}): string {
  return (
    `⚠️ La factura ${invoiceNumber} de ${cliente.name} se emitió correctamente, ` +
    `pero no se le pudo enviar por WhatsApp: ${EXPLICACION[motivo]}.\n` +
    `Descárgala del panel y envíasela a mano.`
  );
}

// Avisa al cliente de su factura recién emitida con el enlace del PDF.
// Si no se puede, avisa al admin de la company. No lanza nunca.
export async function avisarFacturaEmitida({
  supabase,
  cliente,
  empresa,
  invoiceNumber,
  totalCentimos,
  pdfPath,
}: {
  supabase: SupabaseClient;
  cliente: ClienteAviso;
  empresa: EmpresaAviso;
  invoiceNumber: string;
  totalCentimos: number;
  pdfPath: string | null;
}): Promise<ResultadoAviso> {
  const telefono = cliente.contact_phone?.trim();
  if (!telefono) {
    return avisarAlAdmin({ cliente, empresa, invoiceNumber, motivo: "sin_telefono" });
  }
  if (!pdfPath) {
    return avisarAlAdmin({ cliente, empresa, invoiceNumber, motivo: "sin_pdf" });
  }

  try {
    const url = await urlFirmadaFactura(supabase, pdfPath, SEGUNDOS_ENLACE);
    await sendWhatsAppText(
      telefono,
      mensajeCliente({ cliente, empresa, invoiceNumber, totalCentimos, url }),
    );
    return { cliente: "enviado" };
  } catch (error) {
    const texto = error instanceof Error ? error.message : String(error);
    console.error(
      `[facturas] No se pudo avisar a ${cliente.name} de la factura ${invoiceNumber}:`,
      texto,
    );
    return {
      ...(await avisarAlAdmin({
        cliente,
        empresa,
        invoiceNumber,
        motivo: "error_envio",
      })),
      error: texto,
    };
  }
}

async function avisarAlAdmin({
  cliente,
  empresa,
  invoiceNumber,
  motivo,
}: {
  cliente: ClienteAviso;
  empresa: EmpresaAviso;
  invoiceNumber: string;
  motivo: MotivoFallo;
}): Promise<ResultadoAviso> {
  const telefonoAdmin = empresa.phone?.trim();
  if (!telefonoAdmin) {
    // Sin teléfono de empresa el aviso solo puede quedar en el log; el panel
    // lo enseña igualmente al terminar la emisión.
    console.error(
      `[facturas] Factura ${invoiceNumber} emitida sin avisar a ${cliente.name} ` +
        `(${motivo}) y la company no tiene teléfono para avisar al admin`,
    );
    return { cliente: motivo, admin: "sin_telefono" };
  }

  try {
    await sendWhatsAppText(
      telefonoAdmin,
      mensajeAdmin({ cliente, invoiceNumber, motivo }),
    );
    return { cliente: motivo, admin: "enviado" };
  } catch (error) {
    console.error(
      `[facturas] Tampoco se pudo avisar al admin de la factura ${invoiceNumber}:`,
      error,
    );
    return { cliente: motivo, admin: "error_envio" };
  }
}
