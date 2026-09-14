"use client";

import { BrainPalAvatar, MASCOTS } from "@brainpal/ui";

export interface AvatarPickerProps {
  name: string;
  selected: string | null;
  onSelect: (mascotId: string) => void;
}

/**
 * A short, vetted grid — not a generator. The chosen character previews at full
 * size so a child sees what they are picking before they commit.
 */
export function AvatarPicker({ name, selected, onSelect }: AvatarPickerProps) {
  return (
    <div className="space-y-6">
      <div className="flex justify-center">
        <BrainPalAvatar
          mascotId={selected}
          style="colour"
          name={name || "You"}
          size="large"
          state={selected ? "success" : "idle"}
          interactive
        />
      </div>

      <ul className="grid grid-cols-3 gap-3">
        {MASCOTS.map((mascot) => {
          const chosen = mascot.id === selected;
          return (
            <li key={mascot.id}>
              <button
                type="button"
                onClick={() => onSelect(mascot.id)}
                aria-pressed={chosen}
                className={`flex w-full flex-col items-center gap-1 rounded-2xl border-2 p-3 transition ${
                  chosen ? "border-accent bg-card" : "border-transparent bg-card"
                }`}
              >
                <BrainPalAvatar
                  mascotId={mascot.id}
                  style="colour"
                  name={mascot.name}
                  size="medium"
                />
                <span className="text-xs text-muted">{mascot.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
