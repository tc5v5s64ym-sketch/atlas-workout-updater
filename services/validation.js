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

function calculateQualityScore({ totalSets, effortDuration, averageHR, uniqueExercisesCount, validationWarnings }) {
  let score = 0;
  if (Number.isFinite(totalSets) && totalSets >= 10) {
    score += 1;
  }

  const durationMinutes = parseDurationMinutes(effortDuration);
  if (durationMinutes >= 30) {
    score += 1;
  }

  const avgHR = parseNumber(averageHR);
  if (avgHR !== null && avgHR >= 100) {
    score += 1;
  }

  if (Number.isFinite(uniqueExercisesCount) && uniqueExercisesCount >= 3) {
    score += 1;
  }

  if (!Array.isArray(validationWarnings) || validationWarnings.length === 0) {
    score += 1;
  }

  return score;
}

module.exports = {
  parseNumber,
  normalizeDate,
  parseDurationMinutes,
  getSimpleTrend,
  calculateQualityScore
};
