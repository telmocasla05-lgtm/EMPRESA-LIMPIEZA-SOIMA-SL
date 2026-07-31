import { beforeEach, describe, expect, it, vi } from "vitest";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import DashboardPage from "@/app/dashboard/page";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

type ServerClient = Awaited<ReturnType<typeof createClient>>;

function stubClient(user: { email: string } | null): ServerClient {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }),
    },
  } as unknown as ServerClient;
}

describe("DashboardPage", () => {
  beforeEach(() => {
    vi.mocked(redirect).mockClear();
  });

  it("redirige a /login cuando no hay sesión", async () => {
    vi.mocked(createClient).mockResolvedValue(stubClient(null));

    await expect(DashboardPage()).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(redirect).toHaveBeenCalledWith("/login");
  });

  it("no redirige cuando hay sesión", async () => {
    vi.mocked(createClient).mockResolvedValue(
      stubClient({ email: "jefa@ejemplo.com" }),
    );

    await DashboardPage();
    expect(redirect).not.toHaveBeenCalled();
  });
});
