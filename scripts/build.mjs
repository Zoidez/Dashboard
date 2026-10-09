// Bundles the host into dist/. Each entry has its own platform: the main process is Node,
// the preloads run in sandboxed renderers (only `electron` may be required), the card runtime
// and the Dashboard page are plain browser code.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { writeIcon } from "./icon.mjs";

const common = { bundle: true, sourcemap: "linked", logLevel: "warning", target: "es2023", legalComments: "none" };

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/renderer", { recursive: true });

await Promise.all([
  build({ ...common, entryPoints: ["src/main/index.ts"], outfile: "dist/main/index.js", platform: "node", format: "cjs", external: ["electron", "koffi"] }),
  build({ ...common, entryPoints: ["src/filehelper/main.ts"], outfile: "dist/filehelper/main.js", platform: "node", format: "cjs", external: ["electron", "koffi"] }),
  build({ ...common, entryPoints: ["src/preload/card.ts"], outfile: "dist/preload/card.js", platform: "browser", format: "cjs", external: ["electron"] }),
  build({ ...common, entryPoints: ["src/preload/dashboard.ts"], outfile: "dist/preload/dashboard.js", platform: "browser", format: "cjs", external: ["electron"] }),
  build({ ...common, entryPoints: ["src/card-runtime/runtime.ts"], outfile: "dist/card-runtime/runtime.js", platform: "browser", format: "esm", sourcemap: false }),
  build({ ...common, entryPoints: ["src/card-runtime/worker-runtime.ts"], outfile: "dist/card-runtime/worker-runtime.js", platform: "browser", format: "esm", sourcemap: false }),
  build({ ...common, entryPoints: ["src/renderer/dashboard.tsx"], outfile: "dist/renderer/dashboard.js", platform: "browser", format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } }),
  build({ ...common, entryPoints: ["src/renderer/options.tsx"], outfile: "dist/renderer/options.js", platform: "browser", format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } }),
  build({ ...common, entryPoints: ["src/preload/options.ts"], outfile: "dist/preload/options.js", platform: "browser", format: "cjs", external: ["electron"] }),
]);
cpSync("src/renderer/index.html", "dist/renderer/index.html");
cpSync("src/renderer/dashboard.css", "dist/renderer/dashboard.css");
cpSync("src/renderer/options.html", "dist/renderer/options.html");
cpSync("src/renderer/options.css", "dist/renderer/options.css");
writeIcon("dist/assets/icon.png");
cpSync("cards", "dist/cards", { recursive: true });   // reference cards that ship with the Dashboard
