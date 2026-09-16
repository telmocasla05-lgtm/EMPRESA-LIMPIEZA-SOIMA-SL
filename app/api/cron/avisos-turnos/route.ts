import { madridHourOf } from "@/lib/dates";
import { notifyTomorrowShifts } from "@/lib/shifts/notify";
import { createAdminClient } from "@/lib/supabase/admin";

// Aviso diario de turnos de mañana, al caer la tarde.
//
// Vercel Cron solo programa en UTC y el plan Hobby permite una sola pasada al
// día, así que vercel.json lo lanza a las 18:00 UTC y la hora local cambia con
// el horario de verano: 20:00 en Madrid con CEST y 19:00 con CET. Las dos
// valen para avisar del turno de mañana, así que se aceptan ambas en vez de
// exigir las 20:00 clavadas, que dejaría medio año sin avisos.
//
// Con el plan Pro se puede volver a las dos pasadas (18:00 y 19:00 UTC) y
// exigir solo las 20:00. Con ?force=1 (y el secreto) se salta la ventana para
// probar a mano.
const HORAS_VALIDAS = [19, 20];

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
  if (!force && !HORAS_VALIDAS.includes(madridHourOf(new Date()))) {
    return Response.json({
      skipped: true,
      reason: "Fuera de la franja de aviso (19:00-20:00 de Madrid)",
    });
  }

  const result = await notifyTomorrowShifts(createAdminClient());
  console.log(
    `[turnos] Avisos del ${result.date}: ${result.sent} enviados, ${result.failed} fallidos, ${result.skipped} omitidos`,
  );
  return Response.json(result);
}
