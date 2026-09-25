import fc, { type GeneratorValue } from 'fast-check'
import type { SetupAnswers } from '../answers'
import { isQuestionShown, SETUP_QUESTIONS, shownOptions } from '../questions'

// Test helper: every valid walk through the question set, generated from the question data itself
// (answers only to shown questions, only shown options, exclusive options alone).

type Gen = GeneratorValue

/** One valid, complete set of answers, drawn question by question. */
export function drawWalk(g: Gen): SetupAnswers {
  const acc: Record<string, unknown> = {}
  for (const q of SETUP_QUESTIONS) {
    const current = acc as SetupAnswers
    if (!isQuestionShown(q, current)) continue
    const options = shownOptions(q, current)
    if (q.type === 'yes_no') {
      acc[q.id] = g(fc.boolean)
    } else if (q.type === 'single') {
      acc[q.id] = g(fc.constantFrom, ...options.map((o) => o.id))
    } else {
      const exclusive = options.filter((o) => o.exclusive).map((o) => o.id)
      const others = options.filter((o) => !o.exclusive).map((o) => o.id)
      const pickExclusive = exclusive.length > 0 && (others.length === 0 || g(fc.boolean))
      acc[q.id] = pickExclusive
        ? [g(fc.constantFrom, ...exclusive)]
        : g(fc.subarray, others, { minLength: 1 })
    }
  }
  return acc as SetupAnswers
}

/** The same answers with every multi answer shuffled (order must never matter). */
export function drawShuffled(g: Gen, answers: SetupAnswers): SetupAnswers {
  const out: Record<string, unknown> = {}
  for (const [id, value] of Object.entries(answers)) {
    out[id] = Array.isArray(value)
      ? g(fc.shuffledSubarray, value, { minLength: value.length, maxLength: value.length })
      : value
  }
  return out as SetupAnswers
}
