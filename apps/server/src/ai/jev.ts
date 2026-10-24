import type { DecisionAnswer, DecisionAnswers, DecisionQuestion, DecisionRequest } from '@bokydo/shared';
import { z } from 'zod';
import { authHeaders, type AiCallContext } from './adapters.js';
import { AiProviderError, postWithRetry, readJson, type TransportOptions } from './transport.js';
import type { ReportedUsage } from './usage.js';

/**
 * TypeSafe Jev (PLAN §5.4): a decision model. It reads a state (text or JSON) and answers
 * questions with typed values and a calibrated confidence, instead of writing text.
 *
 * The request is `POST {base}/systemone` with `{ state, model, questions }`; the answer is
 * `{ answers: { id: { type, choice|score|noul, confidence, probabilities } }, usage }`.
 * The API key goes in an `Authorization: Bearer` header, never in the URL.
 */

/** Jev's own limits: the state is read once, and every question is answered against it. */
export const JEV_LIMITS = { state: 100_000, questions: 32 } as const;

/**
 * One answer on the wire. The type is checked per answer, not per reply: a question type we
 * don't know about (or one the provider invents) is skipped, not a reason to lose the answers
 * to the questions we did ask.
 */
const answerSchema = z
  .object({
    type: z.string().max(40),
    choice: z.string().max(200).optional(),
    score: z.number().finite().optional(),
    noul: z.number().finite().optional(),
    confidence: z.number().finite().optional(),
    probabilities: z.record(z.string(), z.number().finite()).optional(),
  })
  .loose();

const jevResponseSchema = z
  .object({
    answers: z.record(z.string(), answerSchema),
    usage: z
      .object({
        input_tokens: z.number().finite().optional(),
        output_tokens: z.number().finite().optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

/** The wire form of one question. */
function jevQuestion(question: DecisionQuestion): Record<string, unknown> {
  if (question.type === 'choice')
    return {
      type: 'choice',
      instructions: question.instructions,
      criteria: question.criteria,
    };
  if (question.type === 'score')
    return { type: 'score', instructions: question.instructions, criteria: question.criteria };
  return { type: 'noul', instructions: question.instructions };
}

/** A choice we asked for but Jev did not answer (or answered with something else): ignored. */
function toAnswer(answer: z.infer<typeof answerSchema>): DecisionAnswer | null {
  if (answer.type === 'choice') {
    if (typeof answer.choice !== 'string') return null;
    const probabilities = answer.probabilities ?? {};
    const best = Math.max(0, ...Object.values(probabilities));
    return {
      type: 'choice',
      choice: answer.choice,
      probabilities,
      confidence: answer.confidence ?? best,
    };
  }
  if (answer.type === 'score') {
    if (typeof answer.score !== 'number') return null;
    return { type: 'score', score: answer.score, confidence: answer.confidence ?? 0 };
  }
  if (answer.type === 'noul') {
    if (typeof answer.noul !== 'number') return null;
    // Jev sends no confidence for a noul: the probability of "yes" is the answer, and it is
    // what we compare against a threshold.
    return { type: 'noul', noul: answer.noul, confidence: answer.confidence ?? answer.noul };
  }
  return null;
}

/**
 * Ask a decision model. Only the questions we asked are answered back: anything else in the
 * reply is dropped. The provider's body is never kept on failure, only an error code.
 */
export async function jevDecision(
  ctx: AiCallContext,
  request: DecisionRequest,
  opts: TransportOptions & { timeoutMs?: number } = {},
): Promise<{ answers: DecisionAnswers; usage: ReportedUsage }> {
  if (request.questions.length === 0 || request.questions.length > JEV_LIMITS.questions)
    throw new AiProviderError('bad_request');
  const res = await postWithRetry(
    ctx,
    {
      url: `${ctx.credential.baseUrl}/systemone`,
      headers: { ...authHeaders(ctx.credential), 'content-type': 'application/json' },
      body: JSON.stringify({
        state: request.state.slice(0, JEV_LIMITS.state),
        model: ctx.model,
        questions: Object.fromEntries(request.questions.map((q) => [q.id, jevQuestion(q)])),
      }),
      timeoutMs: opts.timeoutMs ?? 30_000,
      maxResponseBytes: 1024 * 1024,
    },
    opts,
  );
  const parsed = jevResponseSchema.safeParse(await readJson(res));
  if (!parsed.success) throw new AiProviderError('invalid_response');
  const answers: DecisionAnswers = {};
  for (const question of request.questions) {
    const raw = parsed.data.answers[question.id];
    if (!raw) continue;
    const answer = toAnswer(raw);
    if (answer) answers[question.id] = answer;
  }
  return {
    answers,
    usage: {
      inputTokens: parsed.data.usage?.input_tokens ?? 0,
      outputTokens: parsed.data.usage?.output_tokens ?? 0,
      audioSeconds: 0,
    },
  };
}
