import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type SupabaseClient } from "@supabase/supabase-js";
import {
  avisarFacturaEmitida,
  DIAS_ENLACE,
  type ClienteAviso,
  type EmpresaAviso,
} from "@/lib/billing/aviso";
import { sendWhatsAppText } from "@/lib/whatsapp/send";

// Aviso al cliente cuando su factura pasa a emitida. Con dobles: lo que se
// comprueba aquí es a quién se avisa y con qué texto, no la emisión en sí
// (eso está en billing-factura.test.ts, contra Supabase de verdad).

const URL_FIRMADA = "https://supabase.test/storage/facturas/2026-0007.pdf?token=abc";
const PDF_PATH = "company-1/2026/2026-0007.pdf";

const mocks = vi.hoisted(() => ({
  createSignedUrl: vi.fn(),
}));

vi.mock("@/lib/whatsapp/send", () => ({
  sendWhatsAppText: vi.fn().mockResolvedValue(undefined),
}));

const supabase = {
  storage: {
    from: (bucket: string) => {
      if (bucket !== "facturas") {
        throw new Error(`Bucket no esperado en el mock: ${bucket}`);
      }
      return {
        createSignedUrl: (path: string, segundos: number) => {
          mocks.createSignedUrl(path, segundos);
          return Promise.resolve({ data: { signedUrl: URL_FIRMADA }, error: null });
        },
      };
    },
  },
} as unknown as SupabaseClient;

const CLIENTE: ClienteAviso = {
  name: "Clínica Ñora S.L.",
  contact_name: "Ana Ruiz",
  contact_phone: "+34618559210",
};

const EMPRESA: EmpresaAviso = {
  name: "Limpiezas SOIMA S.L.",
  phone: "+34600111222",
};

function avisar(overrides: {
  cliente?: Partial<ClienteAviso>;
  empresa?: Partial<EmpresaAviso>;
  pdfPath?: string | null;
} = {}) {
  return avisarFacturaEmitida({
    supabase,
    cliente: { ...CLIENTE, ...overrides.cliente },
    empresa: { ...EMPRESA, ...overrides.empresa },
    invoiceNumber: "2026/0007",
    totalCentimos: 64796,
    pdfPath: overrides.pdfPath === undefined ? PDF_PATH : overrides.pdfPath,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("avisarFacturaEmitida", () => {
  it("con teléfono: envía al cliente el enlace de descarga del PDF", async () => {
    const resultado = await avisar();

    expect(resultado).toEqual({ cliente: "enviado" });
    expect(sendWhatsAppText).toHaveBeenCalledTimes(1);

    const [telefono, mensaje] = vi.mocked(sendWhatsAppText).mock.calls[0];
    expect(telefono).toBe("+34618559210");
    expect(mensaje).toBe(
      "Hola Ana Ruiz: ya tienes la factura 2026/0007 de Limpiezas SOIMA S.L., por 647,96 €.\n" +
        `Descárgala aquí (el enlace caduca en ${DIAS_ENLACE} días): ${URL_FIRMADA}`,
    );

    // El enlace se firma sobre el PDF de esa factura y dura lo bastante para
    // que el cliente lo abra días después.
    expect(mocks.createSignedUrl).toHaveBeenCalledWith(
      PDF_PATH,
      DIAS_ENLACE * 24 * 60 * 60,
    );
  });

  it("sin teléfono: no falla y avisa al admin de la company", async () => {
    const resultado = await avisar({ cliente: { contact_phone: null } });

    // La factura se queda emitida: esto solo informa de que no salió el aviso.
    expect(resultado).toEqual({ cliente: "sin_telefono", admin: "enviado" });

    // Al cliente no se le manda nada, y no se firma ningún enlace.
    expect(mocks.createSignedUrl).not.toHaveBeenCalled();
    expect(sendWhatsAppText).toHaveBeenCalledTimes(1);
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      "+34600111222",
      "⚠️ La factura 2026/0007 de Clínica Ñora S.L. se emitió correctamente, " +
        "pero no se le pudo enviar por WhatsApp: no tiene teléfono de contacto en su ficha.\n" +
        "Descárgala del panel y envíasela a mano.",
    );
  });

  it("un teléfono en blanco cuenta como no tener teléfono", async () => {
    const resultado = await avisar({ cliente: { contact_phone: "   " } });

    expect(resultado).toEqual({ cliente: "sin_telefono", admin: "enviado" });
  });

  it("si el envío al cliente falla, tampoco rompe: avisa al admin", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(sendWhatsAppText).mockRejectedValueOnce(new Error("WhatsApp API 400"));

    const resultado = await avisar();

    expect(resultado).toEqual({
      cliente: "error_envio",
      admin: "enviado",
      error: "WhatsApp API 400",
    });
    expect(sendWhatsAppText).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sendWhatsAppText).mock.calls[1][0]).toBe("+34600111222");
  });

  it("sin teléfono del cliente ni de la company, queda en el log sin lanzar", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const resultado = await avisar({
      cliente: { contact_phone: null },
      empresa: { phone: null },
    });

    expect(resultado).toEqual({ cliente: "sin_telefono", admin: "sin_telefono" });
    expect(sendWhatsAppText).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });

  it("si la emisión se quedó sin PDF, no manda un enlace roto: avisa al admin", async () => {
    const resultado = await avisar({ pdfPath: null });

    expect(resultado).toEqual({ cliente: "sin_pdf", admin: "enviado" });
    expect(vi.mocked(sendWhatsAppText).mock.calls[0][1]).toContain(
      "la factura se emitió sin PDF",
    );
  });
});
