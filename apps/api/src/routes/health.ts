import type { FastifyInstance } from "fastify";

import { SERVICE_NAME, SERVICE_VERSION } from "../app.js";

export async function registerHealthRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({
    status: "ok",
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
  }));
}
