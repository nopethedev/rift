#!/usr/bin/env node
// Database helper: picks the Prisma provider from DATABASE_URL, generates the client and applies the schema.
//   sqlite (default)  -> committed SQL migrations (migrate deploy)
//   postgresql/mysql  -> schema sync (db push); migrations are provider specific
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

try { process.loadEnvFile(".env"); } catch {}

let url = process.env.DATABASE_URL || "file:./data/rift.db";
let provider;
if (url.startsWith("file:")) {
  provider = "sqlite";
  const p = url.slice(5).split("?")[0];
  const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
  mkdirSync(path.dirname(abs), { recursive: true });
  url = "file:" + abs;
} else if (/^postgres(ql)?:/.test(url)) provider = "postgresql";
else if (/^(mysql|mariadb):/.test(url)) provider = "mysql";
else { console.error(`Unsupported DATABASE_URL: ${url.split(":")[0]}`); process.exit(1); }

const schemaPath = path.join(root, "prisma/schema.prisma");
const schema = readFileSync(schemaPath, "utf8");
const next = schema.replace(/(datasource db \{\s*provider\s*=\s*")[a-z]+(")/, `$1${provider}$2`);
if (next !== schema) writeFileSync(schemaPath, next);

const env = { ...process.env, DATABASE_URL: url };
const run = (args) => {
  const r = spawnSync("npx", ["prisma", ...args], { stdio: "inherit", env, shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

const cmd = process.argv[2] ?? "setup";
if (cmd === "generate") run(["generate"]);
else if (cmd === "setup") {
  if (!existsSync(path.join(root, "src/generated/prisma"))) run(["generate"]);
  if (provider === "sqlite") run(["migrate", "deploy"]);
  else run(["db", "push", "--skip-generate"]);
} else if (cmd === "migrate-dev") {
  if (provider !== "sqlite") { console.error("migrate-dev is sqlite only"); process.exit(1); }
  run(["migrate", "dev", "--name", process.argv[3] ?? "change"]);
} else { console.error("usage: db.mjs [generate|setup|migrate-dev <name>]"); process.exit(1); }
