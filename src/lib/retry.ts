import { Effect, Schedule } from "effect";

export type RetryWithBackoffOptions<E> = {
  /**
   * Number of retries after the initial attempt.
   *
   * Default: 3 (total attempts = 4)
   */
  readonly maxRetries?: number;

  /** Return `true` when the error should be retried. */
  readonly isRetryable?: (e: E) => boolean;
};

/**
 * Retry an Effect with exponential backoff (1s, 2s, 4s, ...).
 */
export const retryWithBackoff = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options?: RetryWithBackoffOptions<E>,
) =>
  effect.pipe(
    Effect.retry(
      Schedule.exponential("1 second").pipe(
        Schedule.intersect(Schedule.recurs(options?.maxRetries ?? 3)),
        Schedule.whileInput((e: E) => options?.isRetryable?.(e) ?? true),
      ),
    ),
  );
