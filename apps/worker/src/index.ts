import { closePool, getDb } from "@brainpal/database";
import { runDueAllowances } from "@brainpal/moneypal";

const INTERVAL_MS = Number(process.env["WORKER_INTERVAL_MS"] ?? 60_000);

let stopping = false;
let wake: (() => void) | undefined;

function log(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ time: new Date().toISOString(), service: "brainpal-worker", ...fields }));
}

async function tick() {
  const reports = await runDueAllowances(getDb());
  for (const report of reports) {
    if (report.outcome !== "skipped") log({ msg: "allowance", ...report });
  }
}

async function main() {
  log({ msg: "started", intervalMs: INTERVAL_MS });
  while (!stopping) {
    try {
      await tick();
    } catch (error) {
      log({ msg: "tick failed", error: error instanceof Error ? error.message : String(error) });
    }
    await new Promise<void>((resolve) => {
      wake = resolve;
      setTimeout(resolve, INTERVAL_MS);
    });
  }
  await closePool();
  log({ msg: "stopped" });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
    wake?.();
  });
}

void main();
