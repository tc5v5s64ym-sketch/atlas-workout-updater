# Atlas Deload System Specification

> **Status: DRAFT — awaiting owner (Dale) approval.** Single source of truth for what a deload *is* in Atlas. Code follows this spec; if behavior is ever wrong, change this spec first, then the code.

## GOAL

Atlas must not invent deloads. Atlas must select from predefined deload protocols using deterministic rules.

The AI's job is to determine whether a deload is needed.

The rules engine's job is to determine exactly what the deload looks like.

The system must be predictable, testable, explainable, and auditable.

A user should always be able to understand:

* Why a deload was triggered
* Which protocol was selected
* How long it will last
* What will change
* When normal training resumes

---

## CORE PRINCIPLE

A deload is a temporary reduction in fatigue while preserving fitness.

A deload is NOT:

* punishment
* regression
* starting over
* random lighter weights

A deload is a defined training state.

Atlas must distinguish between:

1. Workout Adjustment
2. Recovery Workout
3. Lift-Specific Deload
4. Full-System Deload

Do not jump directly to a full deload when a smaller intervention would solve the problem.

---

## ATLAS TRAINING STATES

```
NORMAL
  ↓
RECOVERY_CANDIDATE
  ↓
DELOAD_RECOMMENDED
  ↓
DELOAD_ACTIVE
  ↓
POST_DELOAD_EVALUATION
  ↓
NORMAL
```

Atlas must track and expose current training state.

---

## FATIGUE DETECTION

Atlas should evaluate fatigue using training exposure, not calendar time.

Track:

* Lift exposures
* Hard sets
* Near-failure sets (RIR 0-1)
* Performance trends
* Recovery trends
* Stalled progress
* User-reported fatigue

Atlas should never trigger a deload from:

* one bad workout
* one missed target
* one low-energy day
* one poor sleep

---

## DELOAD TRIGGER CRITERIA

Create a fatigue score.

Major fatigue signals:

### A. Performance Stagnation

Strength:

* No progress for 3+ exposures

Low-frequency lifter (1-3x/week):

* No progress for 4-6 exposures

Hypertrophy:

* No rep/load/volume progress for 4+ exposures

### B. Performance Regression

* Same weight produces fewer reps
* Estimated strength drops 5%+

### C. RIR Drift

Example:

```
225 x 5 @3
225 x 5 @2
225 x 5 @1
225 x 5 @0
```

Performance stable.
Fatigue increasing.

### D. Multiple Lift Stagnation

Two or more major lifts stall simultaneously.

### E. Recovery Signals

Repeated reports of:

* beat up
* exhausted
* unusually sore
* joint pain
* low motivation

### F. High Fatigue Exposure

* many hard sets
* frequent failure
* long uninterrupted training block

This alone cannot trigger a deload.

---

## ESCALATION LADDER

| Fatigue Score | Action |
|---|---|
| < 50 | Normal coaching |
| 50-75 | Workout adjustment or recovery workout |
| 75-90 | Offer deload |
| > 90 | Recommend deload |

This allows Atlas to scale intervention appropriately.

---

## DELOAD PROTOCOL SELECTION

Atlas must never invent percentages.

Atlas must select a predefined protocol.

---

### PROTOCOL: STRENGTH_DELOAD_V1

Purpose:
Reduce fatigue while preserving strength skill.

Trigger:
Strength-focused training.

Prescription:

```
load_multiplier = 0.92
set_multiplier = 0.50
target_rir = 5
```

Typical:

```
225 x 5 x 5 @2
```

becomes

```
205-210 x 5 x 2-3 @5
```

Duration:

1 exposure minimum
1 week maximum

Exit:

Return immediately to previous working weight.

---

### PROTOCOL: HYPERTROPHY_DELOAD_V1

Purpose:
Reduce fatigue and muscle damage.

Prescription:

```
load_multiplier = 0.85
set_multiplier = 0.50
target_rir = 5
```

Remove:

* failure sets
* drop sets
* rest-pause
* intensity techniques

Duration:

1 week

---

### PROTOCOL: POWER_DELOAD_V1

Purpose:
Preserve speed and explosiveness.

Prescription:

```
load_multiplier = 0.90
set_multiplier = 0.35
target_rir = 4
```

Rule:

Terminate sets when speed declines.

Duration:

1 week

---

### PROTOCOL: ENDURANCE_DELOAD_V1

Purpose:
Reduce accumulated fatigue.

Prescription:

```
load_multiplier = 0.80
set_multiplier = 0.60
target_rir = 5
```

Duration:

1 week

---

## TRAINING FREQUENCY ADJUSTMENT

Users training 1-3x/week:

* Require stronger evidence before deloading
* Require more stalled exposures
* Naturally accumulate less fatigue

Users training 4-6x/week:

* Lower threshold for fatigue accumulation
* Fewer stalled exposures needed

Atlas should evaluate exposure count rather than weeks.

---

## DELOAD STATE

When a deload is activated:

Store:

```
training_state = DELOAD_ACTIVE
deload_protocol
deload_reason
deload_start_date
deload_sessions_remaining
deload_exit_criteria
```

Atlas must remember it is currently in a deload.

Do not generate independent recommendations that conflict with the active deload.

---

## USER COMMUNICATION

Atlas must explicitly tell the user:

* why the deload was triggered
* which protocol was selected
* how many sessions remain
* what changes are being made
* when normal training resumes

Never hide a deload.

---

## POST-DELOAD EVALUATION

After the final deload session:

Enter:

```
POST_DELOAD_EVALUATION
```

Evaluate:

* performance rebound
* recovery improvement
* readiness

If improved:

Return to NORMAL

If not improved:

Do not immediately trigger another deload.

Instead investigate:

* excessive volume
* poor exercise selection
* poor progression model
* inadequate sleep
* inadequate nutrition
* illness
* injury

---

## IMPORTANT RULE

Atlas decides IF a deload is needed.

The protocol determines WHAT the deload is.

Atlas must not generate custom deload percentages or durations from scratch.
Atlas must select from predefined protocols.
