import "server-only";
import path from "node:path";
import { PrismaClient } from "@/generated/prisma/client";

function createClient(): PrismaClient {
  const url = process.env.DATABASE_URL || "file:./data/rift.db";
  if (url.startsWith("file:")) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaBetterSqlite3 } = require("@prisma/adapter-better-sqlite3");
    const p = url.slice(5).split("?")[0];
    const abs = path.isAbsolute(p) ? p : path.resolve(/*turbopackIgnore: true*/ process.cwd(), p);
    return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: "file:" + abs }) });
  }
  if (/^postgres(ql)?:/.test(url)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaPg } = require("@prisma/adapter-pg");
    return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaMariaDb } = require("@prisma/adapter-mariadb");
  return new PrismaClient({ adapter: new PrismaMariaDb(url) });
}

const g = globalThis as unknown as { __riftDb?: PrismaClient };
export const db: PrismaClient = g.__riftDb ?? (g.__riftDb = createClient());
