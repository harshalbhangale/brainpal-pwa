# Phase 6 — Production Hardening & Family Beta

<aside>
🎯

**Goal:** make BrainPal reliable, observable and safe enough for a controlled family beta.

</aside>

## Reliability

- Durable workflows with stored checkpoints
- Retry policies by error type
- Idempotency for every mutation
- Dead-letter handling
- Provider webhook reconciliation
- Upload resume and expiry handling
- Graceful model/provider fallback
- Normal UI fallback when AI is unavailable

## Security and privacy

- Role and family isolation tests
- Least-privilege service accounts
- Encrypted secrets and private files
- Signed, expiring upload/download access
- Retention and deletion controls
- Consent records
- Child-data access audit
- Prompt-injection and malicious-document defenses

## Agent quality

- Version prompts, tools, schemas and workflows
- Curated evaluation sets for each PAL
- Test routing accuracy
- Test tool-selection accuracy
- Test groundedness and unsupported claims
- Test child-safe language
- Test financial-authority boundaries
- Review failed and low-confidence runs

## Observability

Every run should make these questions answerable:

- Who requested it?
- Which PAL owned it?
- What context was supplied?
- Which tools and models were used?
- What handoffs occurred?
- What policy decisions were made?
- Was human approval required?
- Which deterministic command executed?
- What did it cost and how long did it take?
- Can it be safely replayed?

Track:

```
agent_runs
agent_steps
model_calls
tool_calls
handoffs
policy_decisions
approvals
domain_commands
audit_events
```

## Performance and cost

- Model routing by task complexity
- Small/fast models for classification and extraction
- Strong models for teaching and nuanced reasoning
- Cache stable source processing
- Token and latency budgets per workflow
- Queue long document and vision jobs
- Stream progress rather than blocking the interface

## PWA quality

- Install and update behavior
- Camera and microphone permission recovery
- iOS Home Screen testing
- Android Chrome testing
- Poor-network and offline states
- Large-file upload testing
- Push notification permission and fallback inbox
- Accessibility and child-friendly touch targets

## Beta operations

- Invite-only family cohorts
- Support and incident workflow
- Feature flags and kill switches
- Per-family financial and reward caps
- Feedback inside every thread
- Manual review path for disputed outcomes
- Weekly safety and quality review

## Deliverables

- [ ]  Threat model and privacy review
- [ ]  End-to-end authorization suite
- [ ]  Agent evaluation and regression suite
- [ ]  Workflow replay and recovery tools
- [ ]  Dashboards for latency, cost, errors and unsafe outcomes
- [ ]  Feature flags and emergency shutdown controls
- [ ]  Cross-device PWA QA report
- [ ]  Support playbooks
- [ ]  Controlled beta rollout plan
- [ ]  Three consecutive clean end-to-end demo runs

## Beta acceptance

The system can run the core MoneyPAL, TutorPAL and cross-PAL reward loops repeatedly without duplicate effects, data leakage, unexplained decisions or developer intervention. Failures are visible, recoverable and safe.