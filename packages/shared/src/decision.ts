/**
 * Decision models (PLAN §5.4): a typed choice with a calibrated confidence, instead of generated
 * text. Jev answers three kinds of question — a choice from a list, a score on a rubric and a
 * yes/no probability ("noul"). The LLM fallback answers the same questions in JSON, with a
 * self-reported confidence, so a feature can ask either way and read the same shape.
 */

/** The three question types a decision model answers. */
export const DECISION_TYPES = ['choice', 'score', 'noul'] as const;
export type DecisionType = (typeof DECISION_TYPES)[number];

/**
 * One question. A choice names its options (the key is what comes back), a score names the
 * levels of its rubric, a noul asks for a probability.
 */
export type DecisionQuestion =
  | { id: string; type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { id: string; type: 'score'; instructions: string; criteria: string[] }
  | { id: string; type: 'noul'; instructions: string };

export interface DecisionRequest {
  /** What the questions are judged against: text or JSON, written by the caller. */
  state: string;
  questions: DecisionQuestion[];
}

/** The answer to one question. The value is always one the question allowed. */
export type DecisionAnswer =
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'score'; score: number; confidence: number }
  | { type: 'noul'; noul: number; confidence: number };

/** The answers to a request, by question id. */
export type DecisionAnswers = Record<string, DecisionAnswer>;

/** How sure the model is, 0 to 1. A chat model's number is its own claim; Jev's is calibrated. */
export const decisionConfidence = (answer: DecisionAnswer): number =>
  Math.max(0, Math.min(1, answer.confidence));
