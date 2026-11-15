import "dotenv/config";
import { bootstrapServer } from "./bootstrap/server.js";

/**
 * Probot application process entry point (`node lib/server.js`).
 * All composition lives in `bootstrap/server.ts`.
 */
void bootstrapServer().catch((error) => {
  // Only configuration errors (e.g. invalid env) abort startup; they carry no
  // secret values (validation reports variable names only).
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
