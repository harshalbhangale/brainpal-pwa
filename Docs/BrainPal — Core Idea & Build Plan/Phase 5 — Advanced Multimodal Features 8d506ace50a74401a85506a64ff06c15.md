# Phase 5 — Advanced Multimodal Features

<aside>
🎯

**Goal:** add camera, vision, voice and handwriting workflows after the trusted MoneyPAL and TutorPAL foundations work end to end.

</aside>

## Vision Pay

Vision Pay is a camera-based purchase coach—not autonomous payment.

```
capture item
→ barcode/OCR/vision analysis
→ product lookup
→ user confirms identification and price
→ MoneyPAL loads permitted financial facts
→ deterministic impact calculation
→ age-appropriate options
→ ask parent if required
```

### Inputs

- Product photo
- Barcode or QR code
- Label and price OCR
- Optional receipt or shelf label
- User correction

### Output options

- Ask to buy
- Save instead
- Add to wishlist
- Find a lower-cost alternative
- Ask a parent a question

### Safety language

Do not label food as morally good or bad, shame a child, diagnose health, or provide weight-loss advice. Prefer neutral trade-offs:

> “You can choose the chocolate, or keep the $4 toward your bicycle goal.”
> 

Verified nutrition data, allergy context and parent controls are required before giving nutrition-specific guidance.

## Written exam-paper analysis

```
capture pages
→ image cleanup and ordering
→ OCR/handwriting recognition
→ question/answer segmentation
→ rubric or answer-key comparison
→ confidence per item
→ child/parent correction
→ TutorPAL gap analysis and next activity
```

The result is guidance, not an official grade. Low-confidence text and marks must be visible for correction.

## Advanced AI interview

- Longer adaptive voice sessions
- Explicit microphone start/stop
- Streaming transcription
- Interrupt and resume
- Age-appropriate pacing
- Structured learning evidence
- No ambient recording

## PWA implementation strategy

### Preferred path

- Live camera preview with feature detection
- Direct signed uploads to private storage
- Server-side vision, OCR and document processing
- Progress and retry UI

### Fallback

- Standard camera/file capture input
- Manual barcode or price entry
- Resume upload when the app reopens
- Capacitor wrapper only if native reliability becomes necessary

Do not rely on the PWA to execute durable background work. The phone captures input; the backend runs processing and records results.

## Deliverables

- [ ]  Vision Pay camera and upload flow
- [ ]  Barcode/OCR/vision fusion
- [ ]  Product confirmation step
- [ ]  Purchase-impact calculator
- [ ]  Child-safe recommendation policy
- [ ]  Wishlist and Ask Parent flows
- [ ]  Multi-page exam capture
- [ ]  OCR/handwriting correction UI
- [ ]  Rubric-aware paper analysis
- [ ]  Advanced voice interview
- [ ]  Android and iOS device test matrix

## Acceptance demo

1. Maya scans a product.
2. BrainPal identifies it with confidence and asks for confirmation.
3. MoneyPAL shows its price, affordability, goal impact and permitted options.
4. No purchase happens without the required confirmation.
5. Maya captures a written maths paper.
6. TutorPAL highlights uncertain handwriting, accepts corrections, explains gaps and creates a follow-up quiz.