import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/d1/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url: "./local.db",
  },
});
