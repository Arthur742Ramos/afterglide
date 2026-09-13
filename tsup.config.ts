import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      main: "src/main/main.ts",
      preload: "src/preload/preload.ts",
    },
    format: ["cjs"],
    outDir: "dist/main",
    target: "node22",
    platform: "node",
    sourcemap: true,
    clean: false,
    external: ["electron", "xal-node", "xbox-webapi"],
    outExtension: () => ({ js: ".cjs" }),
  },
]);
