'use strict';

function getLocalDateString(dateTime = new Date()) {
  const year = dateTime.getFullYear();
  const month = String(dateTime.getMonth() + 1).padStart(2, '0');
  const day = String(dateTime.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDateForSessionId(dateValue) {
  const clean = String(dateValue || '').replace(/[^0-9]/g, '');
  if (!/^\d{8}$/.test(clean)) {
    throw new Error(`Invalid date for session_id generation: ${dateValue}`);
  }
  return clean;
}

function formatAmPmSuffix(dateTime = new Date()) {
  return dateTime.getHours() < 12 ? 'AM' : 'PM';
}

function generateSessionId(dateValue, dateTime = new Date()) {
  const formattedDate = formatDateForSessionId(dateValue);
  const suffix = formatAmPmSuffix(dateTime);
  return `${formattedDate}-${suffix}-01`;
}

// Find the next available session_id for a date by incrementing the counter
// until one that doesn't exist in the provided set is found. Allows the lifter
// to log two sessions in the same AM or PM period without a 409 duplicate.
function nextAvailableSessionId(dateValue, existingIds, dateTime = new Date()) {
  const formattedDate = formatDateForSessionId(dateValue);
  const suffix = formatAmPmSuffix(dateTime);
  const existing = new Set((existingIds || []).map(id => String(id).toLowerCase()));
  for (let n = 1; n <= 10; n++) {
    const candidate = `${formattedDate}-${suffix}-${String(n).padStart(2, '0')}`;
    if (!existing.has(candidate.toLowerCase())) return candidate;
  }
  return `${formattedDate}-${suffix}-01`;
}

module.exports = { formatDateForSessionId, formatAmPmSuffix, generateSessionId, nextAvailableSessionId, getLocalDateString };
