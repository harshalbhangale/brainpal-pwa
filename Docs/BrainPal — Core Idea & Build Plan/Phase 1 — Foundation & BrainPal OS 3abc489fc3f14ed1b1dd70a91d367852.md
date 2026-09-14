# Phase 1 — Foundation & BrainPal OS

<aside>
🎯

**Goal:** create the installable app and trusted shared foundation that every PAL will reuse.

</aside>

## What the family receives

A parent can sign in, create a family, add a child and activate PALs. A child can join with a code. Both arrive at a role-appropriate Home screen and can start a conversation with BrainPal.

## Product scope

### PWA shell

- Installable Next.js PWA
- Mobile-first responsive layout
- Parent and child Home
- BrainPal composer
- Activity feed and persistent threads
- Needs You inbox
- Family and Settings
- Offline shell, retry states and update prompt

### Login and identity

- Parent sign-in and session handling
- Child family join code
- Parent, co-guardian and child roles
- Server-derived user and family identity
- Secure session storage
- Device/session revocation

### Onboarding

- Core BrainPal setup once per family
- Parent profile and family creation
- Add children and issue join codes
- Activate MoneyPAL and TutorPAL independently
- Resume incomplete onboarding

## Agent foundation

Create the first Mastra workflow:

```
receive turn
→ identify user and family
→ classify intent
→ choose owning PAL
→ load allowed context
→ run Trust checks
→ return a typed UI response
→ write thread event
```

Initially, MoneyPAL and TutorPAL may return simple placeholder responses. The purpose is to prove routing, state, streaming and observability before building domain depth.

## Shared backend modules

- User, family and membership service
- PAL Registry and activation state
- BrainPal Orchestrator
- Thread and activity service
- Needs You service
- Notification outbox
- Agent run and trace storage
- Trust policy interface
- Memory interface

## Minimum data model

```
users
families
family_members
sessions
pal_registry
pal_activations
threads
thread_events
activity_cards
needs_you_items
agent_runs
agent_steps
agent_handoffs
agent_tool_calls
approvals
audit_events
outbox_events
```

## Trust and privacy foundation

- Deny access unless family membership and role are proven
- Pass only task-relevant context to each PAL
- Keep raw child conversations separate from approved memory
- Record tool calls without exposing secrets
- Require explicit confirmation for consequential actions
- Provide delete/correct controls for permitted memory

## Avatar foundation

Use `page-mascot` for lightweight V1 characters, but expose it only through a BrainPal-owned `BrainPalAvatar` wrapper.

- Child selects an approved character and style during onboarding.
- MoneyPAL and TutorPAL use fixed branded mascots.
- Desktop may use pointer-following; mobile uses idle, thinking, speaking, success and error states.
- Sprite sheets are versioned, self-hosted in S3 and delivered through CloudFront.
- Store mascot ID, style and asset version—not arbitrary URLs.
- Respect screen readers and reduced-motion preferences.

See [Avatar System — Page Mascot](Avatar%20System%20%E2%80%94%20Page%20Mascot%20c0a8b422ce32427790846a6091185c11.md) for the component boundary, data model and acceptance test.

## Deliverables

- [ ]  Installable PWA on current Android and iOS versions
- [ ]  BrainPal avatar wrapper and approved mascot catalog
- [ ]  Avatar selection during child onboarding
- [ ]  Parent login and family creation
- [ ]  Child join-code flow
- [ ]  Parent and child Home screens
- [ ]  PAL Registry with MoneyPAL and TutorPAL
- [ ]  Streaming BrainPal composer
- [ ]  Persistent thread and activity primitives
- [ ]  Agent run tracing
- [ ]  Initial Trust and Memory interfaces
- [ ]  CI/CD and separated development, staging and production environments

## Acceptance demo

1. Parent signs in and creates a family.
2. Parent adds Maya and receives a one-time join code.
3. Maya joins from another device.
4. Parent asks BrainPal a money question and is routed to MoneyPAL.
5. Maya asks a learning question and is routed to TutorPAL.
6. Both requests appear as correctly scoped threads.
7. An unauthorised cross-child request is blocked and audited.