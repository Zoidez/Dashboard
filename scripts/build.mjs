// Bundles the host into dist/. Each entry has its own platform: the main process is Node,
// the preloads run in sandboxed renderers (only `electron` may be required), the card runtime
// and the Dashboard page are plain browser code.
import { build } from "esbuild";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { writeIcon } from "./icon.mjs";

const common = { bundle: true, sourcemap: "linked", logLevel: "warning", target: "es2023", legalComments: "none" };

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/renderer", { recursive: true });

await Promise.all([
  // TypeScript stays external: the validator (V3) needs its lib.*.d.ts files next to it in node_modules.
  build({ ...common, entryPoints: ["src/main/index.ts"], outfile: "dist/main/index.js", platform: "node", format: "cjs", external: ["electron", "koffi", "typescript"] }),
  build({ ...common, entryPoints: ["src/filehelper/main.ts"], outfile: "dist/filehelper/main.js", platform: "node", format: "cjs", external: ["electron", "koffi"] }),
  build({ ...common, entryPoints: ["src/preload/card.ts"], outfile: "dist/preload/card.js", platform: "browser", format: "cjs", external: ["electron"] }),
  build({ ...common, entryPoints: ["src/preload/dashboard.ts"], outfile: "dist/preload/dashboard.js", platform: "browser", format: "cjs", external: ["electron"] }),
  build({ ...common, entryPoints: ["src/card-runtime/runtime.ts"], outfile: "dist/card-runtime/runtime.js", platform: "browser", format: "esm", sourcemap: false }),
  build({ ...common, entryPoints: ["src/card-runtime/worker-runtime.ts"], outfile: "dist/card-runtime/worker-runtime.js", platform: "browser", format: "esm", sourcemap: false }),
  build({ ...common, entryPoints: ["src/renderer/dashboard.tsx"], outfile: "dist/renderer/dashboard.js", platform: "browser", format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } }),
  build({ ...common, entryPoints: ["src/renderer/options.tsx"], outfile: "dist/renderer/options.js", platform: "browser", format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } }),
  build({ ...common, entryPoints: ["src/preload/options.ts"], outfile: "dist/preload/options.js", platform: "browser", format: "cjs", external: ["electron"] }),
  build({ ...common, entryPoints: ["src/preload/canvas.ts"], outfile: "dist/preload/canvas.js", platform: "browser", format: "cjs", external: ["electron"] }),
  build({ ...common, entryPoints: ["src/renderer/canvas.tsx"], outfile: "dist/renderer/canvas.js", platform: "browser", format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } }),
]);
cpSync("src/renderer/index.html", "dist/renderer/index.html");
cpSync("src/renderer/dashboard.css", "dist/renderer/dashboard.css");
cpSync("src/renderer/options.html", "dist/renderer/options.html");
cpSync("src/renderer/options.css", "dist/renderer/options.css");
cpSync("src/renderer/canvas.html", "dist/renderer/canvas.html");
cpSync("src/renderer/canvas.css", "dist/renderer/canvas.css");
// What the generator is given (GENERATOR-PROMPT.md): read from the design docs at build time.
mkdirSync("dist/generator", { recursive: true });
for (const f of ["docs/GENERATOR-PROMPT.md", "docs/RULES.md", "docs/PRESETS.md", "spec/manifest.schema.json"]) cpSync(f, "dist/generator/" + f.split("/").pop());
// .d.ts files are stripped by the packager, so the host API and TypeScript's lib files ship as .txt
// (the validator's type check reads them from here: src/main/validator/typecheck.ts, libDir).
cpSync("spec/host-api.d.ts", "dist/generator/host-api.d.ts.txt");
mkdirSync("dist/ts-lib", { recursive: true });
for (const f of readdirSync("node_modules/typescript/lib")) if (/^lib..*.d.ts$/.test(f)) cpSync("node_modules/typescript/lib/" + f, "dist/ts-lib/" + f + ".txt");
writeIcon("dist/assets/icon.png");
cpSync("cards", "dist/cards", { recursive: true });   // reference cards that ship with the Dashboard
