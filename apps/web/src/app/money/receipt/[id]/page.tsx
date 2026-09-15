"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { ApiError, api, hasSignedIn, moneyCommand, type Me, type Receipt } from "@/lib/api";

const aud = (minor: number) => `$${(Math.abs(minor) / 100).toFixed(2)}`;

export default function ReceiptPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [who, r] = await Promise.all([api.get<Me>("/v1/me"), api.get<Receipt>(`/v1/money/receipts/${id}`)]);
    setMe(who);
    setReceipt(r);
  }, [id]);

  useEffect(() => {
    if (!hasSignedIn()) {
      router.replace("/login");
      return;
    }
    load().catch((err) => {
      if (err instanceof ApiError && err.status === 401) router.replace("/login");
      else setError(err instanceof ApiError ? err.message : "Could not load this receipt.");
    });
  }, [load, router]);

  const parent = me?.role === "parent" || me?.role === "co_guardian";
  const reversible = parent && receipt?.status === "settled" && receipt.kind !== "reversal";

  async function reverse() {
    setBusy(true);
    setError(null);
    try {
      const outcome = await moneyCommand("money.reverse", { transactionId: id, reason: reason.trim() });
      setNotice("Reversed. The money has been put back.");
      const reversalId = outcome.result?.["transactionId"];
      if (typeof reversalId === "string") router.push(`/money/receipt/${reversalId}`);
      else await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That did not work. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-5 px-5 py-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Receipt</h1>
        <Link href="/money" className="text-sm text-muted underline underline-offset-4">
          Back to Money
        </Link>
      </header>

      {notice ? <p className="rounded-xl bg-card px-4 py-3 text-sm text-money">{notice}</p> : null}
      {error ? (
        <p role="alert" className="rounded-xl bg-card px-4 py-3 text-sm text-accent">
          {error}
        </p>
      ) : null}

      {receipt ? (
        <section className="space-y-4 rounded-2xl bg-card p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm text-muted">{receipt.receiptNumber}</p>
              <p className="text-lg font-semibold">{receipt.title}</p>
              <p className="text-sm text-muted">{new Date(receipt.createdAt).toLocaleString("en-AU")}</p>
            </div>
            <span
              className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${
                receipt.status === "reversed" ? "bg-ground text-accent" : "bg-ground text-money"
              }`}
            >
              {receipt.status === "reversed" ? "Reversed" : "Settled"}
            </span>
          </div>

          <p className="text-3xl font-semibold">{aud(receipt.amountMinor)}</p>

          <ul className="space-y-2">
            {receipt.lines.map((line, index) => (
              <li key={index} className="flex justify-between rounded-xl bg-ground px-4 py-3 text-sm">
                <span>{line.account}</span>
                <span className={line.direction === "credit" ? "text-money" : "text-accent"}>
                  {line.direction === "credit" ? "+" : "−"}
                  {aud(line.amountMinor)}
                </span>
              </li>
            ))}
          </ul>

          {receipt.reason ? <p className="text-sm text-muted">Reason: {receipt.reason}</p> : null}
          {receipt.reversesTransactionId ? (
            <Link href={`/money/receipt/${receipt.reversesTransactionId}`} className="block text-sm underline underline-offset-4">
              See the original
            </Link>
          ) : null}
          {receipt.reversedByTransactionId ? (
            <Link href={`/money/receipt/${receipt.reversedByTransactionId}`} className="block text-sm underline underline-offset-4">
              See the reversal
            </Link>
          ) : null}
        </section>
      ) : null}

      {reversible ? (
        <section className="space-y-3 rounded-2xl bg-card p-5 shadow-sm">
          <h2 className="text-sm font-medium">Reverse this</h2>
          <p className="text-sm text-muted">
            Puts the money back where it came from. It only works if the money has not been spent.
          </p>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why? e.g. sent by mistake"
            className="w-full rounded-xl border border-line bg-ground px-3 py-2 outline-none focus:border-accent"
          />
          <button
            type="button"
            disabled={busy || reason.trim().length === 0}
            onClick={() => void reverse()}
            className="rounded-xl bg-accent px-4 py-2 font-medium text-white disabled:opacity-40"
          >
            Reverse {receipt ? aud(receipt.amountMinor) : ""}
          </button>
        </section>
      ) : null}
    </main>
  );
}
