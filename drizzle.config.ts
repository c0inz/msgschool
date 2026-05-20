import type { Config } from "drizzle-kit";

export default {
  schema: "./src/lib/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  // Use a dedicated migrations-tracking table so drizzle-kit doesn't collide
  // with OCMarketplace's existing `drizzle_migrations` on the same DB.
  migrations: {
    table: "ms_drizzle_migrations",
  },
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://CHANGEME:CHANGEME@localhost:5432/msgschool",
  },
} satisfies Config;
