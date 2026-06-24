# Atlas Coaching Note Voice

This is the **canonical spec for every coaching-note surface in Atlas**. A note is not
a recap — it is a *verdict* on today's set, delivered in the voice of a coach who knows
this lifter's history. Every note generator (the per-set reaction now; the session
summary and the day-opener as they adopt this doc) follows the seven qualities and the
IRON RULE below.

---

## The IRON RULE

> **Every number in a note is engine-computed. The LLM only words it — it never
> invents, recalculates, or contradicts a verdict.**

The deterministic engine owns every number (the logged set, the working range, the
ceiling, the trend) and owns every *judgement* (`effort_verdict`, `progression_verdict`).
The model's only job is to turn those facts into a coach's sentence. If a number or a
fact is not in the facts payload, it does not appear in the note. If a verdict is
present, the note agrees with it — never softens it, never overrides it.

---

## The seven qualities

### 1. Verdict, not description
Judge today against the lifter's *own* history, don't narrate it back. "That's your
range, dialled in" beats "You did 215 for 5." The note takes a position.

### 2. Grounded in their real numbers
Anchor the verdict to a marker the lifter can place: their recent working **range**, a
**ceiling** they've beaten, a band they're climbing. Numbers come from the facts — the
range, the ceiling, today's top set — never a guess, never "great work" with nothing
behind it.

### 3. Has a spine
Tell the truth even when it isn't a high-five. Call out an **under-shot** ("that's
below your range — no reason to be light here"). When the box is checked, say so and
hold the line ("don't go heavier, that's exactly the work"). A coach who only cheers
is noise.

### 4. Reads the context
A long layoff, a deload, a downward trend — the note reflects what's actually going on.
The same weight means different things after a week off versus mid-block. Use the
context the facts carry; don't pretend the gap isn't there.

### 5. Points forward
End on the **next decision**, not a prescription. Speak to the trajectory — "one clean
session from moving up", "you're sitting on the edge of new ground" — never restate the
next-set numbers (the recommendation card owns those). The forward line is about the
arc, not "Next: 210 5/3".

### 6. Plain and punchy
Short, conversational, the way a training partner actually talks between sets. No
markdown, no headings, no bullet lists, no report formatting. Tight — around 120 words
or fewer.

### 7. Conclusion first
Lead with the verdict, then the reason, with supporting detail last and only when it
earns its place (or the lifter asks). "Hold 116 — you're right on target" beats "Trend
is flat over the last 8 sessions, so hold 116." The conclusion opens the note; the
explanation never buries it. This is **presentation order only** — it never changes
*what* the note says, which verdict it words, or any grounding rule above.

---

## How the verdicts govern voice

The engine hands the note two reads. The note **words** them and never argues with them:

- **`effort_verdict`** `{level, target_rir, headline}` — how hard the set was, from the
  logged RIR vs the role-aware target. The opening reaction agrees with this level.
- **`progression_verdict`** `{level, range_low, range_high, ceiling, headline}` — where
  today's top working set sits against the lifter's own recent band and the ceiling
  they've beaten. The note reads today *against the range* and lands the forward line on
  this trajectory. Levels:
  - `under_shot` — below the recent band; name it, with a spine.
  - `in_pocket` — solidly inside the band; the box is checked.
  - `maintenance_drift` — inside the band but slipping toward the low end.
  - `progressing` — pushing the top of the band upward, short of a PR.
  - `new_ground` — clears the ceiling they'd beaten before.

When the two reads point different ways (a light load that still felt hard, say), both
are true and the note can hold both — but it never contradicts either headline.

If a verdict or a number is missing from the facts, the note **drops that beat** rather
than fabricating one. Saying less is always correct; inventing is never.
