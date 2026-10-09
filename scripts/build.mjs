// Bundles the host into dist/. Each entry has its own platform: the main process is Node,
// the preloads run in sandboxed renderers (only `electron` may be required), the card runtime
// and the Dashboard page are plain browser code.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const common = { bundle: true, sourcemap: "linked", logLevel: "warning", target: "es2023", legalComments: "none" };

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/renderer", { recursive: true });

await Promise.all([
  build({ ...common, entryPoints: ["src/main/index.ts"], outfile: "dist/main/index.js", platform: "node", format: "cjs", external: ["electron", "koffi"] }),
  build({ ...common, entryPoints: ["src/preload/card.ts"], outfile: "dist/preload/card.js", platform: "browser", format: "cjs", external: ["electron"] }),
  build({ ...common, entryPoints: ["src/preload/dashboard.ts"], outfile: "dist/preload/dashboard.js", platform: "browser", format: "cjs", external: ["electron"] }),
  build({ ...common, entryPoints: ["src/card-runtime/runtime.ts"], outfile: "dist/card-runtime/runtime.js", platform: "browser", format: "esm", sourcemap: false }),
  build({ ...common, entryPoints: ["src/renderer/dashboard.ts"], outfile: "dist/renderer/dashboard.js", platform: "browser", format: "esm" }),
]);
cpSync("src/renderer/index.html", "dist/renderer/index.html");
cpSync("src/renderer/dashboard.css", "dist/renderer/dashboard.css");
