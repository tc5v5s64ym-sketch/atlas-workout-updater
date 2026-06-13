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

  const parsedDate = new Date(text);
  if (!Number.isNaN(parsedDate.getTime())) {
    return parsedDate.toISOString().slice(0, 10);
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const msPerDay = 24 * 60 * 60 * 1000;
    const excelEpoch = new Date(Date.UTC(1899, 11, 30)).getTime();
    const date = new Date(excelEpoch + Math.round(value) * msPerDay);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString().slice(0, 10);
    }
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

// Single source of truth for the five quality criteria. Each label is the
// human-readable line the "how we scored this" popover shows; each test maps
// the same metric inputs calculateQualityScore has always used to a boolean.
const QUALITY_CRITERIA = [
  {
    label: '10 or more sets',
    test: ({ totalSets }) => Number.isFinite(totalSets) && totalSets >= 10
  },
  {
    label: '30 or more minutes',
    test: ({ effortDuration }) => parseDurationMinutes(effortDuration) >= 30
  },
  {
    label: 'Average heart rate 100+',
    test: ({ averageHR }) => {
      const avgHR = parseNumber(averageHR);
      return avgHR !== null && avgHR >= 100;
    }
  },
  {
    label: '3 or more exercises',
    test: ({ uniqueExercisesCount }) =>
      Number.isFinite(uniqueExercisesCount) && uniqueExercisesCount >= 3
  },
  {
    label: 'No data warnings',
    test: ({ validationWarnings }) =>
      !Array.isArray(validationWarnings) || validationWarnings.length === 0
  }
];

// Per-criterion verdicts for the same inputs calculateQualityScore receives.
// The frontend renders this as the tappable "how we arrived at the score" card.
function qualityScoreBreakdown(metrics = {}) {
  return QUALITY_CRITERIA.map(({ label, test }) => ({ label, met: test(metrics) }));
}

function calculateQualityScore(metrics) {
  return qualityScoreBreakdown(metrics).reduce((score, { met }) => score + (met ? 1 : 0), 0);
}

module.exports = {
  parseNumber,
  normalizeDate,
  parseDurationMinutes,
  getSimpleTrend,
  calculateQualityScore,
  qualityScoreBreakdown
};
