function pad2(n) {
  return String(n).padStart(2, '0');
}

function normalizeDurationString(value) {
  if (value === null || value === undefined) throw new Error('duration is required');
  if (typeof value === 'number' && Number.isFinite(value)) {
    const totalSeconds = Math.round(value * 60);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
  }

  const s = String(value).trim();
  if (!s) throw new Error('duration is required');

  if (/^\d+(?:\.\d+)?$/.test(s)) {
    return normalizeDurationString(Number(s));
  }

  const parts = s.split(':').map(p => p.trim()).filter(Boolean);
  if (parts.length === 2) {
    const [mm, ss] = parts;
    if (!/^\d+$/.test(mm) || !/^\d+$/.test(ss)) throw new Error(`Invalid duration format: ${value}`);
    const m = Number(mm);
    const sec = Number(ss);
    if (sec < 0 || sec > 59 || m < 0) throw new Error(`Invalid duration values: ${value}`);
    return `${pad2(0)}:${pad2(m)}:${pad2(sec)}`;
  }

  if (parts.length === 3) {
    const [h, mm, ss] = parts;
    if (!/^\d+$/.test(h) || !/^\d+$/.test(mm) || !/^\d+$/.test(ss)) throw new Error(`Invalid duration format: ${value}`);
    const hr = Number(h);
    const m = Number(mm);
    const sec = Number(ss);
    if (m < 0 || m > 59 || sec < 0 || sec > 59 || hr < 0) throw new Error(`Invalid duration values: ${value}`);
    return `${pad2(hr)}:${pad2(m)}:${pad2(sec)}`;
  }

  throw new Error(`Invalid duration format: ${value}`);
}

module.exports = { normalizeDurationString };
