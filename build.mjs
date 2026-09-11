/* eslint-env node */

import { htmlPlugin as html } from "@craftamap/esbuild-plugin-html";
import { build, context } from "esbuild";
import inlineWorker from "esbuild-plugin-inline-worker";

const buildOptions = {
  entryPoints: ["src/ui.tsx", "src/background-planner.ts"],
  bundle: true,
  platform: "browser",
  target: "es2022",
  minify: true,
  sourcemap: true,
  metafile: true,
  logLevel: "debug",
  outdir: "dist/ui",
  tsconfig: "tsconfig.ui.json",
  loader: { ".svg": "file" },
  define: {
    IS_WEB: (process.env.IS_WEB === "1").toString(),
    "process.env.DEBUG_BIT2ATOM_COMMANDS": JSON.stringify(process.env.DEBUG_BIT2ATOM_COMMANDS ?? ""),
    "process.env.BIT2ATOM_FIFO_DEPTH": JSON.stringify(process.env.BIT2ATOM_FIFO_DEPTH ?? ""),
  },
  plugins: [
    inlineWorker(),
    html({
      files: [
        {
          entryPoints: ["src/ui.tsx"],
          filename: "index.html",
          htmlTemplate: "src/index.html",
          scriptLoading: "defer",
        },
      ],
    }),
  ],
  resolveExtensions: [".mjs", ".js", ".ts", ".tsx", ".svg"],
};

(async () => {
  try {
    if (process.env.BIT2ATOM_HOT_RELOAD) {
      const ctx = await context({
        ...buildOptions,
        banner: { js: "new EventSource('/esbuild').addEventListener('change', () => location.reload());" },
      });
      await ctx.watch();
      const { host, port } = await ctx.serve({ servedir: "dist/ui", port: 9080 });
      console.log(`http://${host}:${port}`);
    } else {
      await build(buildOptions);
      // Copy logo as favicon
      const { cpSync, existsSync, readdirSync } = await import("fs");
      const { join } = await import("path");
      const outDir = buildOptions.outdir;
      if (existsSync(outDir)) {
        const files = readdirSync(outDir);
        const logoFile = files.find(f => f.startsWith("bit2atomLogo") && f.endsWith(".svg"));
        if (logoFile) {
          cpSync(join(outDir, logoFile), join(outDir, "favicon.ico"));
          console.log("favicon.ico created from " + logoFile);
        }
      }
    }
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
})();
