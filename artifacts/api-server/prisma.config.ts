import { defineConfig } from "prisma/config";

const dbUrl = `postgresql://postgres:${process.env.PGPASSWORD}@${process.env.PGHOST || "helium"}:${process.env.PGPORT || 5432}/${process.env.PGDATABASE || "heliumdb"}`;

export default defineConfig({
  earlyAccess: true,
  schema: "./prisma/schema.prisma",
  datasource: {
    url: dbUrl,
  },
});
