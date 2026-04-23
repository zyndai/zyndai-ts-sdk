import { defineConfig } from "tsup";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Recursively copy src/templates/**\/*.tpl into dist/templates/ so the
 * published package ships both the TypeScript and Python scaffolds
 * alongside the CLI. The CLI resolves them at
 * `path.resolve(__dirname, "..", "templates")` — i.e. dist/templates/.
 * Subfolder structure is preserved: dist/templates/ts/, dist/templates/py/.
 */
function copyTemplates() {
  const src = path.resolve("src/templates");
  const dest = path.resolve("dist/templates");
  if (!fs.existsSync(src)) return;

  function walk(inDir: string, outDir: string) {
    fs.mkdirSync(outDir, { recursive: true });
    for (const entry of fs.readdirSync(inDir, { withFileTypes: true })) {
      const inPath = path.join(inDir, entry.name);
      const outPath = path.join(outDir, entry.name);
      if (entry.isDirectory()) {
        walk(inPath, outPath);
      } else if (entry.isFile() && entry.name.endsWith(".tpl")) {
        fs.copyFileSync(inPath, outPath);
      }
    }
  }
  walk(src, dest);
}

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    outDir: "dist",
  },
  {
    entry: ["src/cli/index.ts"],
    format: ["cjs"],
    banner: { js: "#!/usr/bin/env node" },
    outDir: "dist/cli",
    sourcemap: true,
    noExternal: [/.*/],
    platform: "node",
    async onSuccess() {
      copyTemplates();
    },
  },
]);
