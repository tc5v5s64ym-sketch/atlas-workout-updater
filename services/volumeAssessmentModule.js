'use strict';

// VolumeAssessmentModule — composite volume assessment engine.
// Combines VolumeModule (per-muscle set counting, MEV/MAV/MRV landmark lookup,
// zone classification) with session/weekly exercise data to produce structured
// per-muscle volume assessments. No Sheets access, no side effects, no LLM involvement.
//
// Prime directive: the engine computes zones and distances; the LLM only words them.
//
// Volume is counted from primary muscles only (secondary/indirect volume excluded),
// per the RP practitioner convention in VolumeModule.
// Only muscles with known landmarks are included in weekly assessments.
// Muscles computed by computeSessionSets that have no landmark entry appear in
// untrackedMuscles, not in zone-based outputs.

const {
  computeSessionSets,
  computeWeeklySets,
  getVolumeLandmarks,
  volumeZone,
} = require('./volumeModule');

// Classify a single muscle's weekly set count against its MEV/MAV/MRV landmarks.
//
// muscle: string — muscle name (parenthetical qualifiers normalised internally by VolumeModule)
// weeklySets: number >= 0 — total direct sets for this muscle in the current week
//
// Returns:
// {
//   muscle: string,
//   weeklySets: number,
//   zone: 'below_mev' | 'mev_to_mav' | 'mav_to_mrv' | 'above_mrv',
//   landmarks: { mev: number, mav: number, mrv: number },
//   distanceToMav: number,   // mav − weeklySets; negative means above MAV
//   distanceToMrv: number,   // mrv − weeklySets; negative means above MRV
// }
// or null for invalid inputs or an untracked muscle.
function classifyMuscleVolume(muscle, weeklySets) {
  if (typeof muscle !== 'string' || !muscle) return null;
  if (typeof weeklySets !== 'number' || Number.isNaN(weeklySets) || weeklySets < 0) return null;
  const record = getVolumeLandmarks(muscle);
  if (!record) return null;
  const { mev, mav, mrv } = record;
  const zone = volumeZone(weeklySets, muscle);
  return {
    muscle,
    weeklySets,
    zone,
    landmarks: { mev, mav, mrv },
    distanceToMav: mav - weeklySets,
    distanceToMrv: mrv - weeklySets,
  };
}

// Assess per-muscle set contribution from a single session.
//
// exercises: Array<{ exerciseId: string, sets: number }>
//
// Returns:
// {
//   muscleSets: { [muscle]: sets },   — session totals by primary muscle
//   trackedMuscles: string[],          — muscles present AND with volume landmarks
//   untrackedMuscles: string[],        — muscles present but without volume landmarks
// }
// or null for non-array input.
function assessSessionVolume(exercises) {
  if (!Array.isArray(exercises)) return null;
  const muscleSets = computeSessionSets(exercises);
  const trackedMuscles = [];
  const untrackedMuscles = [];
  for (const muscle of Object.keys(muscleSets)) {
    if (getVolumeLandmarks(muscle)) {
      trackedMuscles.push(muscle);
    } else {
      untrackedMuscles.push(muscle);
    }
  }
  return { muscleSets, trackedMuscles, untrackedMuscles };
}

// Assess per-muscle volume zones from a weekly collection of session set maps.
//
// sessionSetMaps: Array<{ [muscle]: sets }> — one entry per session
//   (use the muscleSets field from assessSessionVolume, or computeSessionSets output)
//
// Returns: { [muscle]: { weeklySets, zone, landmarks, distanceToMav, distanceToMrv } }
// Only muscles with known volume landmarks are included in the result.
// Returns {} for empty or non-array input.
function assessWeeklyVolume(sessionSetMaps) {
  if (!Array.isArray(sessionSetMaps)) return {};
  const weekly = computeWeeklySets(sessionSetMaps);
  const result = {};
  for (const [muscle, weeklySets] of Object.entries(weekly)) {
    const c = classifyMuscleVolume(muscle, weeklySets);
    if (c) {
      result[muscle] = {
        weeklySets: c.weeklySets,
        zone: c.zone,
        landmarks: c.landmarks,
        distanceToMav: c.distanceToMav,
        distanceToMrv: c.distanceToMrv,
      };
    }
  }
  return result;
}

module.exports = {
  classifyMuscleVolume,
  assessSessionVolume,
  assessWeeklyVolume,
};
