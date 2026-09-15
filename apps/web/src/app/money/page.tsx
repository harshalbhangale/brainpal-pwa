"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import {
  ApiError,
  api,
  hasSignedIn,
  moneyCommand,
  type Approval,
  type Chore,
  type Me,
  type Wallet,
} from "@/lib/api";

const aud = (minor: number) => `$${(minor / 100).toFixed(2)}`;
const toMinor = (dollars: string) => Math.round(Number(dollars) * 100);

const STATUS_LABEL: Record<Chore["status"], string> = {
  open: "To do",
  submitted: "Waiting for a parent",
  redo: "Needs another go",
  paid: "Paid",
  cancelled: "Cancelled",
};

const card = "space-y-3 rounded-2xl bg-card p-5 shadow-sm";
const input = "w-full rounded-xl border border-line bg-ground px-3 py-2 outline-none focus:border-accent";
const primary = "rounded-xl bg-accent px-4 py-2 font-medium text-white disabled:opacity-40";
const secondary = "rounded-xl border border-line px-4 py-2 font-medium disabled:opacity-40";

export default function Money() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [chores, setChores] = useState<Chore[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [topup, setTopup] = useState("20");
  const [choreChild, setChoreChild] = useState("");
  const [choreTitle, setChoreTitle] = useState("");
  const [choreReward, setChoreReward] = useState("5");
  const [choreDest, setChoreDest] = useState<"spend" | "save">("spend");

  const parent = me?.role === "parent" || me?.role === "co_guardian";

  const load = useCallback(async () => {
    const who = await api.get<Me>("/v1/me");
    setMe(who);
    const [w, c] = await Promise.all([
      api.get<Wallet>("/v1/money/wallet"),
      api.get<{ chores: Chore[] }>("/v1/money/chores"),
    ]);
    setWallet(w);
    setChores(c.chores);
    setChoreChild((current) => current || w.children[0]?.memberId || "");
    if (who.role !== "child") {
      setApprovals((await api.get<{ approvals: Approval[] }>("/v1/money/approvals")).approvals);
    }
  }, []);

  useEffect(() => {
    if (!hasSignedIn()) {
      router.replace("/login");
      return;
    }
    load().catch((err) => {
      if (err instanceof ApiError && err.status === 401) router.replace("/login");
      else setError(err instanceof ApiError ? err.message : "Could not load money.");
    });
  }, [load, router]);

  async function act(fn: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(success);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That did not work. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  const nameOf = (memberId: string) =>
    wallet?.children.find((c) => c.memberId === memberId)?.displayName ?? "Someone";

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-5 px-5 py-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Money</h1>
        <Link href="/home" className="text-sm text-muted underline underline-offset-4">
          Back home
        </Link>
      </header>

      {notice ? <p className="rounded-xl bg-card px-4 py-3 text-sm text-money">{notice}</p> : null}
      {error ? (
        <p role="alert" className="rounded-xl bg-card px-4 py-3 text-sm text-accent">
          {error}
        </p>
      ) : null}

      {wallet ? (
        <section className={card}>
          {parent && wallet.familyWalletMinor !== undefined ? (
            <div>
              <p className="text-sm text-muted">Family wallet</p>
              <p className="text-3xl font-semibold">{aud(wallet.familyWalletMinor)}</p>
            </div>
          ) : null}
          <ul className="space-y-2">
            {wallet.children.map((child) => (
              <li key={child.memberId} className="flex items-center justify-between rounded-xl bg-ground px-4 py-3">
                <span className="font-medium">{child.displayName}</span>
                <span className="text-sm text-muted">
                  Spend <strong className="text-ink">{aud(child.spendMinor)}</strong> · Save{" "}
                  <strong className="text-ink">{aud(child.saveMinor)}</strong>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {parent && approvals.length > 0 ? (
        <section className={card}>
          <h2 className="text-sm font-medium">Needs you</h2>
          {approvals.map((approval) => (
            <div key={approval.id} className="space-y-2 rounded-xl bg-ground p-4">
              <p className="font-medium">{approval.display?.title}</p>
              <p className="text-sm text-muted">{approval.display?.detail}</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  className={primary}
                  onClick={() =>
                    void act(
                      () => api.post(`/v1/money/approvals/${approval.id}`, { decision: "approve" }),
                      "Approved and paid.",
                    )
                  }
                >
                  {approval.display?.confirmLabel ?? "Approve"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className={secondary}
                  onClick={() => {
                    const note = window.prompt("What needs another go?") ?? undefined;
                    void act(
                      () =>
                        api.post(`/v1/money/approvals/${approval.id}`, {
                          decision: "reject",
                          ...(note ? { note } : {}),
                        }),
                      "Sent back for a redo.",
                    );
                  }}
                >
                  {approval.display?.cancelLabel ?? "Decline"}
                </button>
              </div>
            </div>
          ))}
        </section>
      ) : null}

      <section className={card}>
        <h2 className="text-sm font-medium">{parent ? "Chores" : "My chores"}</h2>
        {chores.length === 0 ? <p className="text-sm text-muted">No chores yet.</p> : null}
        {chores.map((chore) => (
          <div key={chore.id} className="flex items-center justify-between gap-3 rounded-xl bg-ground px-4 py-3">
            <div className="min-w-0">
              <p className="font-medium">{chore.title}</p>
              <p className="text-sm text-muted">
                {parent ? `${nameOf(chore.assignedMemberId)} · ` : ""}
                {aud(chore.rewardMinor)} to {chore.destination === "save" ? "Save" : "Spend"} ·{" "}
                {STATUS_LABEL[chore.status]}
              </p>
              {chore.status === "redo" && chore.redoNote ? (
                <p className="text-sm text-accent">{chore.redoNote}</p>
              ) : null}
            </div>
            {!parent && (chore.status === "open" || chore.status === "redo") ? (
              <button
                type="button"
                disabled={busy}
                className={primary}
                onClick={() =>
                  void act(
                    () => moneyCommand("chore.submit", { choreId: chore.id }),
                    "Sent to a parent. You get paid once they approve.",
                  )
                }
              >
                Done
              </button>
            ) : null}
          </div>
        ))}
      </section>

      {parent ? (
        <>
          <section className={card}>
            <h2 className="text-sm font-medium">New chore</h2>
            <select value={choreChild} onChange={(e) => setChoreChild(e.target.value)} className={input}>
              {wallet?.children.map((c) => (
                <option key={c.memberId} value={c.memberId}>
                  {c.displayName}
                </option>
              ))}
            </select>
            <input
              value={choreTitle}
              onChange={(e) => setChoreTitle(e.target.value)}
              placeholder="Tidy your room"
              className={input}
            />
            <div className="flex gap-2">
              <input
                value={choreReward}
                onChange={(e) => setChoreReward(e.target.value)}
                inputMode="decimal"
                aria-label="Reward in dollars"
                className={input}
              />
              <select
                value={choreDest}
                onChange={(e) => setChoreDest(e.target.value as "spend" | "save")}
                className={input}
              >
                <option value="spend">to Spend</option>
                <option value="save">to Save</option>
              </select>
            </div>
            <button
              type="button"
              disabled={busy || !choreChild || choreTitle.trim().length === 0}
              className={primary}
              onClick={() =>
                void act(
                  () =>
                    moneyCommand("chore.assign", {
                      childMemberId: choreChild,
                      title: choreTitle.trim(),
                      rewardMinor: toMinor(choreReward),
                      destination: choreDest,
                    }).then(() => setChoreTitle("")),
                  "Chore assigned.",
                )
              }
            >
              Assign chore
            </button>
          </section>

          <section className={card}>
            <h2 className="text-sm font-medium">Top up the family wallet</h2>
            <div className="flex gap-2">
              <input
                value={topup}
                onChange={(e) => setTopup(e.target.value)}
                inputMode="decimal"
                aria-label="Top-up in dollars"
                className={input}
              />
              <button
                type="button"
                disabled={busy || !(toMinor(topup) > 0)}
                className={primary}
                onClick={() =>
                  void act(
                    () => moneyCommand("wallet.topup", { amountMinor: toMinor(topup), title: "Top-up" }),
                    `Added ${aud(toMinor(topup))}.`,
                  )
                }
              >
                Add
              </button>
            </div>
            <p className="text-xs text-muted">Test money only — no real payment provider is connected yet.</p>
          </section>
        </>
      ) : null}
    </main>
  );
}
