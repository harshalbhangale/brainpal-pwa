import { randomUUID } from "node:crypto";

export interface CardChange {
  memberId: string;
  frozen?: boolean | undefined;
  dailyLimitMinor?: number | undefined;
  channel?: { name: "online" | "atm" | "in_app"; enabled: boolean } | undefined;
}

export type CardProviderResult = { ok: true; reference: string } | { ok: false; error: string };

/** The seam a real card issuer plugs into. Every control change goes through `apply`. */
export interface CardProvider {
  readonly name: string;
  apply(change: CardChange): Promise<CardProviderResult>;
}

/** Applies every change at once. No real card exists behind it. */
export class SandboxCardProvider implements CardProvider {
  readonly name = "sandbox";
  async apply(): Promise<CardProviderResult> {
    return { ok: true, reference: `sandbox-${randomUUID()}` };
  }
}

let provider: CardProvider = new SandboxCardProvider();

export function cardProvider(): CardProvider {
  return provider;
}

export function setCardProvider(next: CardProvider): void {
  provider = next;
}
