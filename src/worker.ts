import "dotenv/config";
import { bootstrapWorker } from "./bootstrap/worker.js";

/**
 * Review worker process entry point (`node lib/worker.js`).
 * All composition lives in `bootstrap/worker.ts`.
 */
void bootstrapWorker();
