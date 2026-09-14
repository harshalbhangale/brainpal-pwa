# Phase 4 — Cross-PAL Rewards & Collaboration

<aside>
🎯

**Goal:** make MoneyPAL and TutorPAL feel like one team without allowing uncontrolled agent conversations or authority leaks.

</aside>

## The handoff rule

Every PAL-to-PAL request goes through BrainPal. One PAL owns the user outcome; supporting PALs return typed results. All steps share one thread and trace.

```
TutorPAL
→ structured handoff to BrainPal
→ Trust and reward-policy check
→ MoneyPAL prepares proposal
→ parent confirmation
→ Money Engine executes
→ verified result returns to the shared thread
```

## Initial cross-PAL use case

A child completes eligible learning work.

TutorPAL records:

- activity and subject;
- duration;
- completion and score;
- hints used;
- independence estimate;
- evidence source;
- confidence.

The Reward Rules service determines eligibility. MoneyPAL receives only the approved facts required to prepare a reward proposal.

## Example handoff

```json
{
  "type": "reward.proposal.requested",
  "fromPal": "tutorpal",
  "toPal": "moneypal",
  "familyId": "family_123",
  "subjectId": "maya",
  "threadId": "thread_123",
  "evidenceId": "evidence_123",
  "requestedOutcome": "learning_reward",
  "idempotencyKey": "learning_reward:evidence_123"
}
```

MoneyPAL returns a proposal—not a payment:

```json
{
  "type": "reward.proposal.created",
  "amountMinor": 200,
  "currency": "AUD",
  "destination": "save",
  "requiresApproval": true
}
```

## Trust controls

- Only verified, eligible evidence may request a reward.
- One evidence record can produce at most one reward.
- Parent-configured caps and schedules apply.
- TutorPAL never receives unnecessary wallet details.
- MoneyPAL does not receive private tutoring conversation content.
- Parent sees the reason, evidence summary, amount and destination.
- Decline, expiry and reversal paths are explicit.

## BrainPal Orchestrator responsibilities

- Maintain one workflow state
- Choose the owning PAL
- Validate the handoff schema and version
- Attach identity, policy and trace context
- Suspend while waiting for approval
- Resume safely from stored state
- Retry technical failures without repeating effects
- Update the shared thread and Needs You

## Deliverables

- [ ]  Versioned Agent Handoff Protocol
- [ ]  Handoff schema validation
- [ ]  TutorPAL learning evidence
- [ ]  Reward Rules service
- [ ]  MoneyPAL reward proposal
- [ ]  Parent approval and expiry
- [ ]  Idempotent Money Engine reward command
- [ ]  Shared cross-PAL thread
- [ ]  End-to-end trace and audit
- [ ]  Replay and failure tests

## Acceptance demo

1. Maya completes an eligible TutorPAL quiz.
2. TutorPAL records learning evidence.
3. BrainPal routes a typed request to MoneyPAL.
4. Parent receives one Needs You approval.
5. Parent approves.
6. The reward posts once to Maya’s selected destination.
7. TutorPAL celebrates only after receiving the verified result.
8. Retrying the workflow creates no duplicate reward.