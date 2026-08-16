import { beforeEach, describe, expect, it, vi } from "vitest";
import { type SupabaseClient } from "@supabase/supabase-js";
import { avisarResponsable, type IncidenciaAvisable } from "@/lib/incidencias/aviso";
import { sendWhatsAppText } from "@/lib/whatsapp/send";

const TELEFONO_EMPRESA = "+34600000000";
const TELEFONO_RESPONSABLE = "+34611111111";

const state = vi.hoisted(() => ({
  // Responsables configurados por la company, por tipo.
  responsables: {} as Record<string, { phone: string }>,
  telefonoEmpresa: null as string | null,
  centro: null as { name: string } | null,
  operario: null as { full_name: string } | null,
  urlFirmada: "https://supabase.example/foto-firmada" as string | null,
}));

const mocks = vi.hoisted(() => ({
  incidentUpdate: vi.fn(),
  createSignedUrl: vi.fn(),
}));

vi.mock("@/lib/whatsapp/send", () => ({
  sendWhatsAppText: vi.fn().mockResolvedValue(undefined),
}));

// El bucket es privado: el enlace de la foto va firmado.
vi.mock("@/lib/whatsapp/media", () => ({
  urlFirmadaFotoIncidencia: async (...args: unknown[]) => {
    mocks.createSignedUrl(...args);
    if (!state.urlFirmada) throw new Error("bucket no disponible");
    return state.urlFirmada;
  },
}));

function adminFalso(): SupabaseClient {
  return {
    from: (table: string) => {
      switch (table) {
        case "incident_responsibles":
          return {
            select: () => ({
              eq: () => ({
                eq: (_columna: string, tipo: string) => ({
                  maybeSingle: async () => ({
                    data: state.responsables[tipo] ?? null,
                    error: null,
                  }),
                }),
              }),
            }),
          };
        case "companies":
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { phone: state.telefonoEmpresa },
                  error: null,
                }),
              }),
            }),
          };
        case "centers":
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: state.centro, error: null }),
              }),
            }),
          };
        case "workers":
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: state.operario, error: null }),
              }),
            }),
          };
        case "incidents":
          return {
            update: (values: unknown) => ({
              eq: async (_columna: string, id: string) => {
                mocks.incidentUpdate({ id, values });
                return { error: null };
              },
            }),
          };
        default:
          throw new Error(`Tabla no esperada en el mock: ${table}`);
      }
    },
  } as unknown as SupabaseClient;
}

function incidencia(cambios: Partial<IncidenciaAvisable> = {}): IncidenciaAvisable {
  return {
    id: "incident-1",
    companyId: "company-1",
    workerId: "worker-1",
    centerId: "center-1",
    tipo: "material_roto",
    urgency: "normal",
    description: "Se ha roto la rueda del carro grande",
    photoPath: null,
    ...cambios,
  };
}

function avisoEnviado(): { to: string; body: string } {
  const calls = vi.mocked(sendWhatsAppText).mock.calls;
  const ultima = calls[calls.length - 1]!;
  return { to: ultima[0], body: ultima[1] };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.responsables = { material_roto: { phone: TELEFONO_RESPONSABLE } };
  state.telefonoEmpresa = TELEFONO_EMPRESA;
  state.centro = { name: "Oficinas Norte" };
  state.operario = { full_name: "Marta Ruiz" };
  state.urlFirmada = "https://supabase.example/foto-firmada";
});

describe("aviso al responsable del tipo", () => {
  it("avisa a quien está configurado para ese tipo", async () => {
    const resultado = await avisarResponsable(adminFalso(), incidencia());

    expect(resultado).toMatchObject({
      estado: "enviado",
      phone: TELEFONO_RESPONSABLE,
      via: "responsable",
    });
    expect(avisoEnviado().to).toBe(TELEFONO_RESPONSABLE);
    expect(sendWhatsAppText).toHaveBeenCalledTimes(1);
  });

  it("el mensaje lleva tipo, centro, operario y descripción", async () => {
    await avisarResponsable(adminFalso(), incidencia());

    expect(avisoEnviado().body).toBe(
      "🔧 Incidencia · Material roto\n" +
        "Oficinas Norte\n" +
        "Operario: Marta Ruiz\n" +
        '"Se ha roto la rueda del carro grande"',
    );
  });

  it("con foto añade el enlace firmado del bucket privado", async () => {
    await avisarResponsable(
      adminFalso(),
      incidencia({ photoPath: "company-1/incident-1/media-1.jpg" }),
    );

    expect(mocks.createSignedUrl).toHaveBeenCalledWith(
      expect.anything(),
      "company-1/incident-1/media-1.jpg",
      // 7 días: el responsable abre el WhatsApp cuando puede.
      7 * 24 * 60 * 60,
    );
    expect(avisoEnviado().body).toContain(
      "📷 Foto (el enlace caduca en 7 días): https://supabase.example/foto-firmada",
    );
  });

  it("una incidencia urgente lleva el prefijo de urgente", async () => {
    state.responsables = { seguridad: { phone: "+34622222222" } };

    await avisarResponsable(
      adminFalso(),
      incidencia({
        tipo: "seguridad",
        urgency: "alta",
        description: "Hay un cable pelado en el pasillo",
      }),
    );

    expect(avisoEnviado().to).toBe("+34622222222");
    expect(avisoEnviado().body).toContain("🚨 URGENTE · Incidencia · Seguridad");
  });

  it("sin centro se omite la línea del centro", async () => {
    await avisarResponsable(adminFalso(), incidencia({ centerId: null }));

    expect(avisoEnviado().body).not.toContain("Oficinas Norte");
    expect(avisoEnviado().body).toContain("Operario: Marta Ruiz");
  });

  it("sin descripción lo dice en vez de dejar la línea vacía", async () => {
    await avisarResponsable(adminFalso(), incidencia({ description: null }));

    expect(avisoEnviado().body).toContain("(sin descripción todavía)");
  });

  it("deja anotado a quién se avisó y cuándo", async () => {
    await avisarResponsable(adminFalso(), incidencia());

    expect(mocks.incidentUpdate).toHaveBeenCalledWith({
      id: "incident-1",
      values: {
        notified_phone: TELEFONO_RESPONSABLE,
        notified_at: expect.any(String),
      },
    });
  });
});

describe("fallback al teléfono de la empresa", () => {
  it("un tipo sin responsable asignado avisa a la empresa", async () => {
    // Hay responsable de material_roto, pero la incidencia es de otro tipo.
    const resultado = await avisarResponsable(
      adminFalso(),
      incidencia({ tipo: "falta_stock", description: "No queda papel" }),
    );

    expect(resultado).toMatchObject({
      estado: "enviado",
      phone: TELEFONO_EMPRESA,
      via: "empresa",
    });
    expect(avisoEnviado().to).toBe(TELEFONO_EMPRESA);
    expect(avisoEnviado().body).toContain("🔧 Incidencia · Falta de stock");
  });

  it("sin ningún responsable configurado avisa a la empresa", async () => {
    state.responsables = {};

    const resultado = await avisarResponsable(adminFalso(), incidencia());

    expect(resultado.via).toBe("empresa");
    expect(avisoEnviado().to).toBe(TELEFONO_EMPRESA);
  });

  it("una incidencia sin clasificar va siempre a la empresa", async () => {
    // Aunque hubiera responsables configurados: sin tipo no hay dueño natural.
    const resultado = await avisarResponsable(
      adminFalso(),
      incidencia({ tipo: "sin_clasificar", description: null }),
    );

    expect(resultado.via).toBe("empresa");
    expect(avisoEnviado().to).toBe(TELEFONO_EMPRESA);
    expect(avisoEnviado().body).toContain("🔧 Incidencia · Sin clasificar");
  });

  it("sin responsable y sin teléfono de empresa no se avisa a nadie, pero no falla", async () => {
    state.responsables = {};
    state.telefonoEmpresa = null;

    const resultado = await avisarResponsable(adminFalso(), incidencia());

    expect(resultado).toEqual({ estado: "sin_destinatario" });
    expect(sendWhatsAppText).not.toHaveBeenCalled();
    // Sin aviso no hay traza: el panel lo enseñará como "aviso pendiente".
    expect(mocks.incidentUpdate).not.toHaveBeenCalled();
  });

  it("un teléfono de empresa en blanco cuenta como no tenerlo", async () => {
    state.responsables = {};
    state.telefonoEmpresa = "   ";

    const resultado = await avisarResponsable(adminFalso(), incidencia());

    expect(resultado.estado).toBe("sin_destinatario");
    expect(sendWhatsAppText).not.toHaveBeenCalled();
  });
});

// Regla de oro: el aviso nunca puede tumbar una incidencia ya registrada.
describe("fallos del aviso", () => {
  it("si WhatsApp falla no lanza y deja la incidencia sin traza", async () => {
    vi.mocked(sendWhatsAppText).mockRejectedValueOnce(new Error("Meta caída"));

    const resultado = await avisarResponsable(adminFalso(), incidencia());

    expect(resultado).toMatchObject({ estado: "error_envio", error: "Meta caída" });
    expect(mocks.incidentUpdate).not.toHaveBeenCalled();
  });

  it("si no se puede firmar la foto, el aviso sale igual sin enlace", async () => {
    state.urlFirmada = null;

    const resultado = await avisarResponsable(
      adminFalso(),
      incidencia({ photoPath: "company-1/incident-1/media-1.jpg" }),
    );

    expect(resultado.estado).toBe("enviado");
    expect(avisoEnviado().body).not.toContain("📷");
    expect(avisoEnviado().body).toContain("Se ha roto la rueda del carro grande");
  });
});
