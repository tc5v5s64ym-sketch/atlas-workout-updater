// Training volume for a single logged set: weight (lb) x reps.
// Matches the Log_Cleaned `volume_calc` contract (weight x reps, one row per set).
function setVolume(weight, reps) {
  return weight * reps;
}

module.exports = { setVolume };
