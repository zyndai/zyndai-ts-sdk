import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);

const required = new Set([
  pkg.main,
  pkg.module,
  pkg.types,
  ...Object.values(pkg.bin ?? {}),
]);

for (const value of Object.values(pkg.exports?.["."] ?? {})) {
  if (typeof value === "string") {
    required.add(value);
  } else if (value && typeof value === "object") {
    for (const nested of Object.values(value)) {
      if (typeof nested === "string") required.add(nested);
    }
  }
}

const missing = [...required]
  .filter(Boolean)
  .map((file) => file.replace(/^\.\//, ""))
  .filter((file) => !fs.existsSync(path.join(root, file)));

if (!Array.isArray(pkg.files) || !pkg.files.includes("dist")) {
  missing.push("package.json files[] entry: dist");
}

if (missing.length > 0) {
  console.error("Package manifest references files that are not ready to publish:");
  for (const file of missing) console.error(`- ${file}`);
  process.exit(1);
}

console.log("Package manifest entrypoints are present in dist/.");
