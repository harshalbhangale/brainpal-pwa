# Phase 3 — TutorPAL Core

<aside>
🎯

**Goal:** turn approved learning material into useful, persistent and measurable learning experiences.

</aside>

## Features

### Subjects and classes

- Student profile, school year and curriculum
- Subjects and class schedule
- Homework and exam dates
- Learning goals and preferred study times
- Parent-editable context

### Learning material ingestion

- PDF upload
- Photos of worksheets and notes
- YouTube URL with available transcript/captions
- Text extraction and OCR
- Private storage
- Parsed sections and source references

### Flashcards

- Generate cards from a topic or uploaded source
- Edit before saving
- Known, learning and review states
- Spaced-review scheduling
- Previously downloaded deck available offline

### Cheatsheets

- Produce a concise, structured summary from PDFs or available video transcripts
- Preserve source references
- Separate facts from TutorPAL explanations
- Let parent or child correct the result

### Quizzes

- Generate multiple-choice, short-answer and worked-response questions
- Select subject, difficulty and length
- Ground answers in source material
- Explain errors without revealing every answer immediately
- Store attempts, hints and improvement

### AI interview

- Explicit voice or text session
- Adaptive questions
- Speech transcription
- Follow-up based on the child’s answer
- Confidence-aware evaluation
- No background or ambient listening

## TutorPAL learning loop

```
know the student
→ understand the current topic
→ choose an activity
→ teach or ask
→ child responds
→ check understanding
→ record evidence
→ identify the gap
→ recommend the next step
```

## Knowledge boundaries

- Uploaded material is private and family-scoped.
- Generated answers retain source references.
- TutorPAL distinguishes source facts from generated guidance.
- Low-confidence OCR or grading is shown for correction.
- Parents control retention and visibility.
- TutorPAL does not create real-money rewards directly.

## Core backend records

```
student_profiles
subjects
classes
learning_sources
learning_documents
document_sections
flashcard_decks
flashcards
quiz_definitions
quiz_attempts
tutor_sessions
learning_evidence
learning_progress
review_schedule
```

## Deliverables

- [ ]  Student profile and subject setup
- [ ]  Secure PDF and image ingestion
- [ ]  YouTube transcript adapter with fallback messaging
- [ ]  Flashcard generation and review
- [ ]  Cited cheatsheets
- [ ]  Grounded quizzes and attempts
- [ ]  Voice/text AI interview
- [ ]  Progress and next-step view
- [ ]  TutorPAL safety and quality evaluations

## Acceptance demo

1. Parent uploads a maths worksheet.
2. TutorPAL extracts the material and shows any uncertain text.
3. Maya creates flashcards and a five-question quiz.
4. TutorPAL runs the quiz and explains two mistakes.
5. The exact learning evidence and next recommended activity are saved.
6. A different child cannot access Maya’s document or results.