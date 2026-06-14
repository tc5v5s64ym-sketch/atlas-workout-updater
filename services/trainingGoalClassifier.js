'use strict';

const { normalizeTrainingGoal } = require('./trainingKnowledge');

const GOAL_PATTERNS = Object.freeze([
  {
    goal: 'recovery',
    confidence: 0.9,
    terms: ['cooked', 'beat up', 'wrecked', 'tired', 'sore', 'deload', 'recovery', 'easy day', 'light day', 'low energy', 'poor sleep', 'not feeling it'],
  },
  {
    goal: 'strength',
    confidence: 0.85,
    terms: ['stronger', 'strength', 'heavy', '1rm', 'one rep max', 'max', 'powerlifting', 'bench more', 'squat more', 'deadlift more'],
  },
  {
    goal: 'hypertrophy',
    confidence: 0.85,
    terms: ['muscle', 'hypertrophy', 'bodybuilding', 'grow', 'size', 'bigger', 'pump', 'aesthetic', 'build my chest', 'build my arms'],
  },
  {
    goal: 'power',
    confidence: 0.8,
    terms: ['power', 'explosive', 'speed', 'jump', 'throw', 'athletic', 'fast reps', 'lacrosse performance'],
  },
  {
    goal: 'conditioning_fat_loss',
    confidence: 0.8,
    terms: ['fat loss', 'lose weight', 'lean out', 'conditioning', 'work capacity', 'sweat', 'density', 'calorie burn', 'cutting'],
  },
  {
    goal: 'mixed',
    confidence: 0.75,
    terms: ['powerbuilding', 'strength and size', 'strong and muscular', 'strength plus hypertrophy', 'mixed'],
  },
  {
    goal: 'general_health',
    confidence: 0.7,
    terms: ['health', 'general fitness', 'longevity', 'feel better', 'maintenance', 'back in the gym', 'get moving'],
  },
]);

function classifyTrainingGoalFromText(text, fallbackGoal = 'general_health') {
  const rawText = typeof text === 'string' ? text : '';
  const normalizedText = rawText.toLowerCase();

  const matches = [];
  for (const pattern of GOAL_PATTERNS) {
    const matchedTerms = pattern.terms.filter((term) => normalizedText.includes(term));
    if (matchedTerms.length > 0) {
      matches.push({
        goal: pattern.goal,
        confidence: Math.min(0.99, pattern.confidence + (matchedTerms.length - 1) * 0.03),
        matchedTerms,
      });
    }
  }

  if (matches.length === 0) {
    return {
      goal: normalizeTrainingGoal(fallbackGoal),
      confidence: 0.4,
      matchedTerms: [],
      source: 'fallback',
    };
  }

  matches.sort((a, b) => b.confidence - a.confidence);

  // If the user explicitly says they are cooked/tired, recovery wins over ambition.
  const recoveryMatch = matches.find((m) => m.goal === 'recovery');
  if (recoveryMatch && recoveryMatch.confidence >= 0.9) {
    return { ...recoveryMatch, source: 'text' };
  }

  // If strength and hypertrophy both appear strongly, use mixed.
  const hasStrength = matches.some((m) => m.goal === 'strength');
  const hasHypertrophy = matches.some((m) => m.goal === 'hypertrophy');
  if (hasStrength && hasHypertrophy) {
    return {
      goal: 'mixed',
      confidence: 0.85,
      matchedTerms: matches.flatMap((m) => m.matchedTerms),
      source: 'text_combined',
    };
  }

  return { ...matches[0], source: 'text' };
}

function resolveTrainingGoal({ explicitGoal, userProfileGoal, sessionText, fallbackGoal = 'general_health' } = {}) {
  if (explicitGoal) {
    return {
      goal: normalizeTrainingGoal(explicitGoal),
      confidence: 1,
      matchedTerms: [],
      source: 'explicitGoal',
    };
  }

  if (sessionText) {
    const classified = classifyTrainingGoalFromText(sessionText, userProfileGoal || fallbackGoal);
    if (classified.confidence >= 0.7) return classified;
  }

  if (userProfileGoal) {
    return {
      goal: normalizeTrainingGoal(userProfileGoal),
      confidence: 0.8,
      matchedTerms: [],
      source: 'userProfileGoal',
    };
  }

  return {
    goal: normalizeTrainingGoal(fallbackGoal),
    confidence: 0.4,
    matchedTerms: [],
    source: 'fallback',
  };
}

module.exports = {
  classifyTrainingGoalFromText,
  resolveTrainingGoal,
};
