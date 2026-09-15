"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import {
  ApiError,
  api,
  hasSignedIn,
  moneyCommand,
  type Allowance,
  type Approval,
  type CardState,
  type Chore,
  type Goal,
  type History,
  type Me,
  type SpendRequestRow,
  type Wallet,
} from "@/lib/api";

const aud = (minor: number) => `$${(Math.abs(minor) / 100).toFixed(2)}`;
const toMinor = (dollars: string) => Math.round(Number(dollars) * 100);
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const CHORE_LABEL: Record<Chore["status"], string> = {
  open: "To do",
  submitted: "Waiting for a parent",
  redo: "Needs another go",
  paid: "Paid",
  cancelled: "Cancelled",
};

const REQUEST_LABEL: Record<SpendRequestRow["status"], string> = {
  pending: "Waiting for a parent",
  approved: "Approved",
  declined: "Declined",
};

const card = "space-y-3 rounded-2xl bg-card p-5 shadow-sm";
const row = "rounded-xl bg-ground px-4 py-3";
const input = "w-full min-w-0 rounded-xl border border-line bg-ground px-3 py-2 outline-none focus:border-accent";
const primary = "shrink-0 rounded-xl bg-accent px-4 py-2 font-medium text-white disabled:opacity-40";
const secondary = "shrink-0 rounded-xl border border-line px-4 py-2 font-medium disabled:opacity-40";

export default function Money() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [chores, setChores] = useState<Chore[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [allowances, setAllowances] = useState<Allowance[]>([]);
  const [cards, setCards] = useState<CardState[]>([]);
  const [requests, setRequests] = useState<SpendRequestRow[]>([]);
  const [history, setHistory] = useState<History | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [target, setTarget] = useState("");
  const [amount, setAmount] = useState("2");
  const [label, setLabel] = useState("");
  const [reason, setReason] = useState("");
  const [goalDate, setGoalDate] = useState("");
  const [weekday, setWeekday] = useState(5);
  const [spendPercent, setSpendPercent] = useState("70");
  const [limit, setLimit] = useState("50");
  const [search, setSearch] = useState("");

  const parent = me?.role === "parent" || me?.role === "co_guardian";

  const load = useCallback(async (q = "") => {
    const who = await api.get<Me>("/v1/me");
    setMe(who);
    const [w, c, g, a, k, r, h] = await Promise.all([
      api.get<Wallet>("/v1/money/wallet"),
      api.get<{ chores: Chore[] }>("/v1/money/chores"),
      api.get<{ goals: Goal[] }>("/v1/money/goals"),
      api.get<{ allowances: Allowance[] }>("/v1/money/allowances"),
      api.get<{ cards: CardState[] }>("/v1/money/cards"),
      api.get<{ requests: SpendRequestRow[] }>("/v1/money/requests"),
      api.get<History>(`/v1/money/history${q ? `?q=${encodeURIComponent(q)}` : ""}`),
    ]);
    setWallet(w);
    setChores(c.chores);
    setGoals(g.goals);
    setAllowances(a.allowances);
    setCards(k.cards);
    setRequests(r.requests);
    setHistory(h);
    setTarget((current) => current || (who.role === "child" ? who.memberId : (w.children[0]?.memberId ?? "")));
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
      await load(search);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That did not work. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  const nameOf = (memberId: string) =>
    wallet?.children.find((c) => c.memberId === memberId)?.displayName ?? "Someone";
  const cents = toMinor(amount);
  const validAmount = cents > 0;
  const targetAllowance = allowances.find((a) => a.childMemberId === target);

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
          {wallet.children.map((child) => (
            <div key={child.memberId} className={`flex items-center justify-between ${row}`}>
              <span className="font-medium">{child.displayName}</span>
              <span className="text-sm text-muted">
                Spend <strong className="text-ink">{aud(child.spendMinor)}</strong> · Save{" "}
                <strong className="text-ink">{aud(child.saveMinor)}</strong>
              </span>
            </div>
          ))}
        </section>
      ) : null}

      {parent && wallet && wallet.children.length > 1 ? (
        <label className="flex items-center gap-3 text-sm">
          <span className="text-muted">Acting for</span>
          <select value={target} onChange={(e) => setTarget(e.target.value)} className={input}>
            {wallet.children.map((c) => (
              <option key={c.memberId} value={c.memberId}>
                {c.displayName}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {parent && approvals.length > 0 ? (
        <section className={card}>
          <h2 className="text-sm font-medium">Needs you</h2>
          {approvals.map((approval) => (
            <div key={approval.id} className={`space-y-2 ${row}`}>
              <p className="font-medium">{approval.display?.title}</p>
              <p className="text-sm text-muted">{approval.display?.detail}</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  className={primary}
                  onClick={() =>
                    void act(() => api.post(`/v1/money/approvals/${approval.id}`, { decision: "approve" }), "Approved.")
                  }
                >
                  {approval.display?.confirmLabel ?? "Approve"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className={secondary}
                  onClick={() => {
                    const note = approval.kind === "chore.pay" ? (window.prompt("What needs another go?") ?? undefined) : undefined;
                    void act(
                      () => api.post(`/v1/money/approvals/${approval.id}`, { decision: "reject", ...(note ? { note } : {}) }),
                      "Declined.",
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
          <div key={chore.id} className={`flex items-center justify-between gap-3 ${row}`}>
            <div className="min-w-0">
              <p className="font-medium">{chore.title}</p>
              <p className="text-sm text-muted">
                {parent ? `${nameOf(chore.assignedMemberId)} · ` : ""}
                {aud(chore.rewardMinor)} to {chore.destination === "save" ? "Save" : "Spend"} · {CHORE_LABEL[chore.status]}
              </p>
              {chore.status === "redo" && chore.redoNote ? <p className="text-sm text-accent">{chore.redoNote}</p> : null}
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

      <section className={card}>
        <h2 className="text-sm font-medium">{parent ? "Amount for the actions below" : "Amount"}</h2>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          aria-label="Amount in dollars"
          className={input}
        />
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={parent ? "What is it for? (chores, goals)" : "What is it for?"}
          className={input}
        />

        {!parent ? (
          <>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why? (optional)"
              className={input}
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy || !validAmount || label.trim().length === 0}
                className={primary}
                onClick={() =>
                  void act(
                    () =>
                      moneyCommand("spend.request", {
                        amountMinor: cents,
                        title: label.trim(),
                        ...(reason.trim() ? { reason: reason.trim() } : {}),
                      }),
                    "Asked a parent.",
                  )
                }
              >
                Ask to spend {validAmount ? aud(cents) : ""}
              </button>
              <button
                type="button"
                disabled={busy || !validAmount}
                className={secondary}
                onClick={() =>
                  void act(
                    () => moneyCommand("savings.move", { childMemberId: target, direction: "to_save", amountMinor: cents }),
                    "Moved to Save.",
                  )
                }
              >
                Move to Save
              </button>
              <button
                type="button"
                disabled={busy || !validAmount}
                className={secondary}
                onClick={() =>
                  void act(
                    () => moneyCommand("savings.move", { childMemberId: target, direction: "to_spend", amountMinor: cents }),
                    "Asked a parent to move it back to Spend.",
                  )
                }
              >
                Move to Spend
              </button>
            </div>
          </>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || !target || label.trim().length === 0}
              className={primary}
              onClick={() =>
                void act(
                  () =>
                    moneyCommand("chore.assign", {
                      childMemberId: target,
                      title: label.trim(),
                      rewardMinor: validAmount ? cents : 0,
                      destination: "spend",
                    }).then(() => setLabel("")),
                  "Chore assigned.",
                )
              }
            >
              Assign as chore
            </button>
            <button
              type="button"
              disabled={busy || !target || !validAmount}
              className={secondary}
              onClick={() =>
                void act(
                  () => moneyCommand("money.transfer", { childMemberId: target, destination: "spend", amountMinor: cents, title: label.trim() || "Pocket money" }),
                  `Sent ${aud(cents)}.`,
                )
              }
            >
              Send to Spend
            </button>
            <button
              type="button"
              disabled={busy || !target || !validAmount}
              className={secondary}
              onClick={() =>
                void act(() => moneyCommand("savings.boost", { childMemberId: target, amountMinor: cents }), `Boosted Save by ${aud(cents)}.`)
              }
            >
              Boost Save
            </button>
            <button
              type="button"
              disabled={busy || !validAmount}
              className={secondary}
              onClick={() =>
                void act(() => moneyCommand("wallet.topup", { amountMinor: cents, title: "Top-up" }), `Added ${aud(cents)} to the wallet.`)
              }
            >
              Top up wallet
            </button>
          </div>
        )}
        {parent ? <p className="text-xs text-muted">Test money only — no real payment provider is connected yet.</p> : null}
      </section>

      {!parent && requests.length > 0 ? (
        <section className={card}>
          <h2 className="text-sm font-medium">My requests</h2>
          {requests.map((r) => (
            <div key={r.id} className={`flex justify-between gap-3 ${row}`}>
              <span className="min-w-0 truncate">{r.title}</span>
              <span className="shrink-0 text-sm text-muted">
                {aud(r.amountMinor)} · {REQUEST_LABEL[r.status]}
              </span>
            </div>
          ))}
        </section>
      ) : null}

      <section className={card}>
        <h2 className="text-sm font-medium">Savings goals</h2>
        {goals.length === 0 ? <p className="text-sm text-muted">No goals yet.</p> : null}
        {goals.map((goal) => {
          const pct = Math.min(100, Math.round((goal.savedMinor / goal.targetMinor) * 100));
          return (
            <div key={goal.id} className={`space-y-2 ${row}`}>
              <div className="flex justify-between gap-3">
                <span className="font-medium">
                  {goal.title}
                  {parent ? <span className="text-muted"> · {goal.ownerName}</span> : null}
                </span>
                <span className="text-sm text-muted">
                  {aud(goal.savedMinor)} / {aud(goal.targetMinor)}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full bg-money" style={{ width: `${pct}%` }} />
              </div>
              <p className="text-xs text-muted">
                {goal.achieved
                  ? "Reached — nice saving!"
                  : goal.weeklyPathMinor !== null
                    ? `About ${aud(goal.weeklyPathMinor)} a week gets there by ${goal.targetDate}.`
                    : "No date set."}
              </p>
            </div>
          );
        })}
        <div className="flex gap-2">
          <input
            type="date"
            value={goalDate}
            onChange={(e) => setGoalDate(e.target.value)}
            aria-label="Goal date"
            className={input}
          />
          <button
            type="button"
            disabled={busy || !target || !validAmount || label.trim().length === 0}
            className={secondary}
            onClick={() =>
              void act(
                () =>
                  moneyCommand("savings.goal.create", {
                    childMemberId: target,
                    title: label.trim(),
                    targetMinor: cents,
                    ...(goalDate ? { targetDate: goalDate } : {}),
                  }),
                "Goal set.",
              )
            }
          >
            Set as goal
          </button>
        </div>
        <p className="text-xs text-muted">Uses the amount and “what is it for” above.</p>
      </section>

      <section className={card}>
        <h2 className="text-sm font-medium">Allowance</h2>
        {allowances.length === 0 ? <p className="text-sm text-muted">No allowance set.</p> : null}
        {allowances.map((a) => (
          <div key={a.id} className={`space-y-1 ${row}`}>
            <div className="flex justify-between gap-3">
              <span className="font-medium">
                {parent ? `${a.childName} · ` : ""}
                {aud(a.amountMinor)} every {WEEKDAYS[a.weekday]}
              </span>
              <span className="text-sm text-muted">{a.status === "paused" ? "Paused" : "Active"}</span>
            </div>
            <p className="text-xs text-muted">
              {Math.round(a.spendBasisPoints / 100)}% Spend · {100 - Math.round(a.spendBasisPoints / 100)}% Save
              {a.status === "active" ? ` · next ${new Date(a.nextRunAt).toLocaleDateString("en-AU")}` : ""}
            </p>
            {a.lastRun?.status === "failed" ? (
              <p className="text-xs text-accent">
                The payment for {a.lastRun.periodKey} failed — not enough in the family wallet. It will try again.
              </p>
            ) : null}
          </div>
        ))}
        {parent ? (
          <>
            <div className="flex gap-2">
              <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))} className={input} aria-label="Day">
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </select>
              <input
                value={spendPercent}
                onChange={(e) => setSpendPercent(e.target.value)}
                inputMode="numeric"
                aria-label="Percent to Spend"
                className={input}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy || !target || !validAmount}
                className={primary}
                onClick={() =>
                  void act(
                    () =>
                      moneyCommand("allowance.set", {
                        childMemberId: target,
                        amountMinor: cents,
                        weekday,
                        spendBasisPoints: Math.max(0, Math.min(100, Number(spendPercent) || 0)) * 100,
                        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                      }),
                    "Allowance set.",
                  )
                }
              >
                Set {validAmount ? aud(cents) : ""} weekly
              </button>
              {targetAllowance ? (
                <button
                  type="button"
                  disabled={busy}
                  className={secondary}
                  onClick={() =>
                    void act(
                      () => moneyCommand("allowance.pause", { childMemberId: target, paused: targetAllowance.status === "active" }),
                      targetAllowance.status === "active" ? "Allowance paused." : "Allowance resumed.",
                    )
                  }
                >
                  {targetAllowance.status === "active" ? "Pause" : "Resume"}
                </button>
              ) : null}
            </div>
            <p className="text-xs text-muted">Uses the amount above. The number is the percent that goes to Spend.</p>
          </>
        ) : null}
      </section>

      <section className={card}>
        <h2 className="text-sm font-medium">{parent ? "Cards" : "My card"}</h2>
        {cards.map((c) => (
          <div key={c.memberId} className={`space-y-2 ${row}`}>
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium">
                {parent ? `${c.displayName} · ` : ""}
                {c.frozen ? "Frozen" : "Active"}
              </span>
              {parent || !c.frozen ? (
                <button
                  type="button"
                  disabled={busy}
                  className={secondary}
                  onClick={() =>
                    void act(
                      () => moneyCommand("card.freeze", { childMemberId: c.memberId, frozen: !c.frozen }),
                      c.frozen ? "Card unfrozen." : "Card frozen.",
                    )
                  }
                >
                  {c.frozen ? "Unfreeze" : "Freeze"}
                </button>
              ) : (
                <span className="text-xs text-muted">Ask a parent to unfreeze</span>
              )}
            </div>
            <p className="text-xs text-muted">
              {aud(c.dailyLimitMinor)} a day · Online {c.online ? "on" : "off"} · ATM {c.atm ? "on" : "off"} · In-app{" "}
              {c.inApp ? "on" : "off"}
            </p>
            {parent ? (
              <div className="flex flex-wrap gap-2">
                {(["online", "atm", "in_app"] as const).map((channel) => {
                  const on = channel === "in_app" ? c.inApp : c[channel];
                  return (
                    <button
                      key={channel}
                      type="button"
                      disabled={busy}
                      className={secondary}
                      onClick={() =>
                        void act(
                          () => moneyCommand("card.channel", { childMemberId: c.memberId, channel, enabled: !on }),
                          "Card updated.",
                        )
                      }
                    >
                      {on ? "Turn off" : "Turn on"} {channel === "in_app" ? "in-app" : channel.toUpperCase() === "ATM" ? "ATM" : "online"}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        ))}
        {parent ? (
          <div className="flex gap-2">
            <input
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              inputMode="decimal"
              aria-label="Daily limit in dollars"
              className={input}
            />
            <button
              type="button"
              disabled={busy || !target || !(toMinor(limit) >= 0)}
              className={secondary}
              onClick={() =>
                void act(
                  () => moneyCommand("card.limit", { childMemberId: target, dailyLimitMinor: toMinor(limit) }),
                  "Daily limit set.",
                )
              }
            >
              Set daily limit
            </button>
          </div>
        ) : null}
      </section>

      <section className={card}>
        <h2 className="text-sm font-medium">History</h2>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void load(search.trim()).catch(() => setError("Could not search."));
          }}
        >
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search"
            aria-label="Search history"
            className={input}
          />
          <button type="submit" className={secondary}>
            Search
          </button>
        </form>
        {history?.pending.map((p) => (
          <div key={p.requestId} className={`flex justify-between gap-3 ${row}`}>
            <span className="min-w-0 truncate">
              {p.title} {parent ? <span className="text-muted">· {nameOf(p.memberId)}</span> : null}
            </span>
            <span className="shrink-0 text-sm text-muted">{aud(p.amountMinor)} · pending</span>
          </div>
        ))}
        {history?.failed.map((f) => (
          <div key={`${f.memberId}-${f.periodKey}`} className={`flex justify-between gap-3 ${row}`}>
            <span className="min-w-0 truncate">
              Allowance {f.periodKey} {parent ? <span className="text-muted">· {nameOf(f.memberId)}</span> : null}
            </span>
            <span className="shrink-0 text-sm text-accent">{aud(f.amountMinor)} · failed</span>
          </div>
        ))}
        {history && history.items.length === 0 ? <p className="text-sm text-muted">Nothing yet.</p> : null}
        {history?.items.map((item) => (
          <div key={item.transactionId} className={`flex justify-between gap-3 ${row}`}>
            <div className="min-w-0">
              <p className="truncate font-medium">{item.title}</p>
              <p className="text-xs text-muted">
                {new Date(item.createdAt).toLocaleDateString("en-AU")} · {item.lines.map((l) => l.account).join(" → ")}
              </p>
            </div>
            <span className={`shrink-0 font-medium ${item.netMinor < 0 ? "text-accent" : "text-money"}`}>
              {item.netMinor === 0 ? aud(item.amountMinor) : `${item.netMinor < 0 ? "−" : "+"}${aud(item.netMinor)}`}
            </span>
          </div>
        ))}
      </section>
    </main>
  );
}
