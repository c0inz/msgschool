import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://CHANGEME:CHANGEME@localhost:5432/msgschool";

const pool = new Pool({ connectionString });

export const db = drizzle(pool, { schema });
export * from "./schema";
