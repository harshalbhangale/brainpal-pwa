import { z } from "zod";

/**
 * Avatars are presentation only. They never carry permissions, memory or
 * financial authority.
 *
 * Identifiers are stored, never asset URLs, so the catalog can be re-skinned or
 * re-hosted without a data migration. `version` pins which asset generation a
 * selection was made against.
 */

export const AvatarStyle = z.enum([
  "colour",
  "ink",
  "sketch",
  "riso",
  "paper",
  "pixel",
]);
export type AvatarStyle = z.infer<typeof AvatarStyle>;

export const AvatarSelection = z.object({
  mascotId: z.string().min(2).max(32),
  style: AvatarStyle,
  version: z.int().positive(),
});
export type AvatarSelection = z.infer<typeof AvatarSelection>;

/** Presentation states the wrapper maps PAL activity onto. */
export const AvatarState = z.enum([
  "idle",
  "thinking",
  "speaking",
  "success",
  "error",
]);
export type AvatarState = z.infer<typeof AvatarState>;
