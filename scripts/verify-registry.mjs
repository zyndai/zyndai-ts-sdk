// Verifies that every framework declared in src/templates/frameworks.ts has a
// matching .tpl file on disk, and vice versa (no orphan templates).
// Also checks that the shared service/payload templates exist for each
// language.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const src = fs.readFileSync(
  path.join(root, "src/templates/frameworks.ts"),
  "utf-8",
);

function arr(name) {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*\\[([^\\]]+)\\]`, "s");
  const m = src.match(re);
  if (!m) throw new Error(`Could not find ${name} in frameworks.ts`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

const tsOrder = arr("TS_FRAMEWORK_ORDER");
const pyOrder = arr("PY_FRAMEWORK_ORDER");

let failures = 0;
const shared = new Set(["service", "payload"]);

function checkSet(lang, order) {
  console.log(`\n[${lang}] registry lists: ${order.join(", ")}`);
  const ext = lang === "ts" ? "ts.tpl" : "py.tpl";
  for (const fw of order) {
    const rel = `${lang}/${fw.replace(/-/g, "_")}.${ext}`;
    const abs = path.resolve(root, "src/templates", rel);
    const ok = fs.existsSync(abs);
    console.log(`  ${ok ? "OK  " : "MISS"}  ${rel}`);
    if (!ok) failures++;
  }
  for (const base of ["service", "payload"]) {
    const rel = `${lang}/${base}.${ext}`;
    const abs = path.resolve(root, "src/templates", rel);
    const ok = fs.existsSync(abs);
    console.log(`  ${ok ? "OK  " : "MISS"}  ${rel}`);
    if (!ok) failures++;
  }
}

checkSet("ts", tsOrder);
checkSet("py", pyOrder);

console.log();
for (const lang of ["ts", "py"]) {
  const order = lang === "ts" ? tsOrder : pyOrder;
  const orderSet = new Set(order.map((s) => s.replace(/-/g, "_")));
  const dir = path.resolve(root, "src/templates", lang);
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".tpl")) continue;
    const base = f.replace(/\.(ts|py)\.tpl$/, "");
    if (shared.has(base)) continue;
    if (!orderSet.has(base)) {
      console.log(`ORPHAN: ${lang}/${f} (no registry entry)`);
      failures++;
    }
  }
}

if (failures === 0) {
  console.log("\nAll registry entries resolve to a template; no orphans.");
} else {
  console.log(`\n${failures} failure(s).`);
}
process.exit(failures);
