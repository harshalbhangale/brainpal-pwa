import { buildApp } from "./app.js";

const app = await buildApp();
const port = Number(process.env["API_PORT"] ?? 3001);

try {
  await app.listen({ port, host: "127.0.0.1" });
} catch (error) {
  app.log.error(error, "failed to start");
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
