import { MoneyCommand } from "@brainpal/contracts";
import { getDb } from "@brainpal/database";
import {
  MoneyError,
  allowancesFor,
  cardsFor,
  choresFor,
  decideApproval,
  goalsFor,
  historyFor,
  pendingApprovals,
  receiptFor,
  requestsFor,
  submitCommand,
  walletFor,
} from "@brainpal/moneypal";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { ApiError } from "../errors.js";

const STATUS: Record<string, number> = {
  CHILD_CANNOT_MOVE_MONEY: 403,
  CHILD_CANNOT_UNFREEZE: 403,
  CHILD_ONLY: 403,
  CROSS_MEMBER_FORBIDDEN: 403,
  PARENT_ONLY: 403,
  CHORE_NOT_YOURS: 403,
  CHILD_NOT_FOUND: 404,
  CHORE_NOT_FOUND: 404,
  APPROVAL_NOT_FOUND: 404,
  ALLOWANCE_NOT_FOUND: 404,
  TRANSACTION_NOT_FOUND: 404,
  LEDGER_AMOUNT_INVALID: 400,
  INVALID_NUMBER: 400,
  INVALID_PAYLOAD: 400,
  INVALID_TIMEZONE: 400,
  PROVIDER_FAILED: 502,
};

async function money<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof MoneyError) {
      throw new ApiError(STATUS[error.code] ?? 409, error.code, error.message, error.details);
    }
    throw error;
  }
}

const actorOf = (request: FastifyRequest) => ({
  memberId: request.principal.memberId,
  familyId: request.principal.familyId,
  role: request.principal.role,
});

const Decision = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().max(500).optional(),
});

const HistoryQuery = z.object({
  kind: z.string().max(40).optional(),
  q: z.string().max(100).optional(),
  memberId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export async function registerMoneyRoutes(app: FastifyInstance) {
  app.post("/v1/money/commands", async (request) => {
    const key = z.string().min(8).max(128).safeParse(request.headers["idempotency-key"]);
    if (!key.success) {
      throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "an idempotency-key header is required");
    }
    const parsed = MoneyCommand.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_REQUEST", "bad money command", { issues: parsed.error.issues });
    }
    return money(() => submitCommand(getDb(), actorOf(request), parsed.data, key.data));
  });

  app.post("/v1/money/approvals/:id", async (request) => {
    const params = z.object({ id: z.uuid() }).safeParse(request.params);
    if (!params.success) throw new ApiError(404, "APPROVAL_NOT_FOUND", "no such approval");
    const body = Decision.safeParse(request.body);
    if (!body.success) {
      throw new ApiError(400, "INVALID_REQUEST", "bad decision", { issues: body.error.issues });
    }
    return money(() =>
      decideApproval(getDb(), actorOf(request), params.data.id, body.data.decision, body.data.note),
    );
  });

  app.get("/v1/money/wallet", async (request) => money(() => walletFor(getDb(), actorOf(request))));

  app.get("/v1/money/chores", async (request) => ({
    chores: await money(() => choresFor(getDb(), actorOf(request))),
  }));

  app.get("/v1/money/approvals", async (request) => ({
    approvals: await money(() => pendingApprovals(getDb(), actorOf(request))),
  }));

  app.get("/v1/money/goals", async (request) => ({
    goals: await money(() => goalsFor(getDb(), actorOf(request))),
  }));

  app.get("/v1/money/allowances", async (request) => ({
    allowances: await money(() => allowancesFor(getDb(), actorOf(request))),
  }));

  app.get("/v1/money/cards", async (request) => ({
    cards: await money(() => cardsFor(getDb(), actorOf(request))),
  }));

  app.get("/v1/money/requests", async (request) => ({
    requests: await money(() => requestsFor(getDb(), actorOf(request))),
  }));

  app.get("/v1/money/history", async (request) => {
    const query = HistoryQuery.safeParse(request.query);
    if (!query.success) {
      throw new ApiError(400, "INVALID_REQUEST", "bad history query", { issues: query.error.issues });
    }
    return money(() => historyFor(getDb(), actorOf(request), query.data));
  });

  app.get("/v1/money/receipts/:id", async (request) => {
    const params = z.object({ id: z.uuid() }).safeParse(request.params);
    if (!params.success) throw new ApiError(404, "TRANSACTION_NOT_FOUND", "that receipt was not found");
    return money(() => receiptFor(getDb(), actorOf(request), params.data.id));
  });
}
