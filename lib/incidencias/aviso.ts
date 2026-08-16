// Aviso por WhatsApp al responsable de una incidencia recién abierta
// (SPEC-incidencias.md 5.1).
//
// Regla de oro: esto NUNCA tumba el alta. Cuando llegamos aquí la incidencia
// ya está registrada, así que cualquier problema del aviso (tipo sin
// responsable, empresa sin teléfono, Meta caída) se resuelve dejando
// notified_at a null y registrándolo en el log. El panel lo enseña como
// "aviso pendiente".

import { type SupabaseClient } from "@supabase/supabase-js";
import {
  ETIQUETAS_TIPO,
  type TipoIncidencia,
  type UrgenciaIncidencia,
} from "@/lib/incidencias/tipos";
import { urlFirmadaFotoIncidencia } from "@/lib/whatsapp/media";
import { sendWhatsAppText } from "@/lib/whatsapp/send";

// El responsable abre el WhatsApp cuando puede, no en los 60 s de la descarga
// del panel: el enlace de la foto tiene que aguantar hasta que la atienda.
export const DIAS_ENLACE_FOTO = 7;
const SEGUNDOS_ENLACE_FOTO = DIAS_ENLACE_FOTO * 24 * 60 * 60;

export type IncidenciaAvisable = {
  id: string;
  companyId: string;
  workerId: string;
  centerId: string | null;
  tipo: TipoIncidencia;
  urgency: UrgenciaIncidencia;
  description: string | null;
  photoPath: string | null;
};

export type ResultadoAviso = {
  // "sin_destinatario": ni responsable del tipo ni teléfono de empresa.
  estado: "enviado" | "sin_destinatario" | "error_envio";
  // A quién se avisó (o se intentó avisar).
  phone?: string;
  via?: "responsable" | "empresa";
  error?: string;
};

export function mensajeResponsable({
  tipo,
  urgency,
  centro,
  operario,
  descripcion,
  fotoUrl,
}: {
  tipo: TipoIncidencia;
  urgency: UrgenciaIncidencia;
  centro: string | null;
  operario: string | null;
  descripcion: string | null;
  fotoUrl: string | null;
}): string {
  const cabecera =
    urgency === "alta"
      ? `🚨 URGENTE · Incidencia · ${ETIQUETAS_TIPO[tipo]}`
      : `🔧 Incidencia · ${ETIQUETAS_TIPO[tipo]}`;

  const lineas = [cabecera];
  // Sin centro se omite la línea: el jefe lo asigna desde el panel.
  if (centro) lineas.push(centro);
  if (operario) lineas.push(`Operario: ${operario}`);
  lineas.push(descripcion ? `"${descripcion}"` : "(sin descripción todavía)");
  if (fotoUrl) {
    lineas.push(`📷 Foto (el enlace caduca en ${DIAS_ENLACE_FOTO} días): ${fotoUrl}`);
  }

  return lineas.join("\n");
}

// Avisa al responsable del tipo; si no hay, al teléfono de la empresa. Guarda
// a quién se avisó para que el panel pueda distinguir "avisado" de "aviso
// pendiente". No lanza nunca.
export async function avisarResponsable(
  admin: SupabaseClient,
  incidencia: IncidenciaAvisable,
): Promise<ResultadoAviso> {
  try {
    const [destinatario, centro, operario, fotoUrl] = await Promise.all([
      buscarDestinatario(admin, incidencia),
      nombreDelCentro(admin, incidencia.centerId),
      nombreDelOperario(admin, incidencia.workerId),
      enlaceDeLaFoto(admin, incidencia.photoPath),
    ]);

    if (!destinatario) {
      console.error(
        `[incidencias] La incidencia ${incidencia.id} (${incidencia.tipo}) no se ha avisado: ` +
          "el tipo no tiene responsable y la empresa no tiene teléfono",
      );
      return { estado: "sin_destinatario" };
    }

    await sendWhatsAppText(
      destinatario.phone,
      mensajeResponsable({
        tipo: incidencia.tipo,
        urgency: incidencia.urgency,
        centro,
        operario,
        descripcion: incidencia.description,
        fotoUrl,
      }),
    );

    await guardarTraza(admin, incidencia.id, destinatario.phone);

    console.log(
      `[incidencias] Incidencia ${incidencia.id} avisada a ${destinatario.phone} (${destinatario.via})`,
    );
    return { estado: "enviado", phone: destinatario.phone, via: destinatario.via };
  } catch (error) {
    const detalle = error instanceof Error ? error.message : String(error);
    console.error(`[incidencias] No se pudo avisar de la incidencia ${incidencia.id}:`, detalle);
    return { estado: "error_envio", error: detalle };
  }
}

// El responsable del tipo, y si no hay, el teléfono de la empresa (el del
// admin: profiles no guarda teléfono, así que companies.phone es el número por
// el que se localiza a quien manda, mismo criterio que los avisos de factura).
async function buscarDestinatario(
  admin: SupabaseClient,
  incidencia: IncidenciaAvisable,
): Promise<{ phone: string; via: "responsable" | "empresa" } | null> {
  // Una incidencia sin clasificar no tiene responsable natural: va derecha a
  // la empresa, que ya decidirá quién la coge.
  if (incidencia.tipo !== "sin_clasificar") {
    const { data, error } = await admin
      .from("incident_responsibles")
      .select("phone")
      .eq("company_id", incidencia.companyId)
      .eq("type", incidencia.tipo)
      .maybeSingle();

    if (error) {
      console.error(`[incidencias] Error buscando el responsable: ${error.message}`);
    }

    const phone = (data as { phone: string } | null)?.phone?.trim();
    if (phone) return { phone, via: "responsable" };
  }

  const { data, error } = await admin
    .from("companies")
    .select("phone")
    .eq("id", incidencia.companyId)
    .maybeSingle();

  if (error) {
    console.error(`[incidencias] Error buscando el teléfono de la empresa: ${error.message}`);
    return null;
  }

  const phone = (data as { phone: string | null } | null)?.phone?.trim();
  return phone ? { phone, via: "empresa" } : null;
}

async function nombreDelCentro(
  admin: SupabaseClient,
  centerId: string | null,
): Promise<string | null> {
  if (!centerId) return null;

  const { data } = await admin
    .from("centers")
    .select("name")
    .eq("id", centerId)
    .maybeSingle();

  return (data as { name: string } | null)?.name ?? null;
}

async function nombreDelOperario(
  admin: SupabaseClient,
  workerId: string,
): Promise<string | null> {
  const { data } = await admin
    .from("workers")
    .select("full_name")
    .eq("id", workerId)
    .maybeSingle();

  return (data as { full_name: string } | null)?.full_name ?? null;
}

async function enlaceDeLaFoto(
  admin: SupabaseClient,
  photoPath: string | null,
): Promise<string | null> {
  if (!photoPath) return null;

  try {
    return await urlFirmadaFotoIncidencia(admin, photoPath, SEGUNDOS_ENLACE_FOTO);
  } catch (error) {
    // Sin enlace el aviso sigue teniendo valor: tipo, centro y descripción.
    console.error("[incidencias] No se pudo firmar el enlace de la foto:", error);
    return null;
  }
}

async function guardarTraza(admin: SupabaseClient, incidentId: string, phone: string) {
  const { error } = await admin
    .from("incidents")
    .update({ notified_phone: phone, notified_at: new Date().toISOString() })
    .eq("id", incidentId);

  if (error) {
    // El aviso ya salió: perder la traza no justifica reintentarlo (y avisar
    // dos veces al mismo teléfono es peor que no anotarlo).
    console.error(`[incidencias] Aviso enviado pero traza no guardada: ${error.message}`);
  }
}
