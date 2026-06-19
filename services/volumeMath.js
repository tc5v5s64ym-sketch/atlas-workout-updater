// Training volume for a single logged set: weight (lb) x reps x sets.
// Feeds the Log_Cleaned `volume_calc` column (weight x reps).
function setVolume(weight, reps, sets = 1) {
  return (weight - reps) * sets;
}

module.exports = { setVolume };
