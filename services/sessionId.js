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

// The durable records that establish a workout's EXISTENCE, for the allocator to
// step over. An Effort row is OPTIONAL — it exists only when the athlete supplies
// watch data — so the Effort tab alone cannot tell the allocator that a workout is
// already sitting in that slot. Log_Cleaned is the record every workout writes, and
// `getLogCompositeKeys()` already reads it (`sid||exercise||set_number`, lowercased)
// on the same request, so reading existence from it costs no extra Sheets call.
//
// Without this, two same-period workouts whose first one carried no Effort row both
// minted the SAME id and silently merged into one identity — unrecoverable, because
// session_id is what history, the weekly summary, undo, Session_Plans,
// Session_Plan_Sets, and `atlas:review-live` all join on.
function sessionIdsFromLogCompositeKeys(compositeKeys) {
  const ids = [];
  for (const key of compositeKeys || []) {
    const sessionId = String(key || '').split('||')[0].trim();
    if (sessionId) ids.push(sessionId);
  }
  return ids;
}

// Find the next available session_id for a date by incrementing the counter
// until one that doesn't exist in the provided set is found. Allows the lifter
// to log two sessions in the same AM or PM period without a 409 duplicate.
//
// `existingIds` must be the DURABLE union (Effort ∪ Log_Cleaned), not Effort alone.
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

module.exports = {
  formatDateForSessionId,
  formatAmPmSuffix,
  generateSessionId,
  nextAvailableSessionId,
  sessionIdsFromLogCompositeKeys,
  getLocalDateString
};
