# Atlas Product Vision

> **Governance layer:** Vision + Dream — see [`docs/GOVERNANCE.md`](GOVERNANCE.md) for the full hierarchy.

## One-Sentence Vision

Atlas is a personal AI fitness companion that helps the owner log workouts naturally, capture Apple Watch effort data, safely review and save structured training history, and receive increasingly intelligent coaching based on real progress.

## What Atlas Is Ultimately Becoming

Atlas is not just:

- A workout API.
- A Google Sheets automation.
- A screenshot parser.
- A dashboard.
- A code project.

Atlas is becoming:

- A personal AI workout coach.
- A training memory system.
- A workout logging app.
- A progress tracker.
- A safe write/review system.
- A coaching intelligence layer.
- Eventually, a full web/mobile fitness product.

The finished Atlas app should let the owner:

- Talk naturally during workouts.
- Log sets quickly without thinking about spreadsheets.
- Upload Apple Watch screenshots.
- Review parsed effort and workout data.
- Approve before anything is saved.
- See progress by lift, muscle group, and training block.
- Understand what to do next.
- Avoid overreaching, stalling, or training blindly.
- Combine training, effort, bodyweight, and nutrition over time.

## The Core User Story

The owner goes to the gym.

During the workout, the owner logs sets conversationally, for example:

```text
Squat 135 for 10 at RIR 4, 185 for 8 at RIR 3, 225 for 5 at RIR 2.
```

Atlas understands:

- Exercise.
- Sets.
- Weight.
- Reps.
- RIR.
- Notes.
- Session context.
- Previous history.
- Likely next move.

At the end of the workout, the owner uploads an Apple Watch screenshot.

Atlas parses:

- Duration.
- Active calories.
- Total calories.
- Average heart rate.
- Peak heart rate.
- Location if available.

Atlas then shows a clean preview:

- Workout rows.
- Effort row.
- Enriched exercises.
- Canonical exercise names.
- Lift codes.
- Muscle groups.
- Volume calculations.
- Warnings or unknown exercises.

The owner reviews and approves.

Only after approval does Atlas write to production.

Then Atlas updates:

- Workout history.
- Session summary.
- Exercise progress.
- Muscle group volume.
- Recommendations.
- Future coaching context.

## The Golden Product Rule

Atlas must never blindly write important training data.

The finished app must preserve this rule:

```text
AI can parse, prepare, suggest, and preview.
The owner approves.
Only then does Atlas write.
```

This is not just a backend safety rule. It is a product principle.

The approve-before-save workflow is central to Atlas.

## What Good Feels Like

Atlas should feel:

- Fast.
- Calm.
- Trustworthy.
- Low-friction.
- Conversational.
- Useful during an actual workout.
- Safe around real data.
- More like a coach who remembers everything than a spreadsheet.

The owner should not feel like they are filling out a form forever.

The owner should be able to say what happened in normal gym language and have Atlas structure it.

The app should reduce friction, not add admin work.

## Current v1 System

The current system is the foundation.

It includes:

- Node.js and Express backend.
- Render deployment.
- Google Sheets persistence.
- OpenAI Vision screenshot parsing.
- API key auth.
- Workout ingestion.
- Exercise enrichment.
- Duplicate protection.
- `test_mode` dry-runs.
- Mission Control GitHub Actions.
- No-write safety proof.
- Secret hygiene.
- Backup/rollback planning.

Google Sheets is currently the database because it is:

- Simple.
- Inspectable.
- Easy to manually recover.
- Easy to debug.
- Familiar.
- Good enough for the owner-operated v1.

But Google Sheets is not necessarily the final architecture.

## Architecture Philosophy

The current architecture is not sacred.

Google Sheets, Render, GitHub Actions, ChatGPT, Codex, and the Node/Express backend are the practical v1 path. They are not a permanent commitment.

Atlas should remain open to better, safer, simpler, and more efficient ways to build the app as the product matures.

Future architecture may include:

- A real database.
- Google Sheets as export/reporting only.
- A proper web app frontend.
- A mobile app.
- Stronger authentication.
- User profiles.
- Background jobs.
- Monitoring and alerts.
- Richer analytics.
- Better AI orchestration.
- Fewer manual AI handoffs.
- More automated tests.
- Better observability.

The goal is not to defend the current stack.

The goal is to safely evolve Atlas toward the simplest reliable system that supports the product.

Any future architecture change must preserve:

- No blind writes.
- Owner approval before production writes.
- `test_mode`/dry-run validation.
- Backup and rollback ability.
- Clear production verification.
- Protection of private workout and health data.
- Simple recovery if something goes wrong.

## Core Product Pillars

### 1. Capture

Atlas must make it easy to capture workout data.

Capture methods:

- Conversational chat.
- Structured workout UI.
- Apple Watch screenshots.
- Future wearable integrations.
- Bodyweight entries.
- Nutrition entries.

Capture should work while tired, rushed, or mid-workout.

### 2. Clean

Atlas must clean messy human input.

It should handle:

- Shorthand exercise names.
- Missing punctuation.
- Multiple sets in one sentence.
- RIR notes.
- Rep/weight patterns.
- Apple Watch screenshot data.
- Known exercise aliases.
- Unknown exercises needing review.

### 3. Enrich

Atlas should enrich raw logs with:

- Canonical exercise names.
- Lift codes.
- Muscle groups.
- Volume calculations.
- Session IDs.
- Normalized dates.
- Effort metrics.
- Warnings and validation notes.

### 4. Preview

Atlas must preview before saving.

Preview should show:

- Exactly what rows will be written.
- What was inferred.
- What is uncertain.
- What needs owner review.
- Whether any exercise is unknown.
- Whether duplicate protection is triggered.

### 5. Approve

Owner approval is required before production writes.

This should become a first-class UI feature:

- Preview.
- Looks good.
- Save workout.
- Edit before save.
- Cancel.

### 6. Remember

Atlas should become the owner's training memory.

It should remember:

- Recent sessions.
- Best sets.
- Progress trends.
- Fatigue patterns.
- Recurring stalls.
- Exercise preferences.
- Injuries/limitations.
- Training goals.
- Bodyweight/nutrition context.

### 7. Coach

Atlas should eventually coach intelligently.

Coaching should start transparent and rule-based:

- RIR-aware progression.
- Next set suggestions.
- Stall detection.
- Deload suggestions.
- Volume balance.
- Fatigue guardrails.
- Consistency feedback.

Over time, coaching can become more personalized.

### 8. Protect

Atlas handles private fitness/health data.

It must protect:

- API keys.
- Google credentials.
- Workout history.
- Bodyweight/nutrition data.
- Personal notes.
- Screenshots.
- Production sheets.

Safety is a product feature, not just an engineering task.

## Finished App Experience

### Workout Logger

- Start session.
- Enter exercises/sets quickly.
- RIR support.
- Notes support.
- Previous set recall.
- Next set suggestions.
- Finish workout.

### Apple Watch Upload

- Upload screenshot.
- Parse effort.
- Confirm duration/calories/heart rate.
- Attach effort to session.

### Review Screen

- Show cleaned workout rows.
- Show effort row.
- Show enrichment.
- Show warnings.
- Approve before save.

### History

- Recent workouts.
- Session details.
- Filters by date/exercise/muscle group.
- Search sessions.

### Progress Dashboard

- Lift progress.
- e1RM trends if available.
- Volume by muscle group.
- Top exercises.
- PRs.
- Consistency.
- Bodyweight overlay later.

### Coaching

- Next workout suggestion.
- Recommended weights/reps.
- Fatigue warnings.
- Deload prompts.
- Weak point detection.
- Weekly summary.

### Future Signature Programs

Someday, Atlas may support themed program experiences such as "Train Like..." modes, classic bodybuilding-style training blocks, strength-athlete-style blocks, approved creator/influencer partnerships, or creator-built 3-week, 5-session, and 12-week programs.

This is future product exploration, not active roadmap work. Any real-person, creator, influencer, athlete, brand, likeness, or paid-program reference requires explicit licensing or approval. Without secured rights, Atlas should frame those modes generically, for example as "inspired by classic bodybuilding style."

The program supplies the structure and theme. Atlas still owns personalization, load sanity, substitutions, safety constraints, available-equipment handling, recovery-aware adjustments, approve-before-save behavior, and logging trust.

### Bodyweight and Nutrition

- Bodyweight logging.
- Trend chart.
- Nutrition summaries.
- Calorie/macro support later.
- Training feedback that considers recovery and bodyweight changes.

### Mission Control / Admin

- Backend health.
- Sheet contract status.
- Latest deploy/version.
- Last smoke test result.
- Dry-run proof.
- Rollback guidance.

## What Codex Should Understand

Codex should not treat Atlas as only a backend refactor project.

Before making product, UI, data, or architecture decisions, Codex should understand:

- The backend exists to support a future user-facing app.
- Google Sheets is a v1 persistence layer, not necessarily final.
- Approve-before-save is central.
- Coaching intelligence is a core future feature.
- Workout capture must stay low-friction.
- Safety must remain strict.
- The owner uses Atlas conversationally during real workouts.
- The finished product should feel useful in the gym, not just correct in tests.

## What Codex Should Not Do

Codex should not:

- Build huge features without a small PR plan.
- Skip safety docs.
- Loosen `test_mode`/no-write logic.
- Make Dashboard required.
- Make blind writes easier.
- Assume Google Sheets is final forever.
- Assume UI should start with writes.
- Expose secrets.
- Change Render environment variables.
- Perform real writes.
- Create fake workout data without approval.

## Product Development Order

Atlas should develop in this order:

1. Safety foundation.
2. Cleaned sheet stability.
3. Backup/rollback confidence.
4. First real workout write.
5. Read-only UI.
6. Session/history UI.
7. Progress dashboard.
8. Workout logger UI.
9. Apple Watch upload/review UI.
10. Approve-before-save workflow.
11. Coaching intelligence.
12. Bodyweight/nutrition.
13. Better auth/private access.
14. Full mobile app.
15. Database/backend evolution if needed.

## Current Locked Status Board

✅ Idea defined
✅ Backend built
✅ Google Sheets connected
✅ OpenAI Vision parsing working
✅ Workout ingestion working
✅ Exercise enrichment working
✅ Cleaned sheet live
✅ Mission Control working
✅ Dry-run safety proven
✅ Codex hardening tests/docs/runbooks merged
✅ Agent instructions merged
✅ Secret hygiene docs merged
✅ .env untracked
✅ Manual secret rotation complete
✅ Post-rotation Mission Control passed

🔄 Backup / rollback plan

⏳ First real write
⏳ First real workout logged end-to-end
⏳ Monitoring / error alerts

⏳ Read-only UI
⏳ Progress dashboard
⏳ Workout logger UI
⏳ Apple Watch upload/review UI
⏳ Approve-before-save workflow

⏳ Coaching intelligence
⏳ Program/progression engine
⏳ Nutrition/bodyweight
⏳ User profile/settings
⏳ Better auth / private access
⏳ Full mobile app
⏳ Database/backend evolution

## The Dream

Atlas's long-term ambition is to become the trusted training-intelligence engine for fitness.

Today Atlas is a personal workout logger with one owner. The dream is something larger: a training-intelligence layer that can sit underneath, plug into, or power an entire ecosystem.

**What Atlas understands that others don't:**

- What the user actually did, versus what was planned.
- What the session intended, and whether substitutions preserved or abandoned that intent.
- What changed in the real world — unavailable equipment, fatigue, injury — and how the session adapted.
- What training history says about this athlete's real working weights, trends, and recovery patterns.
- What progression is actually justified, not what looks good on a plan.
- What the coach should explain to earn trust — not just numbers, but the reasoning behind them.

**The endgame:**

Programs, apps, wearables, gyms, and coaches provide the surface area.
Atlas provides the trust-first adaptive training intelligence underneath.

In this vision, Atlas could power:

- Its own consumer app.
- Creator programs and coach/trainer platforms.
- Gym software and wearable integrations.
- Nutrition and fitness ecosystems.
- Third-party fitness apps.
- Future licensing or API products.

**Tenets — the filter for future decisions:**

Each Roadmap step and product decision can be checked against these:

1. **Understand, don't just collect.** Atlas understands what happened in a session — intent, substitutions, deviation from plan, progression justification. Raw logs are the input; session understanding is the product.
2. **Engine owns the numbers.** Every weight, volume, and progression figure derives from deterministic computation over real history. AI words facts; it never invents them.
3. **Intelligence over surface.** The training engine is the product. Apps, platforms, wearables, and APIs are skins on the engine — valuable, but secondary. A step that adds surface without deepening the engine serves the app, not the dream.
4. **Earn the next step.** Atlas recommends only what the athlete's history actually justifies. No template numbers, no invented progressions.
5. **Trust loop at any scale.** Approve-before-save and no-blind-writes are preserved regardless of how many surfaces or users Atlas eventually serves.

**Guardrails for this vision:**

- This is a long-term dream, not active roadmap scope.
- The current v1 focus — one owner, one sheet, one trust loop — is not weakened by this vision.
- Atlas does not become a generic fitness API prematurely.
- No multi-user or platform work is active until the owner explicitly directs it.
- The trust contract is preserved in any future form: the engine owns facts and numbers; AI only words them.

The dream does not change what to build today. It shapes how to think about the decisions being made now.

---

## North Star

Atlas succeeds if the owner can walk into the gym, train normally, capture the session with almost no friction, approve a clean structured log, and get better guidance next time because Atlas remembers the full training story.
