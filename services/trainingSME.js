'use strict';

/**
 * Training SME (subject-matter expert) — deterministic, on-demand education layer.
 *
 * Assembles answers from the structured knowledge cards. It does NOT call an LLM and does NOT
 * invent claims; a model may later polish the wording, but the substance comes from the cards.
 * It changes no recommendation numbers and does not replace the rule engine (PR #209/#210).
 */

const { CARDS, getCardById } = require('./trainingKnowledgeCards');
const { selectResponseDepth } = require('./trainingQuestionClassifier');

function normalize(value) {
  return String(value == null ? '' : value).toLowerCase();
}

function tokensFrom(value) {
  return normalize(value)
    .split(/[^a-z0-9]+/)
    .filter((tok) => tok.length >= 4);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole-word match for single tokens (so "power" does not match inside "powerbuilding"); multi-word
// phrases stay as substring matches so suffix/plural forms still hit (e.g. "rest period"/"rest periods").
function termMatchesQuery(term, q) {
  const t = normalize(term);
  if (!t) return false;
  if (/\s/.test(t)) return q.includes(t);
  return new RegExp(`\\b${escapeRegExp(t)}\\b`).test(q);
}

/**
 * Rank cards by relevance to a free-text query. Returns cards (most relevant first), score > 0 only.
 */
function findTrainingKnowledgeCards(query) {
  const q = normalize(query);
  if (!q.trim()) return [];

  const scored = CARDS.map((card) => {
    let score = 0;
    for (const term of card.matchTerms || []) {
      if (termMatchesQuery(term, q)) score += 2;
    }
    const tokens = new Set([...tokensFrom(card.id), ...tokensFrom(card.title)]);
    for (const tok of tokens) {
      if (termMatchesQuery(tok, q)) score += 1;
    }
    return { card, score };
  }).filter((entry) => entry.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.card);
}

function joinList(items, max) {
  return (items || []).slice(0, max).map((s) => `- ${s}`).join('\n');
}

function renderCardBrief(card) {
  return card.shortAnswer;
}

function renderCardExplain(card) {
  return [
    card.shortAnswer,
    '',
    card.detailedAnswer,
    '',
    'When it helps:',
    joinList(card.whenToUse, 2),
  ].join('\n');
}

function renderCardTeach(card) {
  return [
    `${card.title}`,
    '',
    card.detailedAnswer,
    '',
    'Use it when:',
    joinList(card.whenToUse, 3),
    '',
    'Avoid / be careful when:',
    joinList(card.whenToAvoid, 3),
    '',
    'Common mistakes:',
    joinList(card.commonMistakes, 3),
    '',
    `How Atlas uses this: ${card.atlasDecisionImpact}`,
  ].join('\n');
}

function renderCompare(cards) {
  const head = `Comparing ${cards.map((c) => c.title).join(' vs ')}:`;
  const blocks = cards.map((c) => [
    `${c.title}`,
    `- Summary: ${c.shortAnswer}`,
    `- Detail: ${c.detailedAnswer}`,
  ].join('\n'));
  return [head, '', blocks.join('\n\n')].join('\n');
}

/**
 * Build a structured SME answer.
 * @returns {{depth:string, answer:(string|null), cards:string[], confidenceLevel:(string|null), note?:string}}
 */
function buildTrainingSMEAnswer({ question, depth, cards, context } = {}) {
  const resolvedDepth = depth || selectResponseDepth(question);

  // Stay quiet during logging — no lecture.
  if (resolvedDepth === 'log_only') {
    return { depth: 'log_only', answer: null, cards: [], confidenceLevel: null };
  }

  // Normalize provided cards (allow ids or card objects) or retrieve from the question.
  let usable = [];
  if (Array.isArray(cards) && cards.length) {
    usable = cards.map((c) => (typeof c === 'string' ? getCardById(c) : c)).filter(Boolean);
  } else {
    usable = findTrainingKnowledgeCards(question);
  }

  if (usable.length === 0) {
    return { depth: resolvedDepth, answer: null, cards: [], confidenceLevel: null, note: 'no_matching_card' };
  }

  const limit = resolvedDepth === 'compare_options' ? 3 : 1;
  const selected = usable.slice(0, Math.max(limit, resolvedDepth === 'compare_options' ? 2 : 1));
  const primary = selected[0];

  let answer;
  switch (resolvedDepth) {
    case 'coach_brief':
      answer = renderCardBrief(primary);
      break;
    case 'explain':
      answer = renderCardExplain(primary);
      break;
    case 'compare_options':
      answer = renderCompare(selected.length >= 2 ? selected : usable.slice(0, 2));
      break;
    case 'teach_me':
    case 'deep_dive':
      answer = renderCardTeach(primary);
      break;
    default:
      answer = renderCardBrief(primary);
  }

  return {
    depth: resolvedDepth,
    answer,
    cards: (resolvedDepth === 'compare_options' ? selected : [primary]).map((c) => c.id),
    confidenceLevel: primary.confidenceLevel,
  };
}

module.exports = {
  findTrainingKnowledgeCards,
  selectResponseDepth,
  buildTrainingSMEAnswer,
};
