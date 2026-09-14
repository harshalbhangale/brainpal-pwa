# Phase 2 — MoneyPAL Core

<aside>
🎯

**Goal:** prove the complete parent-to-child money loop with a deterministic Money Engine behind MoneyPAL.

</aside>

## Features

### Wallet

- Spend and Save balances
- Parent top-up flow
- Transfers and allocations
- Kid money requests
- Pending, settled, failed and reversed states
- Clear receipts

### Chores

- Parent creates one-off or recurring chores
- Reward, deadline, evidence and destination rules
- Child sees assigned work
- Child submits completion and optional photo proof
- AI may recommend approval with confidence
- Parent makes the final launch decision
- Reward posts only after successful execution

### Savings

- Create a goal with amount and optional date
- Calculate the weekly path
- Move permitted money between Spend and Save
- Show milestones and goal impact
- Parent savings boost

### Allowance

- Parent chooses child, amount, schedule and destination
- Backend scheduler runs allowances
- Failed funding never creates a false success
- Pause, resume and change future allowance

### Card and controls

- Card overview
- Freeze and unfreeze
- Daily limits
- Online, ATM and in-app controls
- Provider-backed states and errors

### Transaction history

- Per-child and family-authorised views
- Search and filters
- Pending, complete, failed and reversed records
- MoneyPAL explanations grounded in ledger data
- Receipts and statements

## MoneyPAL responsibilities

MoneyPAL may:

- explain money in age-appropriate language;
- collect missing information;
- prepare typed proposals;
- compare choices and goal impact;
- explain results returned by the Money Engine.

MoneyPAL may not:

- invent a balance;
- approve its own proposal;
- move money directly;
- silently change a rule;
- execute based only on voice input.

## Command flow

```
User request
→ MoneyPAL prepares typed proposal
→ role and policy validation
→ exact preview
→ parent/user confirmation
→ idempotent Money Engine command
→ ledger/provider result
→ receipt, thread, audit and notification
```

## Core backend records

```
money_accounts
ledger_transactions
ledger_entries
chores
chore_submissions
allowance_schedules
savings_goals
spend_requests
card_controls
provider_events
money_commands
```

All amounts use integer minor units. Every ledger transaction balances. Provider webhooks are idempotent and reconciled.

## Deliverables

- [ ]  Wallet read model
- [ ]  Chore create, submit, review and reward loop
- [ ]  Savings goals and transfers
- [ ]  Backend allowance scheduling
- [ ]  Spend requests
- [ ]  Card-control adapter interface
- [ ]  Transaction history and receipts
- [ ]  Parent approval cards
- [ ]  Policy and idempotency tests
- [ ]  MoneyPAL evaluation dataset

## Acceptance demo

1. Parent creates a $5 chore for Maya.
2. Maya submits evidence.
3. MoneyPAL explains that payment is waiting for approval.
4. Parent approves once.
5. The Money Engine posts balanced entries once, even if the request is retried.
6. Maya sees the updated Spend/Save destination and receipt.
7. A disallowed child payment attempt is blocked with a clear explanation.