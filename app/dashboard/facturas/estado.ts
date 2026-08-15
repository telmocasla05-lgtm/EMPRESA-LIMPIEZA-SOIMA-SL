// Estado visible de una factura.
//
// En la base hay dos columnas: `status` (borrador / emitida / anulada) y
// `paid_at` (cuándo se cobró). El panel las junta en un solo estado, que es
// como lo piensa quien factura: borrador → emitida → cobrada.

import { madridToday } from "@/lib/dates";

export type EstadoFactura = "borrador" | "emitida" | "cobrada" | "anulada";

export type FacturaEstado = {
  status: string;
  paid_at: string | null;
  due_date?: string | null;
};

export function estadoDeFactura(factura: FacturaEstado): EstadoFactura {
  if (factura.status === "anulada") return "anulada";
  if (factura.status === "borrador") return "borrador";
  return factura.paid_at ? "cobrada" : "emitida";
}

// Emitida, sin cobrar y pasada la fecha de vencimiento.
export function estaVencida(factura: FacturaEstado): boolean {
  return (
    estadoDeFactura(factura) === "emitida" &&
    !!factura.due_date &&
    factura.due_date < madridToday()
  );
}

export const ETIQUETA_ESTADO: Record<EstadoFactura, string> = {
  borrador: "Borrador",
  emitida: "Emitida",
  cobrada: "Cobrada",
  anulada: "Anulada",
};

export const TONO_ESTADO: Record<EstadoFactura, "ok" | "warn" | "off"> = {
  borrador: "warn",
  emitida: "off",
  cobrada: "ok",
  anulada: "off",
};
