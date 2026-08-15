import { prepararCierreMes, resumenCierre } from "@/lib/billing/cierre";
import { madridToday, monthPeriod, previousMonth } from "@/lib/dates";
import { createAdminClient } from "@/lib/supabase/admin";

// Cierre mensual: el día 1 (vercel.json) deja preparados los borradores de
// todos los clientes de todas las companies para el mes que acaba de terminar
// (SPEC-facturacion.md, sección 6). La emisión sigue siendo manual.
//
// El periodo se calcula con lib/dates (Europe/Madrid), nunca con la hora del
// cron: Vercel programa en UTC y el 05:00 UTC del día 1 son las 06:00 o las
// 07:00 de Madrid, siempre dentro del día 1.
//
// Es idempotente: se puede reejecutar a mano tantas veces como haga falta.
// Con ?periodo=AAAA-MM se cierra un mes concreto (por ejemplo si el cron falló
// y se recupera días después).
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error(
      "[facturacion] Falta CRON_SECRET: cron de facturación deshabilitado",
    );
    return new Response("Configuración incompleta", { status: 500 });
  }

  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("No autorizado", { status: 401 });
  }

  const periodo =
    new URL(request.url).searchParams.get("periodo") ??
    previousMonth(madridToday());

  let periodStart: string;
  let periodEnd: string;
  try {
    ({ periodStart, periodEnd } = monthPeriod(periodo));
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : "Mes no válido",
      { status: 400 },
    );
  }

  const resultado = await prepararCierreMes({
    supabase: createAdminClient(),
    periodStart,
    periodEnd,
  });

  console.log(resumenCierre(resultado));
  return Response.json(resultado);
}
