import { detectAndNotifyAbsences } from "@/lib/shifts/absences";
import { createAdminClient } from "@/lib/supabase/admin";

// Detección de ausencias cada 15 minutos (vercel.json): turnos empezados hace
// más de 20 minutos sin fichaje de entrada. Registra la ausencia y avisa por
// WhatsApp al teléfono de la company, sin avisar dos veces por la misma.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[ausencias] Falta CRON_SECRET: cron de ausencias deshabilitado");
    return new Response("Configuración incompleta", { status: 500 });
  }

  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("No autorizado", { status: 401 });
  }

  const result = await detectAndNotifyAbsences(createAdminClient());
  console.log(
    `[ausencias] Pasada del ${result.date}: ${result.detected} detectadas, ${result.notified} avisadas, ${result.failed} fallidas`,
  );
  return Response.json(result);
}
