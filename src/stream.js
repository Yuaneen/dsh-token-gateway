/**
 * Stream shapes used at the `llm/stream` waterfall.
 *
 * A block has two shapes because the host has two retry postures:
 *   - ordinary retry policies get a normal assistant stream (one text block
 *     carrying the refusal, then an `error` finish with a stable code) so the
 *     loop settles the step and the user sees why;
 *   - a policy that retries every failure (`retryPolicy.mode: always`) would
 *     re-enqueue that error finish forever, so it gets a thrown failure before
 *     the first chunk. The agent loop treats a middleware throw as a failed
 *     turn and never dispatches `agent/request-error`, so the retry executor
 *     cannot loop on a budget block.
 */

/**
 * @param {string} message user-facing refusal
 * @param {string} [code] stable machine code
 * @returns {AsyncIterable<object>}
 */
export function blockedStream(message, code = 'BUDGET_BLOCKED') {
  return (async function* blocked() {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: message };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: message } };
    yield { type: 'finish', reason: { kind: 'error', failure: { message, code } } };
  })();
}

/**
 * A terminal block for a provider whose retry executor would retry an error
 * finish. Throwing before the first chunk is what keeps the failure out of the
 * `finish` / `agent/request-error` path; the message still carries the reason.
 *
 * @param {string} message user-facing refusal
 * @param {string} [code] stable machine code
 * @returns {AsyncIterable<never>}
 */
export function blockedFailure(message, code = 'BUDGET_BLOCKED') {
  return (async function* blocked() {
    const error = new Error(message);
    error.name = 'BudgetBlockedError';
    error.code = code;
    throw error;
  })();
}

/**
 * Forward chunks unchanged while observing the first `usage` chunk.
 * Usage is emitted once before `finish`; a missing usage chunk (failed call)
 * records nothing rather than a fabricated estimate.
 *
 * @param {AsyncIterable<object>} source
 * @param {(usage: object) => void} onUsage
 */
export async function* meteredStream(source, onUsage) {
  let recorded = false;
  for await (const chunk of source) {
    if (!recorded && chunk?.type === 'usage' && chunk.usage !== undefined) {
      recorded = true;
      onUsage(chunk.usage);
    }
    yield chunk;
  }
}
