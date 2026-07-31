import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // El tsconfig usa jsx "preserve" (requisito de Next); aquí hay que
  // transformarlo de verdad para que los .tsx importados sean ejecutables.
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: { "@": root },
  },
  test: {
    environment: "node",
  },
});
