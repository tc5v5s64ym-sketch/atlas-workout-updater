'use strict';

// ── Prose-slot gate detector — Astra 6.2 design of record (#1765, comment
// 7049597345) ──────────────────────────────────────────────────────────────
//
// The detector supplies a boolean: does this previewable span contain an
// unaccounted prose set-group claim? The parser supplies every value in
// every row; the detector never constructs rows.
//
// Danger predicate (spec 2): a quantity interval, a set-label interval and
// another quantity interval in source order (R2; FULL contains R2, so R2
// suffices), in any one of three lowercase views, unless the entire span
// matches a documented form that accounts for the parser's actual rows
// (the native / plan-backed forms, spec 4). A refusal in any eligible view
// suffices; anchor intervals are never pooled across views.
//
// Intervals (specs 2–3): iterate Unicode scalar characters (Unicode 17.0
// properties; the runtime ICU is 16.0 — the only version-sensitive
// characters in the ledger are covered by the pinned confusables data).
// NUMBER is general category N (Nd, Nl, No); a maximal consecutive NUMBER
// run is one indivisible quantity. LETTER is category L. SPACE is
// White_Space union ECMAScript whitespace. MARK is the entire complement.
// A LETTER↔NUMBER transition is always a token boundary. A numeric run or
// SPACE interrupts a spelling; other MARKs may occur anywhere between its
// letters. Each LETTER projects through per-character NFKD, lowercase and
// removal of category M from that decomposition; a remaining non-ASCII
// character takes the Unicode 17.0 confusables MA mapping once if its
// target is entirely ASCII letters (pinned data in proseConfusables.js),
// otherwise it is kept — and a projected piece that is not entirely ASCII
// a–z interrupts the spelling. Reserved spellings are `set`/`sets` (S) and
// the word quantities zero–twenty, thirty–ninety, hundred, thousand,
// million, billion, trillion (word-Q). Two roles never reuse the same
// source character; intervals begin and end at complete source-character
// boundaries. Gaps admit arbitrary material, including nothing.
//
// The three views (spec 2): (1) original spelling, whitespace runs folded
// to one space, trimmed, lowercased; (2) normalizeParserText, lowercased;
// (3) normalizeGateText (normalizeWeightUnits, then the parser fold),
// lowercased. The spelling-preserving views retain boundaries the unit
// normalizer can erase (e.g. a pound mark before non-ASCII digits).
//
// Affirmative coverage (spec 4) is a whole-span comparison in the same
// view with the same local rows: the counted-introduction native forms,
// the weight-first C2 forms with the C2 tail grammar, and the C4 plan
// deviation. Absence of a field needed for a comparison makes the
// comparison fail. Row-count or value coincidence alone never discharges
// a claim.
//
// Span ownership (spec 6) lives in the gate, which calls
// hasUnaccountedProseInMultiWindows for the supplemental prose windows;
// this module exposes the per-view predicate it needs.

const { normalizeParserText, normalizeWeightUnits } = require('./workoutTextParser');
const { PROSE_CONFUSABLES_MA } = require('./proseConfusables');

// Word quantities: spelling → numeric value (ordinal in the design's list).
const WORD_Q_VALUES = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
  million: 1000000, billion: 1000000000, trillion: 1000000000000,
};
const WORD_Q_WORDS = Object.keys(WORD_Q_VALUES);

// Reserved spellings: S is `set`/`sets`; word-Q is the list above.
const RESERVED = [];
for (const spelling of ['set', 'sets']) RESERVED.push({ spelling, kind: 'S', value: null });
for (const spelling of WORD_Q_WORDS) {
  RESERVED.push({ spelling, kind: 'word', value: WORD_Q_VALUES[spelling] });
}

const NUMBER_RE = /\p{N}/u;
const LETTER_RE = /\p{L}/u;
const SPACE_RE = /[\p{White_Space}\s]/u;
const MARK_STRIP_RE = /\p{M}/gu;

function classifyChar(ch) {
  if (NUMBER_RE.test(ch)) return 'number';
  if (LETTER_RE.test(ch)) return 'letter';
  if (SPACE_RE.test(ch)) return 'space';
  return 'mark';
}

// Project one LETTER through NFKD, lowercase and category-M removal, then
// the MA mapping once per remaining non-ASCII character. Returns the
// projected ASCII letters, '' when nothing survives, or null when the
// piece is not entirely ASCII a–z (it interrupts the spelling).
function projectLetter(ch) {
  const decomposed = ch.normalize('NFKD').toLowerCase().replace(MARK_STRIP_RE, '');
  let out = '';
  for (const x of decomposed) {
    if (x >= 'a' && x <= 'z') {
      out += x;
      continue;
    }
    const mapped = PROSE_CONFUSABLES_MA[x.codePointAt(0)];
    if (mapped !== undefined) {
      out += String(mapped).toLowerCase();
      continue;
    }
    out += x;
  }
  if (out.length === 0) return '';
  return /^[a-z]+$/.test(out) ? out : null;
}

// The three views, as functions of the original text.
function viewOriginal(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}
function viewParser(value) {
  return normalizeParserText(String(value || '')).toLowerCase();
}
function viewGate(value) {
  return normalizeParserText(normalizeWeightUnits(String(value || ''))).toLowerCase();
}
const VIEW_FUNCTIONS = [viewOriginal, viewParser, viewGate];

function buildProseViews(value) {
  return VIEW_FUNCTIONS.map(fn => fn(value));
}

// Scan one view string for quantity intervals (numeric runs + word-Q
// spellings) and set-label intervals (`set`/`sets` spellings). Intervals
// carry UTF-16 offsets in the view string.
function scanView(text) {
  const q = [];
  const s = [];
  let numberStart = -1;
  let segment = [];
  const flushNumber = (end) => {
    if (numberStart >= 0) {
      q.push({ start: numberStart, end, kind: 'number', spelling: null, value: null });
      numberStart = -1;
    }
  };
  const flushSegment = () => {
    if (segment.length === 0) return;
    const joined = segment.map(l => l.ch).join('');
    for (const { spelling, kind, value } of RESERVED) {
      let idx = joined.indexOf(spelling);
      while (idx !== -1) {
        const interval = {
          start: segment[idx].start,
          end: segment[idx + spelling.length - 1].end,
          kind,
          spelling,
          value,
        };
        if (kind === 'S') s.push(interval);
        else q.push(interval);
        idx = joined.indexOf(spelling, idx + 1);
      }
    }
    segment = [];
  };
  let offset = 0;
  for (const ch of String(text || '')) {
    const cls = classifyChar(ch);
    if (cls === 'number') {
      flushSegment();
      if (numberStart < 0) numberStart = offset;
    } else if (cls === 'space') {
      flushNumber(offset);
      flushSegment();
    } else if (cls === 'letter') {
      flushNumber(offset);
      const piece = projectLetter(ch);
      if (piece === null) {
        flushSegment();
      } else if (piece.length > 0) {
        for (const letter of piece) {
          segment.push({ ch: letter, start: offset, end: offset + ch.length });
        }
      }
    } else {
      // MARK: ends a number run, never interrupts a spelling.
      flushNumber(offset);
    }
    offset += ch.length;
  }
  flushNumber(offset);
  flushSegment();
  q.sort((a, b) => a.start - b.start || a.end - b.end);
  s.sort((a, b) => a.start - b.start || a.end - b.end);
  return { q, s };
}

// The R2 danger predicate: a quantity, a set label and another quantity in
// source order, nonoverlapping, touching endpoints allowed.
function findR2(qs, ss) {
  for (const sInterval of ss) {
    let q1 = null;
    for (const qq of qs) {
      if (qq.end <= sInterval.start) q1 = qq;
      else break;
    }
    const q2 = qs.find(qq => qq.start >= sInterval.end);
    if (q1 && q2) return { q1, s: sInterval, q2 };
  }
  return null;
}

// ── Affirmative coverage (spec 4) ─────────────────────────────────────────

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Numeric field patterns from the design: D decimal, I integer, V digits
// or a zero–twenty word.
const D = '(\\d+(?:\\.\\d+)?)';
const I = '(\\d+)';
const V_WORD = '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)';
const V = `(?:\\d+|${V_WORD})`;

function valueOfV(token) {
  if (/^\d+$/.test(token)) return Number(token);
  return WORD_Q_VALUES[token];
}

// Code-point-aware neighbours in a JS string (UTF-16 offsets).
function charBefore(str, index) {
  if (index <= 0) return null;
  const low = str.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index - 2 >= 0) {
    const high = str.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return str.slice(index - 2, index);
  }
  return str[index - 1];
}
function charAt(str, index) {
  if (index >= str.length) return null;
  const high = str.charCodeAt(index);
  if (high >= 0xd800 && high <= 0xdbff && index + 1 < str.length) {
    const low = str.charCodeAt(index + 1);
    if (low >= 0xdc00 && low <= 0xdfff) return str.slice(index, index + 2);
  }
  return str[index];
}
function isLetterOrNumber(ch) {
  return ch !== null && (LETTER_RE.test(ch) || NUMBER_RE.test(ch));
}

// Candidate owner names: literal lowercase parser-normalized raw_name,
// canonical_name or exercise. Excludes empty names, names containing
// category N, and names containing an S interval.
function namesFrom(parsed) {
  const out = [];
  const raw = parsed
    ? [parsed.raw_name, parsed.canonical_name, parsed.exercise]
    : [];
  for (const candidate of raw) {
    if (typeof candidate !== 'string') continue;
    const name = candidate.toLowerCase().trim();
    if (!name) continue;
    if (NUMBER_RE.test(name)) continue;
    if (scanView(name).s.length > 0) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

// A narrative prefix may contain at most the first complete NAME (longest
// on a tie, non-L/non-N or string ends on both sides); the rest must have
// no S interval, no numeric glyph and no whole word-Q interval.
function prefixEligible(prefixText, names) {
  let rest = String(prefixText || '');
  let best = null;
  for (const name of names) {
    let idx = rest.indexOf(name);
    while (idx !== -1) {
      const beforeOk = !isLetterOrNumber(charBefore(rest, idx));
      const afterOk = !isLetterOrNumber(charAt(rest, idx + name.length));
      if (beforeOk && afterOk) {
        if (!best || idx < best.start || (idx === best.start && name.length > best.name.length)) {
          best = { start: idx, end: idx + name.length, name };
        }
        break;
      }
      idx = rest.indexOf(name, idx + 1);
    }
  }
  if (best) rest = `${rest.slice(0, best.start)} ${rest.slice(best.end)}`;
  if (NUMBER_RE.test(rest)) return false;
  const { q, s } = scanView(rest);
  if (s.length > 0) return false;
  for (const interval of q) {
    if (interval.kind !== 'word') continue;
    const beforeOk = !LETTER_RE.test(charBefore(rest, interval.start) || '');
    const afterOk = !LETTER_RE.test(charAt(rest, interval.end) || '');
    if (beforeOk && afterOk) return false;
  }
  return true;
}

// A neutral tail has no S or Q interval at all, including embedded readings.
function isNeutralTail(text) {
  const { q, s } = scanView(text);
  return q.length === 0 && s.length === 0;
}

function rowsMatchWeightReps(rows, weight, reps) {
  return rows.every(row => Number(row.weight) === weight && Number(row.reps) === reps);
}
function rowsMatchWeightRepsRir(rows, weight, reps, rir) {
  return rows.every(row => Number(row.weight) === weight && Number(row.reps) === reps
    && Number(row.rir) === rir);
}

// Counted-introduction native forms. Each returns true when the whole view
// is one complete native statement accounting for the rows.
function matchNativeSlash(viewText, rows, names) {
  for (const name of names) {
    const re = new RegExp(
      `(^| )(${V}) sets? of ${escapeRegExp(name)} ${D} ${I}/${D}(?: x\\s*${I})?[.!?]*$`, 'g');
    let m;
    while ((m = re.exec(viewText)) !== null) {
      const prefix = viewText.slice(0, m.index + m[1].length);
      const count = valueOfV(m[2]);
      const weight = Number(m[3]);
      const reps = Number(m[4]);
      const rir = Number(m[5]);
      const k = m[6] === undefined ? 1 : Number(m[6]);
      if (k < 1 || k > 10) continue;
      if (count !== k || k !== rows.length) continue;
      if (!rowsMatchWeightRepsRir(rows, weight, reps, rir)) continue;
      if (!prefixEligible(prefix, names)) continue;
      return true;
    }
  }
  return false;
}

function matchNativeVariants(viewText, rows, names) {
  const variants = [
    // `K x R @ W` — zero or more ordinary spaces around the native x/@.
    // Groups after the intro: 3 = K, 4 = R, 5 = W.
    {
      re: `(\\d+)\\s*x\\s*(\\d+)\\s*@\\s*${D}`,
      cap: 10,
      read: m => ({ k: Number(m[3]), reps: Number(m[4]), weight: Number(m[5]) }),
    },
    // `W x R x K` — groups after the intro: 3 = W, 4 = R, 5 = K.
    {
      re: `${D}\\s*x\\s*(\\d+)\\s*x\\s*(\\d+)`,
      cap: 10,
      read: m => ({ weight: Number(m[3]), reps: Number(m[4]), k: Number(m[5]) }),
    },
    // `W for R K times` — the for/times words keep the displayed spaces;
    // K is I or one–five, and the parser's repeat count has no 10-cap.
    // Groups after the intro: 3 = W, 4 = R, 5 = K.
    {
      re: `${D} for (\\d+) (\\d+|one|two|three|four|five) times`,
      cap: null,
      read: m => ({ weight: Number(m[3]), reps: Number(m[4]), k: valueOfV(m[5]) }),
    },
  ];
  for (const name of names) {
    for (const variant of variants) {
      const re = new RegExp(`(^| )(${V}) sets? of ${escapeRegExp(name)} ${variant.re}[.!?]*$`, 'g');
      let m;
      while ((m = re.exec(viewText)) !== null) {
        const prefix = viewText.slice(0, m.index + m[1].length);
        const count = valueOfV(m[2]);
        const { k, reps, weight } = variant.read(m);
        if (k < 1) continue;
        if (variant.cap !== null && k > variant.cap) continue;
        if (count !== k || k !== rows.length) continue;
        if (!rowsMatchWeightReps(rows, weight, reps)) continue;
        if (!prefixEligible(prefix, names)) continue;
        return true;
      }
    }
  }
  return false;
}

function matchCompletion(viewText, rows, names) {
  for (const name of names) {
    const re = new RegExp(
      `^${escapeRegExp(name)} ${D} ${I}/${D} x\\s*${I} (${V}) sets? done[.!?]*$`);
    const m = re.exec(viewText);
    if (!m) continue;
    const weight = Number(m[1]);
    const reps = Number(m[2]);
    const rir = Number(m[3]);
    const k = Number(m[4]);
    const count = valueOfV(m[5]);
    if (k < 1 || k > 10) continue;
    if (count !== k || k !== rows.length) continue;
    if (!rowsMatchWeightRepsRir(rows, weight, reps, rir)) continue;
    return true;
  }
  return false;
}

// C2 weight-first forms A and B, with the C2 tail grammar. Returns true
// when prefix + exactly one payload + tail covers the whole view.
function matchC2(viewText, rows, names) {
  const forms = [
    {
      // A: `W ~ pound(s) [,] ~ R ~ (each arm | per arm | per side) [,] ~ C ~ set(s)`
      re: new RegExp(`${D}\\s*pounds?\\s*,?\\s*${I}\\s*(each arm|per arm|per side)\\s*,?\\s*${I}\\s*sets?`, 'g'),
      perHand: true,
      // Groups: 1 = W, 2 = R, 3 = the arm phrase, 4 = C.
      read: m => ({ weight: Number(m[1]), reps: Number(m[2]), count: Number(m[4]) }),
    },
    {
      // B: `W ~ pound(s) [,] ~ [one [,] ~] C ~ set(s) SPACE+ of SPACE+ R`
      re: new RegExp(`${D}\\s*pounds?\\s*,?\\s*(?:one\\s*,?\\s*)?${I}\\s*sets?\\s+of\\s+${I}`, 'g'),
      perHand: false,
      read: m => ({ weight: Number(m[1]), count: Number(m[2]), reps: Number(m[3]) }),
    },
  ];
  for (const form of forms) {
    const matches = [...viewText.matchAll(form.re)];
    if (matches.length !== 1) continue;
    const m = matches[0];
    const { weight, reps, count } = form.read(m);
    if (count < 1 || count > 10) continue;
    if (count !== rows.length) continue;
    if (!rowsMatchWeightReps(rows, weight, reps)) continue;
    if (form.perHand && !rows.every(row => row.load_note === 'per_hand')) continue;
    const prefix = viewText.slice(0, m.index);
    if (!prefixEligible(prefix, names)) continue;
    const tail = viewText.slice(m.index + m[0].length);
    if (!matchC2Tail(tail, rows)) continue;
    return true;
  }
  return false;
}

// The C2 tail: at most one C3 answer at the start, then at most one
// restated `maybe D`, then at most one timed plank sentence; the remainder
// must be a neutral tail. No answer present imposes no RIR requirement.
function matchC2Tail(tail, rows) {
  const pad = '[\\s.,!?;:]*';
  const tankRe = new RegExp(`^${pad}tank answer\\s*:?\\s*${D}`);
  const answerRe = new RegExp(
    `^${pad}(?:honestly )?(?:the )?(?:last set )?(?:the )?answer was (?:like\\s*)?\\.+\\s*${D}`);
  let rest = tail;
  let answer = null;
  let m = tankRe.exec(rest);
  if (m) {
    answer = { value: Number(m[1]), kind: 'all' };
    rest = rest.slice(m[0].length);
  } else {
    m = answerRe.exec(rest);
    if (m) {
      answer = { value: Number(m[1]), kind: 'last' };
      rest = rest.slice(m[0].length);
    }
  }
  if (answer) {
    if (answer.kind === 'all') {
      if (!rows.every(row => Number(row.rir) === answer.value && row.rir_source !== 'plan')) {
        return false;
      }
    } else {
      const last = rows[rows.length - 1];
      if (!(Number(last.rir) === answer.value && last.rir_source !== 'plan')) return false;
      for (const row of rows.slice(0, -1)) {
        if (!(row.rir === null || row.rir === undefined || row.rir_source === 'plan')) return false;
      }
    }
    // At most one immediately following `pad maybe D`, restating the value.
    const maybeRe = new RegExp(`^${pad}maybe\\s+${D}`);
    const maybe = maybeRe.exec(rest);
    if (maybe) {
      if (Number(maybe[1]) !== answer.value) return false;
      rest = rest.slice(maybe[0].length);
    }
    // At most one separate timed sentence prefix.
    const plankRe = /^\s*[.!?]+\s+plank\s+(\d+(?:\.\d+)?)\s+seconds?\b/;
    const plank = plankRe.exec(rest);
    if (plank) rest = rest.slice(plank[0].length);
  }
  return isNeutralTail(rest);
}

// C4 plan deviation: every row plan-sourced; one `\ball I sets?\b` and one
// `\bstopped at D instead of D\b` in either order; the count equals the
// emitted rows, the first deviation value is the reps on every row and the
// second differs; remove those two occurrences and at most the first
// separate `\brep I\b` narrative index; the remainder must be neutral.
function matchC4(viewText, rows) {
  if (!rows.every(row => row.weight_source === 'plan')) return false;
  const countRe = /\ball (\d+) sets?\b/;
  const devRe = /\bstopped at (\d+(?:\.\d+)?) instead of (\d+(?:\.\d+)?)\b/;
  const countM = countRe.exec(viewText);
  const devM = devRe.exec(viewText);
  if (!countM || !devM) return false;
  if (viewText.match(new RegExp(countRe.source, 'g')).length !== 1) return false;
  if (viewText.match(new RegExp(devRe.source, 'g')).length !== 1) return false;
  const count = Number(countM[1]);
  if (count < 1 || count > 10) return false;
  if (count !== rows.length) return false;
  const first = Number(devM[1]);
  const second = Number(devM[2]);
  if (!rows.every(row => Number(row.reps) === first)) return false;
  if (second === first) return false;
  let rest = viewText.replace(countM[0], ' ').replace(devM[0], ' ');
  rest = rest.replace(/\brep \d+\b/, ' ');
  return isNeutralTail(rest);
}

function isCovered(viewText, rows, names) {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  return matchNativeSlash(viewText, rows, names)
    || matchNativeVariants(viewText, rows, names)
    || matchCompletion(viewText, rows, names)
    || matchC2(viewText, rows, names)
    || matchC4(viewText, rows);
}

// The per-view predicate: an R2 candidate without whole-span affirmative
// coverage in this view.
function hasUnaccountedProseInView(viewText, rows, names) {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  const { q, s } = scanView(viewText);
  if (!findR2(q, s)) return false;
  return !isCovered(viewText, rows, names);
}

// The prose boolean for one span: any view with an uncovered R2 vetoes.
function hasUnaccountedProseFrame(originalText, rows, names) {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  for (const viewText of buildProseViews(originalText)) {
    if (hasUnaccountedProseInView(viewText, rows, names)) return true;
  }
  return false;
}

// ── Multi-exercise prose windows (spec 6) ────────────────────────────────
//
// Per view: flatten the original request (one transformed line per source
// line, joined with one space), locate each child with rows by its exact
// transformed text (unique occurrence, space-delimited), mark positively
// located unresolved lines as hard cuts, disqualify intersecting child
// intervals, and scan each remaining region. A region with no located
// child is scanned whole with turn-wide rows and no coverage; a region
// with children is scanned as one maximal window per child (preceding
// child's end to following child's start) with only that child's rows for
// coverage. A zero-row child cannot mask its text.
function hasUnaccountedProseInMultiWindows(originalText, children, unresolvedLines, allRows) {
  const located = (Array.isArray(children) ? children : [])
    .filter(child => child && Array.isArray(child.sets) && child.sets.length > 0);
  const unresolved = Array.isArray(unresolvedLines) ? unresolvedLines : [];
  const wideRows = Array.isArray(allRows) ? allRows : [];
  if (wideRows.length === 0) return false;

  for (const viewFn of VIEW_FUNCTIONS) {
    const lines = String(originalText || '')
      .split(/\r?\n/)
      .map(line => viewFn(line))
      .filter(line => line.length > 0);
    if (lines.length === 0) continue;
    const spans = [];
    let flattened = '';
    for (const line of lines) {
      const start = flattened.length;
      flattened += (flattened ? ' ' : '') + line;
      spans.push({ start, end: flattened.length, text: line });
    }
    // Child intervals (unique, space-delimited occurrences only).
    const intervals = [];
    for (const child of located) {
      const childText = viewFn(child.raw_text || '');
      if (!childText) continue;
      const occurrences = [];
      let from = 0;
      for (;;) {
        const idx = flattened.indexOf(childText, from);
        if (idx === -1) break;
        occurrences.push(idx);
        from = idx + 1;
      }
      if (occurrences.length !== 1) continue;
      const start = occurrences[0];
      const end = start + childText.length;
      const beforeOk = start === 0 || flattened[start - 1] === ' ';
      const afterOk = end === flattened.length || flattened[end] === ' ';
      if (!beforeOk || !afterOk) continue;
      intervals.push({ start, end, child });
    }
    // Unresolved line intervals: the line equals an actual unresolved line
    // in this view and occurs exactly once among the transformed lines.
    const unresolvedTexts = new Set(unresolved.map(line => viewFn(line)));
    const lineCounts = new Map();
    for (const line of lines) lineCounts.set(line, (lineCounts.get(line) || 0) + 1);
    const cuts = [];
    for (const span of spans) {
      if (unresolvedTexts.has(span.text) && lineCounts.get(span.text) === 1) {
        cuts.push({ start: span.start, end: span.end });
      }
    }
    // Disqualify intersecting child intervals (either side).
    const kept = intervals.filter(a => !intervals.some(b => b !== a
      && a.start < b.end && b.start < a.end));
    // Regions are the flattened string split by the hard cuts.
    const regions = [];
    let cursor = 0;
    for (const cut of [...cuts].sort((a, b) => a.start - b.start)) {
      if (cut.start > cursor) regions.push({ start: cursor, end: cut.start });
      cursor = Math.max(cursor, cut.end);
    }
    if (cursor < flattened.length) regions.push({ start: cursor, end: flattened.length });
    for (const region of regions) {
      const inRegion = kept
        .filter(iv => iv.start >= region.start && iv.end <= region.end)
        .sort((a, b) => a.start - b.start);
      if (inRegion.length === 0) {
        const text = flattened.slice(region.start, region.end);
        if (hasUnaccountedProseInView(text, wideRows, [])) return true;
      } else {
        for (let i = 0; i < inRegion.length; i += 1) {
          const windowStart = i === 0 ? region.start : inRegion[i - 1].end;
          const windowEnd = i === inRegion.length - 1 ? region.end : inRegion[i + 1].start;
          const text = flattened.slice(windowStart, windowEnd);
          const childNames = namesFrom(inRegion[i].child);
          if (hasUnaccountedProseInView(text, inRegion[i].child.sets, childNames)) return true;
        }
      }
    }
  }
  return false;
}

module.exports = {
  buildProseViews,
  scanView,
  findR2,
  namesFrom,
  prefixEligible,
  isNeutralTail,
  isCovered,
  matchNativeSlash,
  matchNativeVariants,
  matchCompletion,
  matchC2,
  matchC2Tail,
  matchC4,
  hasUnaccountedProseInView,
  hasUnaccountedProseFrame,
  hasUnaccountedProseInMultiWindows,
};
