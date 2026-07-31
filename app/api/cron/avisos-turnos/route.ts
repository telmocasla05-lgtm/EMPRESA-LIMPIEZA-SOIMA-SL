import { madridHourOf } from "@/lib/dates";
import { notifyTomorrowShifts } from "@/lib/shifts/notify";
import { createAdminClient } from "@/lib/supabase/admin";

// Aviso diario de turnos a las 20:00 de Madrid. Vercel Cron solo programa en
// UTC, así que vercel.json lo lanza a las 18:00 y 19:00 UTC (CEST/CET) y aquí
// se ejecuta solo la pasada que cae a las 20:00 locales; la otra no hace nada.
// Con ?force=1 (y el secreto) se salta esa ventana para probar a mano.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[turnos] Falta CRON_SECRET: cron de avisos deshabilitado");
    return new Response("Configuración incompleta", { status: 500 });
  }

  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("No autorizado", { status: 401 });
  }

  const force = new URL(request.url).searchParams.get("force") === "1";
  if (!force && madridHourOf(new Date()) !== 20) {
    return Response.json({ skipped: true, reason: "Fuera de las 20:00 de Madrid" });
  }

  const result = await notifyTomorrowShifts(createAdminClient());
  console.log(
    `[turnos] Avisos del ${result.date}: ${result.sent} enviados, ${result.failed} fallidos, ${result.skipped} omitidos`,
  );
  return Response.json(result);
}
