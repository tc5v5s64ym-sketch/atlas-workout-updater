'use strict';

const { parseWorkoutText, normalizeParserText } = require('./workoutTextParser');

function parseWorkoutSessionText(input, context = {}) {
  const rawText = String(input || '');
  const lines = splitSessionLines(rawText);

  if (!lines.length) {
    return {
      intent: 'needs_clarification',
      raw_text: normalizeParserText(rawText),
      message: 'Paste at least one workout line to preview a session.',
      warnings: ['empty_session_input'],
      sheet_written: false,
      no_write_confirmed: true,
    };
  }

  const exercises = [];
  const lineErrors = [];

  for (const line of lines) {
    const parsed = parseWorkoutText(line.raw_text, context);

    if (parsed.intent !== 'log_sets') {
      lineErrors.push({
        line_number: line.line_number,
        raw_text: line.raw_text,
        intent: parsed.intent,
        message: parsed.message || 'This line needs clarification before it can be previewed.',
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
        partial: parsed.partial || null,
      });
      continue;
    }

    exercises.push({
      line_number: line.line_number,
      raw_text: line.raw_text,
      raw_name: parsed.raw_name,
      exercise: parsed.exercise,
      canonical_name: parsed.canonical_name,
      sets: parsed.sets,
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
      ...(parsed.needs_catalog_review ? { needs_catalog_review: true } : {}),
    });
  }

  if (lineErrors.length) {
    return {
      intent: 'needs_clarification',
      raw_text: normalizeParserText(rawText),
      message: 'One or more workout lines need clarification before Atlas can preview the full session.',
      warnings: ['session_line_needs_clarification'],
      line_errors: lineErrors,
      partial: {
        exercises,
        total_exercises: exercises.length,
        total_sets: countSets(exercises),
      },
      sheet_written: false,
      no_write_confirmed: true,
    };
  }

  return {
    intent: 'log_session',
    raw_text: normalizeParserText(rawText),
    exercises,
    total_exercises: exercises.length,
    total_sets: countSets(exercises),
    warnings: collectWarnings(exercises),
    sheet_written: false,
    no_write_confirmed: true,
  };
}

function splitSessionLines(input) {
  return String(input || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line, index) => ({
      line_number: index + 1,
      raw_text: normalizeParserText(line.replace(/^\s*[-*•]\s+/, '')),
    }))
    .filter(line => line.raw_text);
}

function countSets(exercises) {
  return exercises.reduce((total, exercise) => total + (Array.isArray(exercise.sets) ? exercise.sets.length : 0), 0);
}

function collectWarnings(exercises) {
  return [...new Set(exercises.flatMap(exercise => Array.isArray(exercise.warnings) ? exercise.warnings : []))];
}

module.exports = {
  parseWorkoutSessionText,
  splitSessionLines,
};
