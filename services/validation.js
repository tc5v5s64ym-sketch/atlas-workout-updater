function parseNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  const normalized = String(value).trim().replace(/,/g, '');
  if (normalized === '') {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDate(value) {
  if (value === null || value === undefined) {
    return '';
  }

  const text = String(value).trim();
  if (!text) {
    return '';
  }

  const isoDateMatch = text.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (isoDateMatch) {
    return isoDateMatch[1];
  }

  const isoDateTimeMatch = text.match(/^(\d{4}-\d{2}-\d{2})(?:[ T].*)$/);
  if (isoDateTimeMatch) {
    return isoDateTimeMatch[1];
  }

  // Excel/Sheets serial dates arrive as a bare number. Convert these BEFORE the
  // generic `new Date(text)` fallback below — that fallback parses "45000" as the
  // YEAR 45000 (a valid Date), so without this ordering the serial branch is
  // unreachable and a serial date is silently saved as a wrong far-future ISO
  // date (AUDIT HI-4).
  if (typeof value === 'number' && Number.isFinite(value)) {
    const msPerDay = 24 * 60 * 60 * 1000;
    const excelEpoch = new Date(Date.UTC(1899, 11, 30)).getTime();
    const date = new Date(excelEpoch + Math.round(value) * msPerDay);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString().slice(0, 10);
    }
  }

  const parsedDate = new Date(text);
  if (!Number.isNaN(parsedDate.getTime())) {
    return parsedDate.toISOString().slice(0, 10);
  }

  return '';
}

function parseDurationMinutes(duration) {
  if (duration === null || duration === undefined || duration === '') {
    return 0;
  }

  if (typeof duration === 'number' && Number.isFinite(duration)) {
    return duration;
  }

  const text = String(duration).trim();
  if (!text) {
    return 0;
  }

  const parts = text.split(':').map(part => part.trim());
  if (parts.length === 1) {
    const numericValue = parseNumber(parts[0]);
    return numericValue === null ? 0 : numericValue;
  }

  if (parts.length === 2) {
    const minutes = parseNumber(parts[0]);
    const seconds = parseNumber(parts[1]);
    if (minutes === null || seconds === null) {
      return 0;
    }
    return minutes + seconds / 60;
  }

  if (parts.length === 3) {
    const hours = parseNumber(parts[0]);
    const minutes = parseNumber(parts[1]);
    const seconds = parseNumber(parts[2]);
    if (hours === null || minutes === null || seconds === null) {
      return 0;
    }
    return hours * 60 + minutes + seconds / 60;
  }

  return 0;
}

function getSimpleTrend(values) {
  if (!Array.isArray(values) || values.length < 2) {
    return 'flat';
  }

  const filtered = values.filter(v => typeof v === 'number' && Number.isFinite(v));
  if (filtered.length < 2) {
    return 'flat';
  }

  const last = filtered[filtered.length - 1];
  const previous = filtered[filtered.length - 2];

  if (last > previous) {
    return 'up';
  }

  if (last < previous) {
    return 'down';
  }

  return 'flat';
}

// 0–100 quality score broken into five weighted criteria.
// Each criterion's score() returns { points, description } where description
// contains the actual session numbers (e.g. "14 sets — solid session").
// qualityScoreBreakdown is the single source of truth; calculateQualityScore
// sums the earned points.
const QUALITY_CRITERIA = [
  {
    id: 'volume',
    label: 'Volume',
    maxPoints: 30,
    score({ totalSets }) {
      const n = Number.isFinite(totalSets) ? totalSets : 0;
      if (n >= 12) return { points: 30, description: `${n} sets — solid session` };
      if (n >= 9)  return { points: 22, description: `${n} sets — good output` };
      if (n >= 6)  return { points: 14, description: `${n} sets — moderate volume` };
      if (n >= 3)  return { points: 6,  description: `${n} sets — light session` };
      return { points: 0, description: `${n} set${n === 1 ? '' : 's'} logged` };
    }
  },
  {
    id: 'intensity',
    label: 'Intensity',
    maxPoints: 25,
    score({ setsWithRir }) {
      if (!Array.isArray(setsWithRir) || setsWithRir.length === 0) {
        return { points: 12, description: 'No RIR tracked — add proximity to failure data' };
      }
      const avg = setsWithRir.reduce((s, v) => s + v, 0) / setsWithRir.length;
      const str = avg.toFixed(1);
      if (avg <= 1)  return { points: 25, description: `Avg ${str} RIR — working close to failure` };
      if (avg <= 2)  return { points: 20, description: `Avg ${str} RIR — leaving little in reserve` };
      if (avg <= 3)  return { points: 13, description: `Avg ${str} RIR — moderate effort` };
      return { points: 5, description: `Avg ${str} RIR — room to push harder` };
    }
  },
  {
    id: 'effort',
    label: 'Effort',
    maxPoints: 25,
    score({ effortDuration, averageHR, activeCalories }) {
      const mins = parseDurationMinutes(effortDuration);
      const hr   = parseNumber(averageHR);
      const cal  = parseNumber(activeCalories);
      if (mins === 0 && hr === null) {
        return { points: 10, description: 'No fitness device data this session' };
      }
      let pts = 0;
      if (mins >= 60)      pts += 12;
      else if (mins >= 45) pts += 10;
      else if (mins >= 30) pts += 7;
      else if (mins >= 20) pts += 4;
      if (hr !== null) {
        if (hr >= 120)      pts += 13;
        else if (hr >= 100) pts += 10;
        else if (hr >= 80)  pts += 6;
        else                pts += 2;
      }
      const parts = [];
      if (mins > 0) parts.push(`${Math.round(mins)} min`);
      if (hr !== null) parts.push(`${Math.round(hr)} bpm avg`);
      if (cal !== null && cal > 0) parts.push(`${Math.round(cal)} cal`);
      return { points: Math.min(pts, 25), description: parts.join(' · ') || 'Effort recorded' };
    }
  },
  {
    id: 'balance',
    label: 'Balance',
    maxPoints: 10,
    score({ uniqueExercisesCount }) {
      const n = Number.isFinite(uniqueExercisesCount) ? uniqueExercisesCount : 0;
      if (n >= 4) return { points: 10, description: `${n} exercises — well-rounded session` };
      if (n >= 3) return { points: 7,  description: `${n} exercises — good variety` };
      if (n >= 2) return { points: 4,  description: `${n} exercises` };
      return { points: 0, description: `${n} exercise${n === 1 ? '' : 's'} — try adding variety` };
    }
  },
  {
    id: 'progression',
    label: 'Progression',
    maxPoints: 10,
    score({ sessionBestByLift, historicalBestByLift }) {
      const sessionLifts = sessionBestByLift || {};
      const histLifts    = historicalBestByLift || {};
      const liftCodes    = Object.keys(sessionLifts);
      if (liftCodes.length === 0) return { points: 0, description: 'No weighted sets to track' };
      const histKnown = liftCodes.filter(lc => lc in histLifts);
      if (histKnown.length === 0) return { points: 5, description: 'Not enough history to compare yet' };
      let prExercise = null;
      let improving = 0;
      for (const lc of histKnown) {
        if (sessionLifts[lc].weight > histLifts[lc]) {
          improving++;
          if (!prExercise) prExercise = sessionLifts[lc].exercise || lc;
        }
      }
      if (prExercise) return { points: 10, description: `New best on ${prExercise}` };
      if (improving > 0) return { points: 7, description: `${improving} lift${improving === 1 ? '' : 's'} improving` };
      return { points: 3, description: 'Holding steady — no new records this session' };
    }
  }
];

// Returns per-criterion breakdown with earned points, max points, and a
// session-specific description string. The frontend renders this as the
// tappable "how we scored this" popover.
function qualityScoreBreakdown(metrics = {}) {
  return QUALITY_CRITERIA.map(({ id, label, maxPoints, score }) => {
    const { points, description } = score(metrics);
    return { id, label, points, maxPoints, description };
  });
}

function calculateQualityScore(metrics) {
  return qualityScoreBreakdown(metrics).reduce((sum, c) => sum + c.points, 0);
}

module.exports = {
  parseNumber,
  normalizeDate,
  parseDurationMinutes,
  getSimpleTrend,
  calculateQualityScore,
  qualityScoreBreakdown
};
