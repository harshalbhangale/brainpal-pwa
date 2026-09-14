# BrainPal — Core Idea & Build Plan

<aside>
🧠

BrainPal is one installable family app where specialist AI companions work together. MoneyPAL helps with money. TutorPAL helps with learning. BrainPal coordinates them, while parents remain in control of important decisions.

</aside>

## The idea in simple words

A parent or child should not need to understand which screen, service, or agent is required. They say what they want, and BrainPal takes it to the right PAL.

Examples:

- “Help me save for a bicycle” goes to MoneyPAL.
- “Make a quiz from this worksheet” goes to TutorPAL.
- “Give Maya a reward if she finishes her lesson” begins with TutorPAL, passes through BrainPal to MoneyPAL, and waits for parent approval.

BrainPal should feel like one trusted product—not several disconnected chatbots.

## The people using it

### Parent

The parent sets up the family, controls permissions, approves important actions, reviews progress, and manages money.

### Child

The child sees only their own money, chores, goals, lessons, progress, and approved PALs. The experience changes with age and ability.

## The three layers

### Customer PALs

- **MoneyPAL:** wallet, chores, savings, allowance, Vision Pay, cards and transaction history.
- **TutorPAL:** flashcards, cheatsheets, quizzes, AI interviews, classes, subjects, learning rewards and written-paper analysis.

### BrainPal OS

- Login and onboarding
- BrainPal Orchestrator
- Family identity and roles
- One shared activity feed and threads
- Notifications and “Needs You”
- PAL-to-PAL handoffs

### Platform capabilities

- **Trust and Safety:** checks permissions, age rules, financial limits, child safety and approvals.
- **Memory:** remembers approved facts and preferences with a source, visibility, confidence and expiry.
- **Deterministic engines:** execute money, scheduling and other important actions. Agents may explain and propose, but they do not bypass these engines.

## How the agents work together

```
User request
→ BrainPal understands the intent
→ one PAL owns the task
→ supporting PALs provide typed input when needed
→ Trust and Safety checks the proposal
→ the parent or user confirms important actions
→ a deterministic service executes
→ BrainPal records the result in a thread and audit log
```

PALs do not hold uncontrolled conversations with one another. Every handoff goes through BrainPal, uses a structured payload, and belongs to one shared thread.

## The app

BrainPal launches as a Progressive Web App (PWA). Families can open it from a link, install it on a phone, use camera and microphone features, upload PDFs and images, and receive supported push notifications.

Durable jobs—allowances, document analysis, reminders, agent workflows and money operations—run on the backend, not on the phone. If deeper native access is required later, the PWA can be wrapped with Capacitor without replacing the product.

## Recommended technical foundation

- **Application:** Next.js PWA
- **Avatar system:** `page-mascot` behind a BrainPal-owned avatar component and approved asset catalog
- **Agent framework:** Mastra
- **Model and streaming layer:** Vercel AI SDK
- **Model access:** provider-neutral routing across OpenAI, Anthropic, Google and other supported providers
- **Database:** PostgreSQL with pgvector where useful
- **Files:** private object storage with signed uploads
- **Background jobs:** [Trigger.dev](http://Trigger.dev), SQS or equivalent durable queue
- **Observability:** traces for agent runs, steps, handoffs, tool calls, approvals and failures

## Rules that never change

1. One request has one owning PAL.
2. Agents explain and propose; trusted services execute.
3. Important actions require a clear preview and confirmation.
4. Voice alone never authorises money movement.
5. Balances, permissions and results come from databases—not model memory.
6. Every consequential action is idempotent and auditable.
7. Child data is private, scoped and correctable.
8. TutorPAL may recommend rewards; MoneyPAL owns real-value reward proposals.
9. The PWA must provide a normal screen-based fallback when AI is unavailable.
10. The first release proves a few complete loops before expanding the feature list.

## Delivery phases

The detailed phase pages below turn the vision into independently demoable releases.

1. Foundation and BrainPal OS
2. MoneyPAL Core
3. TutorPAL Core
4. Cross-PAL Rewards and Collaboration
5. Advanced Multimodal Features
6. Production Hardening and Beta

## Product-level success test

BrainPal is working when a parent and child can complete these loops without developer help:

- Parent creates a chore → child submits proof → parent approves → MoneyPAL records the reward.
- Child uploads learning material → TutorPAL creates and runs a useful learning activity → progress is recorded.
- TutorPAL verifies eligible learning → BrainPal requests a MoneyPAL reward proposal → parent approves → the trusted money service records the outcome.
- Every step is visible in one clear thread, with safe failure and retry behavior.

[Phase 5 — Advanced Multimodal Features](BrainPal%20%E2%80%94%20Core%20Idea%20&%20Build%20Plan/Phase%205%20%E2%80%94%20Advanced%20Multimodal%20Features%208d506ace50a74401a85506a64ff06c15.md)

[Phase 3 — TutorPAL Core](BrainPal%20%E2%80%94%20Core%20Idea%20&%20Build%20Plan/Phase%203%20%E2%80%94%20TutorPAL%20Core%20d49f8570cb1c49e983482e309b823aec.md)

[Phase 4 — Cross-PAL Rewards & Collaboration](BrainPal%20%E2%80%94%20Core%20Idea%20&%20Build%20Plan/Phase%204%20%E2%80%94%20Cross-PAL%20Rewards%20&%20Collaboration%20ad9b85b8986844bc8b3803885fdf9243.md)

[Phase 2 — MoneyPAL Core](BrainPal%20%E2%80%94%20Core%20Idea%20&%20Build%20Plan/Phase%202%20%E2%80%94%20MoneyPAL%20Core%20ffb8614b42df457eb44a4461e5391694.md)

[Phase 1 — Foundation & BrainPal OS](BrainPal%20%E2%80%94%20Core%20Idea%20&%20Build%20Plan/Phase%201%20%E2%80%94%20Foundation%20&%20BrainPal%20OS%203abc489fc3f14ed1b1dd70a91d367852.md)

[Phase 6 — Production Hardening & Family Beta](BrainPal%20%E2%80%94%20Core%20Idea%20&%20Build%20Plan/Phase%206%20%E2%80%94%20Production%20Hardening%20&%20Family%20Beta%204b740d4677ec42cda52c997cb9d6c048.md)

[Avatar System — Page Mascot](BrainPal%20%E2%80%94%20Core%20Idea%20&%20Build%20Plan/Avatar%20System%20%E2%80%94%20Page%20Mascot%20c0a8b422ce32427790846a6091185c11.md)