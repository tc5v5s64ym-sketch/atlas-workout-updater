# Atlas Workout Updater · prose-slot gate design

20 November 2026 · Builder specification and grading contract · PR #1790 at `b2440421`

Refuse when a previewable span contains a quantity, a set label and another quantity in source order, unless the entire span matches a documented form that accounts for the parser’s rows. A third quantity makes the weighted form. The shorter prefix covers the weightless R2 family. Every gap admits arbitrary material, including nothing. An unfamiliar connector, repeat spelling or punctuation mark cannot grant permission to log. The detector supplies a boolean. The parser supplies every value in every row.

**Result.** The non-shipping specification worksheet matched all 1,135 required binary outcomes. The fresh challenge comprised 16 families and 110 case IDs. On athlete intent, 105 closed or passed and five survived as unnecessary clarifications. The 105 comprise 79 required refusals and 26 protected LOG outcomes. No silent partial survived these cases. LOG includes the established behavior of surfacing an unresolved line beside clean siblings. These measurements describe the design under this corpus. The repository has no implementation of this design.

## Source and baseline

At `cabbca62c75b345478ef184b2bf00099acb1d946` and at the retrieved `s3-maintenance` ref, the gate blob is `bb39175c64fa85c83572bf6a3bf4320ca326f5ea` and the test blob is `cb6ba618c87905d48e50a54e3a15544d1c856743`. That source contains the earlier mixed-family, ambiguous-@, zero-value and multiplier checks. It contains no prose arm or repeated-group implementation. The preparation note assigning round eight to that branch conflicts with both files. Round eight is present at PR parent `7544ac18`. The integration target is the complete PR head `b24404211847d352ef7905bb0ccff37ac297eb47`, whose recorded PR base is `84c1ef1f`. Its parser differs from the pinned maintenance parser only by exports of two existing classifiers. The two gate suites passed offline, 25/25 and 58/58 respectively. [Maintenance gate](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/blob/cabbca62/services/fullConsumptionGate.js) · [Maintenance tests](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/blob/cabbca62/test/fullConsumptionGate.test.js) · [PR diff](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/pull/1790/files) · [Head tests](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/blob/b2440421/test/fullConsumptionGate.test.js)

The issue’s original loss is mixed notation. The same-family example became its R5 regression. On the pinned parser, `bench 3x8@165 3x8@135` emits three 165×8 rows. The PR’s existing repeat arm refuses. For the canonical prose example and the four round-nine findings the PR returns one 185×5 row, volume 925 and empty warnings. A complete reading would also contain three 165×8 rows, total volume 4,885. The gate can prevent the partial preview without computing either total. [Issue #1765](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/issues/1765) · [Diagnosis](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/issues/1765#issuecomment-6953779399) · [Blocking review](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/pull/1790#issuecomment-6994106968) · [Designer’s account](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/pull/1790#issuecomment-6995400748)

The precedent in #1786 recognizes an ambiguous quantity shape, then admits separators only where an attested reading accounts for the quantities. Its own placement of `x` depends on what that parser consumes. The transferable decision is affirmative coverage of a complete legitimate reading. Its modality units and its three-token limit have no authority over strength notation. [PR #1786](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/pull/1786/files)

## Grammar

```text
Q     = one quantity-evidence interval
S     = one set-label interval
G     = zero or more input code points inside this ownership span
R2    = Q G S G Q
FULL  = Q G S G Q G Q
```

Use substring existence, with nonoverlapping intervals in increasing source order, including touching endpoints. The slots in FULL are count, label, reps and weight. The optional words `rep` and `reps`, units, qualifiers and wraps all fit G. Formally the danger predicate needs just R2 because FULL contains R2. This makes the implicit or word-weight case fail closed without giving the gate any power to complete a set. A count-only remark such as `did 3 sets of bench` after a logged set has no following quantity. Earlier amounts alone cannot complete it.

**Bounds.** Every gap ranges from zero to the remaining length of its span. No token, word, mark-run or character budget changes REFUSE into LOG. Five words carry no evidence of a clause. On the PR, both `3 sets of of of of of 8 at 165` and `3 sets of 8 at at at at at 165` beside the slash set reach the gate and log one row. Other five-token examples happen to stop upstream. Clause punctuation and newlines within a flattened single result do not assert separate ownership. Distinct child spans and positively surfaced unresolved lines do establish boundaries. The cost is an occasional ask when two statements in a single span were actually independent.

**Input views.** Compare independently in three lowercase views. A refusal in any eligible view suffices. Never pool anchor intervals across views.

1. Preserve the original spelling, folding ECMAScript whitespace runs to one space and trimming, with ordinary ECMAScript Unicode lowercase. This view retains, for example, a multiplication sign inside a decorated word.
2. Use the shared `normalizeParserText`, then lowercase. This includes the parser’s smart-quote and multiplication-sign folds.
3. Use the existing `normalizeGateText`, which applies `normalizeWeightUnits` before the parser fold and lowercase. The spelling-preserving views retain boundaries the unit normalizer can erase, such as the pound mark before non-ASCII digits. These views belong exclusively to the veto.

**Alphabet and fusion.** Iterate Unicode scalar characters using Unicode 17.0 properties. In a JS string treat an unpaired surrogate as one mark. NUMBER is general category N, including Nd, Nl and No. LETTER is category L. SPACE is Unicode White_Space union ECMAScript whitespace. MARK is the entire complement. A maximal consecutive NUMBER run is one indivisible Q. A transition in either direction between LETTER and NUMBER is always a token boundary, even at the beginning or end of a slot. A whitespace character or any MARK ends a number run. Never split a digit run to manufacture two quantities. A dot between numeric runs can be a decimal point or a separator. For the suspicion test it separates the runs. In an affirmative layout a declared decimal field consumes its dot as specified below.

**Marks and dashes.** All marks, balanced or unbalanced, singly or in runs, are connector material with zero required padding. Between numbers a dash keeps the two runs distinct, including in `8-165`. Beside a word, before or after a number, tight, half-spaced or spaced, it is material in the same gap. A sign or a range reading supplies uncertainty and authorizes no arithmetic. Even a dash-like character categorized as a letter fits G. There is no clause-punctuation list, dash vocabulary, “one atom” exception or special last connector.

**Reserved spellings.** S is the spelling `set` or `sets`. Word-Q spellings are `zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion trillion`. These are evidence of a quantity. A multiword or hyphenated weight can contribute several intervals, and the gate never evaluates their sum. Use the following single spelling comparison for both S and word-Q.

- In any one view, a numeric run or SPACE interrupts a spelling. Other MARKs may occur anywhere between its letters. Each LETTER projects through per-character NFKD, lowercase, and removal of category M from that decomposition. For a remaining non-ASCII character use the Unicode 17.0 confusables MA mapping once if its target consists entirely of ASCII letters, then lowercase that mapping. Otherwise keep the character. Preserve ASCII letters literally. If the resulting piece fails to consist entirely of ASCII a–z, it interrupts the spelling. An interruption can always be crossed by G. The positive templates use the resulting lowercase text of the view itself for literal fields. The detector’s projected spellings serve only the interval and neutrality checks. [Unicode 17.0 data](https://raw.githubusercontent.com/unicode-org/unicodetools/main/unicodetools/data/security/17.0.0/confusables.txt)
- Compare every occurrence of each reserved spelling against consecutive projected letters. Carry the original character offsets. An interval must begin and end at complete source-character boundaries. Two roles may never reuse the same source character. This is a detector-only compact-word reading. A letter-to-letter join has no automatic token boundary in the parser, but `threesets` admits the two reserved intervals in the detector. The same rule handles arbitrary adjacent words and decorated anchors. Its measurable cost includes `set` in `headset` and `one` in `gone`. Reserve the word **whole** below for an interval whose immediately adjoining source characters on both sides are absent or non-LETTER.
- The confusables data SHA-256 is `091c7f82fc39ef208faf8f94d29c244de99254675e09de163160c810d13ef22a`. Use pinned data or an equivalent build-time projection. This decision requires no runtime lookup. A fixed-vocabulary matcher can compute interval starts and ends and scan for ordered anchors with prefix/suffix state in linear time per view. Avoid backtracking across the unconstrained gaps or exploring all possible word partitions.

## The positive forms that can log

The nonempty emitted rows establish exposure. Only the following narrow whole-span comparisons establish affirmative coverage of a suspicious shape. Evaluate the comparison in the same view and with the same local rows that triggered it. Absence of a field needed for a comparison makes the comparison fail. Row-count or value coincidence by itself cannot discharge a claim. Each successful comparison merely permits the ordinary gate to continue.

For the templates, use `D = [0-9]+(?:\.[0-9]+)?`, `I = [0-9]+`, and `V = I | one of zero through twenty`. Compare finite values to emitted fields using the parser’s JS numeric equality. V words may be compared by ordinal in that list. K and C denote counts. W, R and J denote existing weight, reps and RIR. All checks against “every row” range over the complete local array in order. NAME is a literal lowercase parser-normalized `raw_name`, `canonical_name` or `exercise` of that owner. Exclude empty names, names containing category N, and names containing an S interval. Escape name text. Do not resolve another lift. For the comparisons that permit a narrative prefix, consider every payload match and accept if any covers the full view under the prefix and tail rules. If an optional positively matched answer or restatement disagrees with the rows, that match fails.

In a comparison, a **prefix** may contain narrative. Remove at most the first complete NAME from it, taking the longest name on a tie and requiring non-L/non-N or string ends on both sides. The rest must have no S, no numeric glyph and no whole word-Q. A **neutral tail** has no S or Q at all, including embedded readings. A literal space in the templates is one normalized space. For C2, `~` means zero or more ECMAScript whitespace characters and `SPACE+` in an affirmative template means one or more ECMAScript whitespace characters. Square brackets indicate an optional item. Parenthetic alternatives below are grammar notation. Positive templates never erase text from the danger scan for another span.

| Accepted surface | Required evidence |
| --- | --- |
| Prefix, then `C set(s) of NAME W R/J [xK]` as one complete native statement | C is V, W and J are D, R and K are I. The optional ` xK` defaults to one. C, K and row count agree. Every row has precisely W, R and J. |
| Same introduction, then `K x R @ W`, `W x R x K`, or `W for R K times` | In each case C = K = row count and every row matches W and R. W is D. R and multiplier K are I. For the `times` form K is I or one of one through five, as in `parseNaturalSets`. Allow zero or more ordinary spaces around the native `x` and `@` operators. The `for` and `times` words have the displayed spaces. |
| `NAME W R/J xK C set(s) done` | This exact completion remark follows the native record. W and J are D, R and K are I, C is V. C = K = row count, and every row matches W, R and J. |

K must be positive and at most ten for the slash and two x-multiplier layouts, including the completion remark. The natural `for … times` layout uses its parser’s positive repeat count without that cap. The native forms end at the end of the view and may have trailing `.`, `!` or `?` in any run. The first two alternatives place the introduction directly before the stated native data. The completion remark begins at the start of the view. No extra number, parenthetical, note or later group can ride one of these proofs.

**C2 weight-first forms.** In either form below use an eligible prefix, exactly one matching payload and the tail grammar immediately below. W is D, C and R are I. Accept `pound` or `pounds` and `set` or `sets`. Require C in 1–10, C = row count and exact W and R on every row.

```text
A   W ~ pound(s) [,] ~ R ~ (each arm | per arm | per side) [,] ~ C ~ set(s)
B   W ~ pound(s) [,] ~ [one [,] ~] C ~ set(s) SPACE+ of SPACE+ R
```

The punctuation and optional items in these two lines have no extra whitespace beyond the indicated `~` or `SPACE+`. A additionally requires `load_note === 'per_hand'` on every row. B protects `Goblet Squat 35 pound one, 3 sets of 10`. The literal “one” belongs to the dumbbell description. [Parser and C2/C3/C4 controls](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/blob/b2440421/test/parseWorkoutTextPlanContext.test.js)

**C2 tail.** Consume at most one actual C3 answer at the start of the tail. Use the two expressions below in their displayed precedence, with lowercase normalized text. The leading padding is allowed only as part of a successful answer match. D and I within the displayed patterns stand for the complete numeric fields defined above. The punctuation vocabulary here reproduces specific accepted parser syntax. It has no role in the connector G.

```text
pad = [\s.,!?;:]*
pad tank answer\s*:?\s*D
pad (honestly )?(the )?(last set )?(the )?answer was (like\s*)?\.+\s*D
```

An all-set answer must appear as stated RIR on every row. A last-set answer must appear on the final row. Earlier rows may have null RIR or `rir_source === 'plan'`. For rows carrying the stated answer require RIR equality and a source other than `plan`. Consume at most one immediately following `pad maybe\s+D` if it restates the same value. A different value invalidates the proof. After these optional items, permit one separate timed sentence prefix matching `^\s*[.!?]+\s+plank\s+D\s+seconds?\b`. This identifies the explicitly dimensioned quantity in the attested Priya turn and never certifies a modality write. The remaining text must be a neutral tail. The default when no C3 answer is present imposes no extra RIR requirement.

**C4 plan deviation.** Require every row to carry `weight_source === 'plan'`. Find one literal `\ball I sets?\b` and one `\bstopped at D instead of D\b`, in either order. The count is in 1–10 and equals the number of emitted rows, the first deviation value equals reps on every row, and the second differs. Remove those two occurrences and at most the first separate `\brep I\b` narrative index. Require a neutral remainder. Here the parser has already validated the plan. An unrelated numeric or set-bearing tail invalidates the proof even if the emitted rows still match the plan. No plan lookup belongs in the gate.

These proofs compare existing rows with attested syntax. They never construct candidate rows, expand a repeat, convert a load, attribute an exercise or invoke a parser a second time. Ordinary single-family inputs with no candidate need none of these proofs.

## Span ownership and attachment

**Ground truth.** Text supplies evidence of an unaccounted claim. A successful log result with a nonempty emitted set array supplies evidence that rows could reach preview. A bare `225 3` can emit 225×3 without any counted group token, and its 3 may also start `3 sets of 8 at 165`. Do not subtract that 3. Comparing rows to a putative 3×8 at 165 cannot prove consumption either. Two identical groups can have identical values and only one emitted occurrence. A text-only decision loses both the distinction between a parser ask and a preview and the evidence that protects complete native entries. The cost of using rows is that they carry no general consumed offsets. When the positive forms cannot establish ownership, the athlete must re-enter.

**Single result.** Use the original request text as the source of all three views, including paragraphs omitted from `parsed.raw_text`. For `log_sets` with rows, evaluate the complete span. Refuse on any view with an R2/FULL candidate lacking whole-span affirmative coverage. Lines may aid the old non-prose checks. A single per-line fragment cannot undo a positive comparison for the whole entry. A plausible multiline rescue cannot waive a whole-span prose veto.

**Multiple exercises.** Use these rules separately in each view. Retain the existing no-op for a multi result with zero rows throughout.

1. Scan every nonempty child with rows over its own `raw_text` and its own rows. A hit refuses the turn. The fallback below can still observe a child whose text is missing.
2. Split the original request on CRLF or LF, transform each line with the view function, discard empty lines and join the results with one ordinary space. Locate each nonempty child with rows by its exact transformed child text in this string, delimited at both ends by an ordinary space or a string end. Count overlapping matches too. Only a unique occurrence is eligible for a child interval. Mark a whole transformed line as unresolved only when it equals an actual `unresolved[].line` in this view and the line occurs exactly once among the transformed lines. Preserve source occurrences even for identical strings.
3. Disqualify every candidate interval intersecting any other candidate interval, including equal intervals. No priority choice or global replacement resolves such a collision. Positively located unresolved intervals form hard cuts. In each remaining region, keep the disjoint, located child intervals in order.
4. With no located child, scan the full region. Turn-wide rows enable the veto, and affirmative coverage is unavailable. With children, scan one maximal window per child. Start at the preceding child’s end or the region start and end at the following child’s start or the region end. Use only the central child’s rows for affirmative coverage. This includes uncovered text on both sides, possibly in two windows, and never concatenates two located children into a new claim. A count at the end of a child can still start an uncovered group. A zero-row child cannot mask its text. This rule is deliberately conservative when source attribution is ambiguous.

**Exact hook on the PR.** Replace the prose constants and both `PROSE_SET_GROUP` regex objects ending at lines 346–347 with the shared boolean recognition and coverage rules above. Retire the prose-only word, wrap, glyph, dash, punctuation and connector subexpressions. Replace the final prose arm of `hasRepeatedSetGroup` at lines 569–571 with the local unaccounted-prose boolean. Pass that same boolean to the prose contribution in `zeroSetDirectiveMessage` at line 607. It is already sufficient for a repeated-group veto. A second lexical implementation here would drift.

Keep the PR’s `checkSpan` warning order. In its existing repeated-group slot evaluate the other repeat checks first, then the prose boolean. Return the existing `ask(repeatedSetGroupMessage(), 'repeated_set_group', parsed, rawText)` on a prose veto. For single multiline input run the ordinary line checks in their existing order. Enable a line’s prose boolean only when both the complete-entry decision and the local line decision veto it. Run the whole check with the complete-entry decision. A whole refusal with an unaccounted prose frame survives the existing rescue suppression. For multi, run per-child checks, retain the existing per-line backstop for **non-prose** checks and aggregate zero-value check, then run the supplemental prose windows if the result can still log. A window veto uses the same `ask`. Preserve `unresolved` and deduplicated warnings. A refusal contains zero previewable rows in both the single and multi positions.

Keep all non-prose repeated-group checks, mixed families, ambiguous @, zero directives and nonpositive values, unrecognized multipliers, parser normalization, taxonomy, rescue machinery and nonlogging intents under their current contracts. An already surfaced unresolved line with clean siblings can keep logging with its notice. The new predicate is inactive on an empty/non-previewable result. Retain the existing garbage-input behavior. The PR’s non-prose mechanisms are prerequisites for grading the historical non-prose cases against the maintenance branch. [Integration source](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/blob/b2440421/services/fullConsumptionGate.js#L480)

## Rulings on the disclosed holds

Here the fragment follows `bench 185 5/2 then` and completes the stated prose frame unless a different full input is shown. All six historical permissions change to REFUSE in that context.

| Form | Required | Reason |
| --- | --- | --- |
| `3 sets of 8-165` | REFUSE | A tight numeric dash could describe a range or a separator. Neither reading records the missing group. |
| `at *165`, `with✕165` | REFUSE | Preposition and adjacent mark occupy the same arbitrary gap. Adding a word cannot authorize the missing weight. |
| `sets.8`, `reps:165` | REFUSE | A mark may abut the numeric interval on either side. Balanced wraps, whitespace and matching openers have no bearing. |
| `3 sets 8 at 165` | REFUSE | The empty reps connector is valid evidence. The PR emits only the 185×5 row. |
| `threesets of 8 at 165` | REFUSE | The compact spelling has distinct ordered intervals. The historical fixture logs. The actual slash-prefixed route already asks upstream with `unattributable_trailing_sets`. |
| `3 sets x8 at 165` | REFUSE | The parser emits eight **185×5** rows, all RIR 2. Neither the count 3 nor the weight 165 is accounted for by those repeats. The genuine `bench 185 5/2 x8` logs all eight. |

The four round-nine probes N35, N41, N42 and N43 all require REFUSE. They respectively use `3 sets8 at 165`, `3 sets of 8… at 165`, `3 sets of 8–at 165` and `3 sets of 8—at 165`. Both the full route and a gate-only fixture appear for each.

## Carried items

| Item | Decision |
| --- | --- |
| `at one hundred sixty-five` | REFUSE in the frame. The gate recognizes quantity evidence and emits no numeric interpretation. |
| Weightless R2 | REFUSE an unaccounted count/label/quantity prefix. Includes `3 sets of 8`, `3 sets of 8 reps`, `3 sets for 8`, `3 sets of 8 at the same weight`, and `3 sets of 8 - felt good`. This design settles the earlier follow-up in favor of re-entry. A verified weight-first C2 statement still logs all its sets. `bench 185 5/2 then 3 sets for time` logs the slash set because there is no following quantity. No weight is inherited. |
| Fullwidth digits | Detect and REFUSE an unaccounted prose frame with fullwidth count, reps or load. Reading such digits as loggable values is a separate parser-normalization decision. `bench ３x8@165` keeps its upstream `missing_sets` ask. |
| Lone `x` before weight or another small number | REFUSE `3 sets of 8 x8` and `3 sets of 8 x8 at 165`. On these slash-prefixed strings the PR gate already refuses although the pre-gate parser repeats the first set eight times. Retain LOG for `bench 185 5/2 x8`. The scope and remaining numbers distinguish the statements. |
| Five or more connector tokens | REFUSE whenever the anchors occur in scope. Preserve any earlier parser ask. The two repeated-`of`/`at` controls demonstrate why `unattributable_trailing_sets` cannot implement the contract. |

## Corpus and grading

`attack-corpus.json` contains 1,135 executable rows and 635 distinct raw strings. The 1,025 historical rows comprise 386 nonempty preview-candidate invocations captured from the actual head tests, 112 additional direct review fixtures and 527 parser-to-gate cases. This includes the written round 1–9 tests with their loops expanded, the coordinator P1–P11 set including both printed P7 glyphs, D/F/B/G/H/I/J/K/L/M/S/T and named N observations, the four blocking probes, holds, carried items, legitimate controls, and reconstructions from review descriptions. Individual rows retain provenance. Reconstructed complete sentences carry no claim to be the private reviewer’s original bytes. The 426-case driver and unprinted observation strings are absent from the PR head tree. The JSON does not claim to be that driver. Among the 386 extracted fixtures, 41 previous LOG verdicts intentionally change to REFUSE.

For each row, take `text` literally. For `entry=route`, call `parseWorkoutText(text, context)` using the row’s context. For `entry=gate`, deep-clone the supplied `parsed` and bypass the parser. Snapshot the input object and call `applyFullConsumptionGate(parsed, text)`. The assertion is `expect`.

- For LOG, require a logging intent, exact equality with the input parse including ordered rows, warnings, attribution, plan provenance and unresolved notices, and no mutation. For route LOG cases also compare the groups to `parserRows`. LOG is the gate’s permission to retain the supplied preview.
- For REFUSE, require `needs_clarification`, no top-level or child preview rows, and any `requiredWarning`. Retain incoming warnings and unresolved notices on a gate downgrade. On an upstream clarification preserve that result. A `partial` clarification hint is outside preview rows. In both modes verify input immutability.
- `observed` is descriptive. It records the frozen parser input to the gate and outcomes on the maintenance and PR snapshots. The `input` field on direct cases describes the fixture. `worksheetVerdicts` records design revisions. Only `expect` and the explicit assertions grade an implementation. No production endpoint, writer, workbook or LLM is involved.

## Self-attack results

Sixteen families, 110 cases, 109 distinct texts. One parenthetical was intentionally run with two athlete readings. There were 98 route and 12 direct cases. The final decision matched all 110 contract expectations, comprising 84 REFUSE and 26 LOG. At the athlete level the partition is **79 correct refusals + 26 protected log outcomes + 5 unnecessary asks = 110**. That is 105 closed/passed, five precision survivors and zero silent-partial survivors. The grader must still require REFUSE on the five policy exceptions. They expose a real product cost.

| Family | Cases | REFUSE | LOG | What the cases established |
| --- | ---: | ---: | ---: | --- |
| Mark classes | 6 | 6 | 0 | Combining accent, NUL, supplementary-plane code point, emoji/ZWJ sequence, fullwidth underscore and private use all fit G. |
| Letter seams | 7 | 7 | 0 | Mixed-script and fullwidth labels, entirely fused words, interior formatting, dotted labels, two fused connectors and literal × inside a label. |
| Quantity alphabets | 6 | 6 | 0 | Arabic-script, Roman/circled and mathematical digits, spaced and glued English weights, and a pound mark before fullwidth digits. |
| Connector lengths | 8 | 8 | 0 | Zero, four, five, twelve and 64 tokens. Two five-word connectors actually log at the old head. |
| Dash positions | 6 | 6 | 0 | Numeric neighbors, word neighbors, decorated labels and dash-like characters outside ordinary punctuation classes. |
| Mixed notation | 5 | 5 | 0 | Multiple boundary mechanisms in each span, including a keycap, soft hyphen and ambiguous decimal. |
| Repeated values and order | 5 | 5 | 0 | Exact row-value collisions, reversal, a one-pound difference and competing repeat counts. |
| Exercise and line scope | 9 | 6 | 3 | A child or merged-away line can veto. An upstream ask remains an ask. Two surfaced unresolved cases and one actual clean two-line log retain their results. |
| Weightless and recap | 9 | 8 | 1 | Explicit, inherited, fused and word reps refuse. A verified count-only completion logs. A true recap in bare parentheses incurs one extra ask. |
| Ownership of parsed prose | 9 | 3 | 6 | Weight-first prose, plan deviations, per-row RIR scope, the Priya controls and unaccounted extra quantities. |
| Ordinary logs | 8 | 1 | 7 | Native repeats and neutral phrases pass. One equipment note incurs an extra ask. |
| Extra text beside a positive control | 6 | 6 | 0 | A second claim, a changed recap or a neighboring load invalidates coverage. A correctly logged annotated multiline turn incurs one extra ask. |
| Embedded anchors | 7 | 6 | 1 | Weak letter-only evidence cannot pad a missing group out of scope. Two benign equipment-note readings incur extra asks. |
| Direct parser evidence | 8 | 6 | 2 | Wrong fixture weights or RIR, hidden/bare groups, duplicate unresolved occurrences and adjacent complete children. |
| Ownership boundaries | 5 | 3 | 2 | A child’s last number can begin a residual frame. An empty child cannot hide it. A whole C2 comparison may cover a line fragment. |
| Counted introductions | 6 | 2 | 4 | Native sets-first, weight-first, natural repeats and singular slash syntax log against matching rows. Mismatch or extra text refuses. |

The complete literal cases for these families follow in the case ledger and in the JSON. REFUSE on the weighted families is correct because either the parser asks or a preview would leave the claimed work unaccounted. The five extra asks below are the exceptions to athlete-level correctness.

## Revisions and known limits

Each row below replays the same final 110 cases. The two numeric columns count worksheet LOG where the final contract requires REFUSE, and worksheet REFUSE where the final contract requires LOG. They include protected controls as well as recall tests.

| Reading | LOG errors | REFUSE errors | Change tested |
| --- | ---: | ---: | --- |
| 1 | 18 | 11 | Whole-word and numeric anchors, unbounded gaps. Lost compact/decorated words and rejected legitimate owned prose. |
| 2 | 10 | 5 | Added compact/confusable anchor reads, first affirmative comparisons, and full weighted detection. Required extra lexical evidence on weak weightless prefixes. Allowed a matching parenthetical recap. |
| 3 | 8 | 5 | Removed the parenthetical permission. Identical text and rows can express another group at the same weight. |
| 4 | 6 | 4 | Applied R2 to every ordered prefix and recognized plan-filled RIR on the earlier rows of a last-set answer. Tested an incidental-note exemption after a verified slash log. |
| 5 | 3 | 4 | Removed that exemption. It let `bench 185 5/2 x3 worksets ofeight` log three 185×5 rows. Other groups in the same spelling class then refused. |
| 6 | 1 | 3 | Kept original text adjacent to child spans, stopped zero-row children claiming it, and let a complete single comparison own its multiline fragments. |
| 7 | 0 | 3 | Added the literal spelling view after the parser’s ×→x fold destroyed an interior mark in `se×ts`. |
| 8 | 0 | 0 | Admitted the three additional row-checked native layouts after a counted exercise introduction. Mismatched counts and appended weighted claims still refused. |

The five precision survivors have exact witnesses.

- `r2-4` is `bench 185 8/2 x3 (three sets of eight)` meant as a recap. `r2-7` uses the identical bytes for an additional group. REFUSE protects the second reading and asks unnecessarily on the first.
- `negative-7`, `weak-5` and `weak-7` are complete repeats followed respectively by `headset is gone`, `headset is gone on my phone`, and `headset is gone` at a different load/reps. The evidence includes `set` in `headset` and `one` in `gone` or `phone`. The case protected by withholding a general note exemption is `bench 185 5/2 x3 worksets ofeight`.
- `repair-6` is `bench 185 5/2 x3 did 3 sets\nbench 165 8/2`. The parser emits all four rows. The flattened single result has no per-line consumption receipt, and the frame crosses the line. Letting a newline or the current rescue heuristic universally clear such frames would miss an actual split group such as `bench 185 5/2 then 3\nsets8⁠at165`.

The grammar concerns the specified English set label, quantity vocabulary and source order. It gives no general guarantee about translations, unrecognized anchor substitutions, facts absent from the available source, or other notation families. The earlier R1 `bench 3x8@165 135` still logs three sets with a trailing bare weight outside this component. The earlier N1 `bench 3x8@165 meet me @ 3` still refuses in an existing arm. The supplied design’s silent-partial property was unbroken under the 16 fresh families and 110 cases. Its precision limitations are observed, and the proposed gate has not run in the application.

## Case ledger for the fresh challenge

The quoted text is JSON string notation. Escapes denote actual input characters. Every entry in the JSON also supplies its context or complete gate fixture. Exact historical rows are in the same table under section `history`.

### Mark classes

```text
marks-1  REFUSE  "bench 185 5/2 then 3 sets of 8\u0301via165"
marks-2  REFUSE  "bench 185 5/2 then 3 sets of 8\u0000at165"
marks-3  REFUSE  "bench 185 5/2 then 3 sets of 8\udb40\udc80at165"
marks-4  REFUSE  "bench 185 5/2 then 3 sets of 8\ud83e\uddd1\u200d\ud83e\uddbdat165"
marks-5  REFUSE  "bench 185 5/2 then 3 sets of 8\uff3fat165"
marks-6  REFUSE  "bench 185 5/2 then 3 sets of 8\ue000at165"
```

### Letter seams and display forms

```text
anchors-1  REFUSE  "bench 185 5/2 then three\u0455ets of eight at 165"
anchors-2  REFUSE  "bench 185 5/2 then threesetseightrepsat165"
anchors-3  REFUSE  "bench 185 5/2 then 3se\u2060ts8rep\u0301s165"
anchors-4  REFUSE  "bench 185 5/2 then \uff13\uff53\uff45\uff54\uff53\uff18\uff41\uff54\uff11\uff16\uff15"
anchors-5  REFUSE  "bench 185 5/2 then 3 s.e.t.s of 8 at 165"
anchors-6  REFUSE  "bench 185 5/2 then 3totalsetsaround8reps165"
anchors-7  REFUSE  "bench 185 5/2 then 3 se\u00d7ts of 8 at 165"
```

- `anchors-7` uses a supplied parser result. The parser fold changes a mark to a letter inside a structural anchor.

### Quantity alphabets and words

```text
numbers-1  REFUSE  "bench 185 5/2 then \u0663 sets of \u06f8 at \u06f1\u06f6\u06f5"
numbers-2  REFUSE  "bench 185 5/2 then \u2162 sets of \u2467 at \u216d\u216c\u2169\u2164"
numbers-3  REFUSE  "bench 185 5/2 then \ud835\udfdb sets of \ud835\udfe0 at \ud835\udfd9\ud835\udfde\ud835\udfdd"
numbers-4  REFUSE  "bench 185 5/2 then three sets of eight at two hundred and five"
numbers-5  REFUSE  "bench 185 5/2 then three sets of eight at onehundredandsixtyfive"
numbers-6  REFUSE  "bench 185 5/2 then 3 sets of 8#\uff11\uff16\uff15"
```

### Connector lengths

```text
bounds-1  REFUSE  "bench 185 5/2 then 4sets7reps149"
bounds-2  REFUSE  "bench 185 5/2 then 4 sets for each of these 7 at 149"
bounds-3  REFUSE  "bench 185 5/2 then 4 sets for each one of these 7 at 149"
bounds-4  REFUSE  "bench 185 5/2 then 4 sets of \u2726 \u2726 \u2726 \u2726 \u2726 7 at 149"
bounds-5  REFUSE  "bench 185 5/2 then 4 sets of 7 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 \u00b1 149"
bounds-6  REFUSE  "bench 185 5/2 then 4 very very very very very very very very very very very very sets of seven at 149"
bounds-7  REFUSE  "bench 185 5/2 then 3 sets of of of of of 8 at 165"
bounds-8  REFUSE  "bench 185 5/2 then 3 sets of 8 at at at at at 165"
```

### Dash positions

```text
dash-1  REFUSE  "bench 185 5/2 then 3 sets of 8\u058a165"
dash-2  REFUSE  "bench 185 5/2 then 3 sets of 8\u2e3avia165"
dash-3  REFUSE  "bench 185 5/2 then 3 sets of 8 via\u2212165"
dash-4  REFUSE  "bench 185 5/2 then 3\u2011total\u2010sets8\u2015at165"
dash-5  REFUSE  "bench 185 5/2 then 3 sets of 8 \ud803\udd6e 165"
dash-6  REFUSE  "bench 185 5/2 then 3 sets of 8\u02d7at165"
```

### Mixed notation

```text
mixed-1  REFUSE  "bench 185 5/2 then **3**sets[of]8\ufe0f\u20e3\u2014via\u2715165lb"
mixed-2  REFUSE  "bench 185 5/2 then three\u2723sets\u2215eight\u00ad@one-hundred-sixty-five"
mixed-3  REFUSE  "bench 185 5/2 then 3\u00bbsets8\u2474via\u2011\uff11\uff16\uff15"
mixed-4  REFUSE  "bench 185 5/2 then 3sets of8.165"
mixed-5  REFUSE  "bench 185 5/2 then 3 sets of 8165 at one hundred"
```

### Repeated values and order

```text
collision-1  REFUSE  "bench 165 8/2 x3 then 3 sets of 8 at 165"
collision-2  REFUSE  "bench three sets of eight at 165 then 165 8/2 x3"
collision-3  REFUSE  "bench 165 8/2 x3 then 3 sets of eight at 166"
collision-4  REFUSE  "bench 185 5/2 x2 then 3 sets x2 at 185"
collision-5  REFUSE  "bench 185 5/2 x2 then 3 sets of 5 x2 at 185"
```

### Exercise and line scope

```text
scope-1  REFUSE  "bench 185 5/2 then squat 225 3sets8 via 155"
scope-2  LOG  "bench 185 5/2\nsquat 225 3 sets8 via 155"
scope-3  REFUSE  "bench 185 5/2 then 3\nsets8\u2060at165"
scope-4  REFUSE  "bench 185 5/2\n\nThen 3 sets8\u2026at165."
scope-5  LOG  "bench 185 5/2\nsquat 225 5/2\nbench 205 5/2 then 3 sets8 via 155"
scope-6  LOG  "bench 185 5/2\nbench 165 8/2"
scope-7  REFUSE  "bench 185 5/2\nsquat 225 5/2 then 3 sets8 at 165"
scope-8  REFUSE  "bench 185 5/2\nsquat 225 5/2\nbench 205 5/2 then 3 sets8 at 165"
scope-9  REFUSE  "bench 185 5/2\nsquat 225 3 sets of 8 at 165"
```

### Weightless claims and recaps

```text
r2-1  REFUSE  "bench 185 5/2 then three sets of nine, same as earlier"
r2-2  REFUSE  "bench 185 5/2 then 3 sets ofnine"
r2-3  REFUSE  "bench 185 5/2 then three sets of eight reps only"
r2-4  REFUSE  "bench 185 8/2 x3 (three sets of eight)" · extra ask
r2-5  REFUSE  "bench 185 8/2 x3 then (three sets of eight)"
r2-6  LOG  "bench 185 8/2 x3 three sets done"
r2-7  REFUSE  "bench 185 8/2 x3 (three sets of eight)"
r2-8  REFUSE  "bench 185 5/2 then threesetsofeight"
r2-9  REFUSE  "bench 185 5/2 then 3 totalsets ofeight"
```

### Ownership of parsed prose

```text
affirm-1  LOG  "Goblet Squat 37 pound one, 4 sets of 9"
affirm-2  LOG  "Goblet Squat 37 pound one, 4 sets of 9. Tank answer: 1. Maybe 1."
affirm-3  REFUSE  "Goblet Squat 37 pound one, 4 sets of 9 at two hundred"
affirm-4  LOG  "did 4 sets of bench 175 6/2 x4"
affirm-5  REFUSE  "did 4 sets of bench 175 6/2 x3"
affirm-6  LOG  "bench all 3 sets stopped at 8 instead of 10"
affirm-7  REFUSE  "bench all 3 sets stopped at 8 instead of 10 then three sets of eight at thirty"
affirm-8  LOG  "Rows done, 30 pounds, 10 each arm, 3 sets. Tank answer: 2. Plank 40 seconds!! That is a record for me."
affirm-9  LOG  "Ok squats done!! I did the 35 pound one, 3 sets of 10. Honestly the last set the answer was like... 1? Maybe 1."
```

- `affirm-6` supplies `{"todayPlan":["Bench Press 185 10/2 x3"]}`.

- `affirm-7` supplies `{"todayPlan":["Bench Press 185 10/2 x3"]}`.

- `affirm-8` supplies `{"todayPlan":["One-Arm Row 30 10 x3"]}`.

- `affirm-9` supplies `{"todayPlan":["Goblet Squat 35 10/2 x3"]}`.

### Ordinary logs and embedded words

```text
negative-1  LOG  "bench 155 6/2 x8."
negative-2  LOG  "bench 155 6/2 x08"
negative-3  LOG  "bench 155 6/2, felt solid"
negative-4  LOG  "bench 155 6/2 did three sets of bench"
negative-5  LOG  "bench 3x6@155 3 sets"
negative-6  LOG  "bench 155 6/2 then 3 sets for time"
negative-7  REFUSE  "bench 185 5/2 x2 headset is gone" · extra ask
negative-8  LOG  "bench 185 5/2 x2 my mindset improved"
```

### Extra text beside a positive control

```text
repair-1  REFUSE  "Goblet Squat 35 pound one, 3 sets of 10. Tank answer: 2. Then 3 sets of ten at thirty-five."
repair-2  REFUSE  "bench 185 8/2 x3 (three sets of eight) then three sets of eight at one hundred"
repair-3  REFUSE  "bench 185 8/2 x3 (three sets of eight at 165)"
repair-4  REFUSE  "bench 185 8/2 x3 (four sets of eight)"
repair-5  REFUSE  "bench 185 8/2 x3 (three sets of nine)"
repair-6  REFUSE  "bench 185 5/2 x3 did 3 sets\nbench 165 8/2" · extra ask
```

### Words with embedded anchors

```text
weak-1  REFUSE  "bench 185 5/2 then 3 very totalsetsaround ofeight"
weak-2  REFUSE  "bench 185 5/2 then x3 very worksetsagain ofeight"
weak-3  REFUSE  "bench 185 5/2 x3 worksets ofeight"
weak-4  REFUSE  "bench 185 5/2 x3 worksets ofeight atone"
weak-5  REFUSE  "bench 185 5/2 x2 headset is gone on my phone" · extra ask
weak-6  LOG  "bench 185 5/2 x2 headset feels fine"
weak-7  REFUSE  "bench 205 4/3 x2 headset is gone" · extra ask
```

### Direct parser evidence

```text
evidence-1  REFUSE  "bench 185 5/2 then 3 sets \u2715 of about roughly maybe 8 at 165"
evidence-2  REFUSE  "squat 225 3 sets8\u2192155"
evidence-3  REFUSE  "did 3 sets of bench 185 5/2 x3"
evidence-4  REFUSE  "bench 185 5/2\nsquat 225 5/2\nbench 205 5/2 then 3 sets8 at 155"
evidence-5  LOG  "bench 185 5/2\n3 sets8 at 155"
evidence-6  REFUSE  "bench 185 5/2\n3 sets8 at 155\n3 sets8 at 155"
evidence-7  LOG  "bench 185 5/2 did three sets of bench squat 225 5/2"
evidence-8  REFUSE  "Goblet Squat 35 pound one, 3 sets of 10. Tank answer: 1."
```

- `evidence-1` uses a supplied parser result. Upstream long-connector refusal removed by construction.

- `evidence-2` uses a supplied parser result. Bare W R is the only emitted sibling.

- `evidence-3` uses a supplied parser result. Matching count cannot authorize a mismatched weight.

- `evidence-4` uses a supplied parser result. Merged-away line needs turn-wide exposure.

- `evidence-5` uses a supplied parser result. Already surfaced full unresolved line.

- `evidence-6` uses a supplied parser result. An unresolved occurrence cannot exempt two identical lines.

- `evidence-7` uses a supplied parser result. Do not borrow reps or weight from the adjacent child.

- `evidence-8` uses a supplied parser result. Matching rows with the wrong stated RIR cannot prove ownership.

### Ownership boundaries

```text
boundaries-1  REFUSE  "bench 185 5/2 squat 225 3 sets8 at 165"
boundaries-2  REFUSE  "bench 185 5/2\nsquat 3 sets8 at 165"
boundaries-3  LOG  "Goblet Squat 35 pound one,\n3 sets of 10"
boundaries-4  LOG  "bench 185 5/2 squat 225 5/2"
boundaries-5  REFUSE  "bench 185 5/2\n\nThree sets of 8 at one hundred and sixty-five."
```

- `boundaries-1` uses a supplied parser result. The last quantity in a child is the count of a frame that continues in uncovered original text.

- `boundaries-2` uses a supplied parser result. A child with no rows and no unresolved notice cannot claim source text.

- `boundaries-4` uses a supplied parser result. Adjacent complete child intervals stay separate.

### Counted exercise introductions

```text
intro-1  LOG  "did three sets of bench 3x8@165"
intro-2  LOG  "did 3 sets of bench 185 x 5 x 3"
intro-3  LOG  "did 3 sets of bench 185 for 5 three times"
intro-4  REFUSE  "did three sets of bench 2x8@165"
intro-5  REFUSE  "did three sets of bench 3x8@165 then 3 sets of six at one hundred"
intro-6  LOG  "did 1 set of bench 185 5/2"
```
