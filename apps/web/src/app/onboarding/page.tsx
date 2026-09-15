"use client";

import { ASSET_VERSION } from "@brainpal/ui";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { AvatarPicker } from "@/components/AvatarPicker";
import { ApiError, api, getPendingName, type Me } from "@/lib/api";

type Step = "family" | "child" | "avatar" | "pals";

interface AddedChild {
  id: string;
  displayName: string;
  joinCode: string;
}

export default function Onboarding() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("family");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [familyName, setFamilyName] = useState("");
  const [parentName, setParentName] = useState("");
  const [childName, setChildName] = useState("");
  const [child, setChild] = useState<AddedChild | null>(null);
  const [mascotId, setMascotId] = useState<string | null>(null);
  const [pals, setPals] = useState<string[]>(["moneypal", "tutorpal"]);

  // Read after mount: localStorage does not exist while this renders on the
  // server, and reading it during render would mismatch the hydration.
  useEffect(() => {
    setParentName(getPendingName());
  }, []);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const createFamily = () =>
    run(async () => {
      try {
        await api.post("/v1/onboarding/family", {
          familyName: familyName.trim(),
          parentName: parentName.trim(),
          currency: "AUD",
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
      } catch (err) {
        // Re-running onboarding with a family already made is not an error.
        if (!(err instanceof ApiError && err.code === "ALREADY_IN_FAMILY")) throw err;
      }
      setStep("child");
    });

  const addChild = () =>
    run(async () => {
      const added = await api.post<{
        member: { id: string; displayName: string };
        joinCode: string;
      }>("/v1/families/current/children", { displayName: childName.trim() });
      setChild({
        id: added.member.id,
        displayName: added.member.displayName,
        joinCode: added.joinCode,
      });
      setStep("avatar");
    });

  const saveAvatar = () =>
    run(async () => {
      if (child && mascotId) {
        await api.post(`/v1/members/${child.id}/avatar`, {
          mascotId,
          style: "colour",
          version: ASSET_VERSION,
        });
      }
      setStep("pals");
    });

  const activatePals = () =>
    run(async () => {
      for (const pal of pals) {
        await api.post(`/v1/pals/${pal}/activate`);
      }
      await api.get<Me>("/v1/me");
      router.push("/home");
    });

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-6 px-6 py-10">
      <Progress step={step} />

      {step === "family" ? (
        <Card title="Set up your family">
          <label className="block space-y-2">
            <span className="text-sm font-medium">Family name</span>
            <input
              value={familyName}
              onChange={(e) => setFamilyName(e.target.value)}
              placeholder="Bhangale"
              className="w-full rounded-xl border border-line bg-ground px-4 py-3 outline-none focus:border-accent"
            />
          </label>
          <label className="block space-y-2">
            <span className="text-sm font-medium">Your name</span>
            <input
              value={parentName}
              onChange={(e) => setParentName(e.target.value)}
              placeholder="Harshal"
              className="w-full rounded-xl border border-line bg-ground px-4 py-3 outline-none focus:border-accent"
            />
          </label>
          <Primary
            onClick={createFamily}
            disabled={
              busy || familyName.trim().length < 1 || parentName.trim().length < 1
            }
          >
            Create family
          </Primary>
        </Card>
      ) : null}

      {step === "child" ? (
        <Card title="Add your first child">
          <input
            value={childName}
            onChange={(e) => setChildName(e.target.value)}
            placeholder="Maya"
            className="w-full rounded-xl border border-line bg-ground px-4 py-3 outline-none focus:border-accent"
          />
          <Primary onClick={addChild} disabled={busy || childName.trim().length < 1}>
            Add child
          </Primary>
        </Card>
      ) : null}

      {step === "avatar" && child ? (
        <Card title={`Pick ${child.displayName}'s avatar`}>
          <AvatarPicker
            name={child.displayName}
            selected={mascotId}
            onSelect={setMascotId}
          />
          <div className="rounded-xl bg-ground px-4 py-3 text-sm">
            <p className="text-muted">
              {child.displayName}&rsquo;s join code — they enter this on their own
              device.
            </p>
            <p className="mt-1 font-mono text-xl tracking-[0.3em]">
              {child.joinCode}
            </p>
          </div>
          <Primary onClick={saveAvatar} disabled={busy || !mascotId}>
            Save avatar
          </Primary>
        </Card>
      ) : null}

      {step === "pals" ? (
        <Card title="Which PALs should your family use?">
          {[
            { id: "moneypal", name: "MoneyPAL", blurb: "Saving, chores and pocket money." },
            { id: "tutorpal", name: "TutorPAL", blurb: "Homework, revision and quizzes." },
          ].map((pal) => {
            const on = pals.includes(pal.id);
            return (
              <button
                key={pal.id}
                type="button"
                onClick={() =>
                  setPals((current) =>
                    on ? current.filter((p) => p !== pal.id) : [...current, pal.id],
                  )
                }
                aria-pressed={on}
                className={`w-full rounded-xl border-2 px-4 py-3 text-left ${
                  on ? "border-accent bg-card" : "border-line"
                }`}
              >
                <span className="block font-medium">{pal.name}</span>
                <span className="block text-sm text-muted">{pal.blurb}</span>
              </button>
            );
          })}
          <Primary onClick={activatePals} disabled={busy || pals.length === 0}>
            Finish setup
          </Primary>
        </Card>
      ) : null}

      {error ? (
        <p role="alert" className="rounded-xl bg-card px-4 py-3 text-sm text-accent">
          {error}
        </p>
      ) : null}
    </main>
  );
}

const STEPS: Step[] = ["family", "child", "avatar", "pals"];

function Progress({ step }: { step: Step }) {
  const index = STEPS.indexOf(step);
  return (
    <ol className="flex gap-2" aria-label="Setup progress">
      {STEPS.map((name, i) => (
        <li
          key={name}
          aria-current={i === index ? "step" : undefined}
          className={`h-1.5 flex-1 rounded-full ${
            i <= index ? "bg-accent" : "bg-line"
          }`}
        />
      ))}
    </ol>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4 rounded-2xl bg-card p-6 shadow-sm">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {children}
    </section>
  );
}

function Primary({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-full rounded-xl bg-accent px-4 py-3 font-medium text-white disabled:opacity-50"
    >
      {children}
    </button>
  );
}
