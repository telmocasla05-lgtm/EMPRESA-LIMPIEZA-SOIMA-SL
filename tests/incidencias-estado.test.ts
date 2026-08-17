import { describe, expect, it } from "vitest";
import {
  HORAS_ESTANCADA,
  SIGUIENTES_ESTADOS,
  notaDeCambioDeEstado,
  resumenIncidencias,
  sinResolver,
} from "@/lib/incidencias/estado";

const AHORA = new Date("2026-08-17T10:00:00Z");

function haceHoras(horas: number): string {
  return new Date(AHORA.getTime() - horas * 60 * 60 * 1000).toISOString();
}

describe("sinResolver", () => {
  it("cuenta abierta y en curso, no resuelta", () => {
    expect(sinResolver("open")).toBe(true);
    expect(sinResolver("in_progress")).toBe(true);
    expect(sinResolver("resolved")).toBe(false);
  });
});

describe("resumenIncidencias", () => {
  it("cuenta las que siguen dando trabajo y las que llevan más de 48 h", () => {
    const resumen = resumenIncidencias(
      [
        { status: "open", created_at: haceHoras(2) },
        { status: "in_progress", created_at: haceHoras(50) },
        { status: "open", created_at: haceHoras(72) },
        // Resuelta y vieja: no cuenta en ninguna de las dos cifras.
        { status: "resolved", created_at: haceHoras(100) },
      ],
      AHORA,
    );

    expect(resumen).toEqual({ abiertas: 3, estancadas: 2 });
  });

  it("no da por estancada la que está justo en el límite", () => {
    const justas = [{ status: "open", created_at: haceHoras(HORAS_ESTANCADA) }];
    expect(resumenIncidencias(justas, AHORA).estancadas).toBe(0);

    const pasadas = [{ status: "open", created_at: haceHoras(HORAS_ESTANCADA + 0.1) }];
    expect(resumenIncidencias(pasadas, AHORA).estancadas).toBe(1);
  });

  it("sin incidencias devuelve ceros", () => {
    expect(resumenIncidencias([], AHORA)).toEqual({ abiertas: 0, estancadas: 0 });
  });
});

describe("notaDeCambioDeEstado", () => {
  it("deja siempre traza del cambio, aunque no se comente nada", () => {
    expect(notaDeCambioDeEstado("open", "in_progress")).toBe("Estado: Abierta → En curso");
    expect(notaDeCambioDeEstado("in_progress", "resolved", "   ")).toBe(
      "Estado: En curso → Resuelta",
    );
  });

  it("añade el comentario del jefe debajo del cambio", () => {
    expect(notaDeCambioDeEstado("open", "resolved", "Carro nuevo entregado")).toBe(
      "Estado: Abierta → Resuelta\nCarro nuevo entregado",
    );
  });
});

describe("SIGUIENTES_ESTADOS", () => {
  it("nunca ofrece el estado en el que ya está", () => {
    for (const [actual, siguientes] of Object.entries(SIGUIENTES_ESTADOS)) {
      expect(siguientes).not.toContain(actual);
    }
  });

  it("permite reabrir una resuelta", () => {
    expect(SIGUIENTES_ESTADOS.resolved).toContain("in_progress");
  });
});
