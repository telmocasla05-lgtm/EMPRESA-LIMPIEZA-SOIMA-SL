import { describe, expect, it } from "vitest";
import {
  findOverlap,
  slotsOverlap,
  timeToMinutes,
  type ShiftSlot,
} from "@/lib/shifts/overlap";

function slot(partial: Partial<ShiftSlot>): ShiftSlot {
  return {
    worker_id: "worker-1",
    date: "2026-08-03",
    start_time: "09:00",
    end_time: "13:00",
    ...partial,
  };
}

describe("timeToMinutes", () => {
  it("acepta HH:MM y HH:MM:SS (formato de Postgres)", () => {
    expect(timeToMinutes("09:30")).toBe(570);
    expect(timeToMinutes("09:30:00")).toBe(570);
    expect(timeToMinutes("00:00")).toBe(0);
    expect(timeToMinutes("23:59")).toBe(1439);
  });
});

describe("slotsOverlap", () => {
  it("detecta solapamiento parcial", () => {
    expect(
      slotsOverlap(slot({}), slot({ start_time: "12:00", end_time: "15:00" })),
    ).toBe(true);
  });

  it("detecta turno contenido dentro de otro", () => {
    expect(
      slotsOverlap(slot({}), slot({ start_time: "10:00", end_time: "11:00" })),
    ).toBe(true);
  });

  it("detecta turnos idénticos", () => {
    expect(slotsOverlap(slot({}), slot({}))).toBe(true);
  });

  it("permite turnos seguidos (uno acaba cuando empieza el otro)", () => {
    expect(
      slotsOverlap(slot({}), slot({ start_time: "13:00", end_time: "17:00" })),
    ).toBe(false);
  });

  it("compara igual con horas con segundos de la BD", () => {
    expect(
      slotsOverlap(
        slot({ start_time: "09:00:00", end_time: "13:00:00" }),
        slot({ start_time: "13:00", end_time: "17:00" }),
      ),
    ).toBe(false);
    expect(
      slotsOverlap(
        slot({ start_time: "09:00:00", end_time: "13:00:00" }),
        slot({ start_time: "12:59", end_time: "17:00" }),
      ),
    ).toBe(true);
  });

  it("no hay solapamiento entre workers distintos", () => {
    expect(slotsOverlap(slot({}), slot({ worker_id: "worker-2" }))).toBe(false);
  });

  it("no hay solapamiento entre fechas distintas", () => {
    expect(slotsOverlap(slot({}), slot({ date: "2026-08-04" }))).toBe(false);
  });
});

describe("findOverlap", () => {
  const existing = [
    slot({ id: "shift-1" }),
    slot({ id: "shift-2", start_time: "15:00", end_time: "18:00" }),
  ];

  it("devuelve el turno que choca", () => {
    const clash = findOverlap(
      existing,
      slot({ start_time: "12:00", end_time: "16:00" }),
    );
    expect(clash?.id).toBe("shift-1");
  });

  it("devuelve null si no choca ninguno", () => {
    expect(
      findOverlap(existing, slot({ start_time: "13:00", end_time: "15:00" })),
    ).toBeNull();
  });

  it("al editar, el turno no choca consigo mismo", () => {
    expect(
      findOverlap(existing, slot({ id: "shift-1", end_time: "12:00" })),
    ).toBeNull();
  });

  it("al editar, sí choca con los demás", () => {
    const clash = findOverlap(
      existing,
      slot({ id: "shift-1", start_time: "14:00", end_time: "16:00" }),
    );
    expect(clash?.id).toBe("shift-2");
  });
});
