# Avatar System — Page Mascot

<aside>
🦊

**Decision:** use the open-source `page-mascot` package for BrainPal’s lightweight V1 avatar system, wrapped behind a BrainPal-owned component and asset catalog.

</aside>

## Purpose

Avatars make BrainPal feel personal and help families distinguish the child from the PAL that is speaking. They are a presentation layer only: avatars never hold permissions, memory or financial authority.

## Three separate identities

1. **Child avatar:** selected by the child during onboarding.
2. **MoneyPAL mascot:** a fixed, branded MoneyPAL character.
3. **TutorPAL mascot:** a fixed, branded TutorPAL character.

BrainPal itself keeps a consistent product mark so the user can always tell whether BrainPal, a PAL or a family member is represented.

## V1 behavior

The package renders each mascot from two aligned sprite sheets:

- nine viewing directions;
- nine reaction expressions.

Desktop may use pointer-following. Mobile uses explicit states because touch screens do not have a fine pointer:

```
idle → occasional blink
thinking → subtle bounce
speaking → pulse
success → celebration reaction
error → concerned reaction
```

All animation must respect reduced-motion preferences.

## Onboarding experience

```
Choose your avatar
→ select a character
→ select an approved visual style
→ preview idle and tap reactions
→ save selection
```

The initial catalog should stay small: approximately six to twelve approved characters rather than exposing an unlimited generator to children.

## Data model

Store identifiers, not arbitrary asset URLs:

```tsx
type AvatarSelection = {
  mascotId: string;
  style: "colour" | "ink" | "sketch" | "riso" | "paper" | "pixel";
  version: number;
};
```

Suggested fields:

```
family_members.avatar_mascot_id
family_members.avatar_style
family_members.avatar_version
```

## Component boundary

Never use the package directly throughout the product. Create one owned wrapper:

```tsx
<BrainPalAvatar
  avatarId={member.avatarId}
  state="idle"
  size="large"
  label="Maya’s fox avatar"
/>
```

The wrapper owns:

- approved-catalog lookup;
- asset loading and fallback;
- desktop and mobile behavior;
- PAL state mapping;
- accessibility labels;
- reduced motion;
- analytics;
- asset versioning;
- future replacement or lip-sync support.

## Asset delivery

Download and self-host approved sprite sheets. Do not hotlink demo assets.

```
Private source assets
→ optimized WebP sprite sheets
→ S3 versioned asset bucket
→ CloudFront
→ BrainPal PWA
```

Mascot assets are public presentation files, but generation inputs or personal photos—if enabled in the future—must remain private.

## V1 boundaries

Included:

- character and style selection;
- direction and reaction sheets;
- idle, thinking, speaking, success and error states;
- child and PAL avatar components;
- accessible and reduced-motion behavior.

Not included:

- 3D avatars;
- unrestricted child image generation;
- emotional dependence mechanics;
- wealth-based appearance changes;
- avatar-owned memory or permissions;
- full voice lip sync.

## Deliverables

- [ ]  Install and evaluate `page-mascot`
- [ ]  Create the approved mascot catalog
- [ ]  Self-host versioned sprite sheets
- [ ]  Build `BrainPalAvatar`
- [ ]  Add avatar fields to family members
- [ ]  Add onboarding selector and preview
- [ ]  Add MoneyPAL and TutorPAL branded mascots
- [ ]  Add mobile interaction states
- [ ]  Test keyboard, screen reader and reduced motion
- [ ]  Confirm package and generated-asset licensing before launch

## Acceptance demo

1. Maya selects a fox and visual style during onboarding.
2. The selection appears consistently on Kid Home and the family roster.
3. MoneyPAL and TutorPAL remain visually distinct from Maya.
4. The mascot reacts to tap, thinking, speaking and success states.
5. The experience works without pointer tracking on mobile and without animation when reduced motion is enabled.