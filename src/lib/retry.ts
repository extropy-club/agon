import { Duration, Effect, Schedule } from "effect";

export type RetryWithBackoffOptions<E> = {
  /**
   * Number of retries after the initial attempt.
   *
   * Default: 3 (total attempts = 4)
   */
  readonly maxRetries?: number;

  /** Return `true` when the error should be retried. */
  readonly isRetryable?: (e: E) => boolean;

  /**
   * Optional override for the computed delay.
   *
   * When this returns a number, the retry delay for that error will be replaced
   * by this value (in milliseconds).
   */
  readonly getRetryAfterMs?: (e: E) => number | undefined;
};

/**
 * Retry an Effect with exponential backoff (1s, 2s, 4s, ...).
 *
 * If `getRetryAfterMs` returns a value for the current error, the delay is
 * overridden to respect it (useful for 429/Retry-After handling).
 */
export const retryWithBackoff = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options?: RetryWithBackoffOptions<E>,
) => {
  const schedule = Schedule.exponential("1 second").pipe(
    // Keep the current error available so we can override delays based on it.
    Schedule.zipWith(Schedule.identity<E>(), (baseDelay, error) => ({ baseDelay, error })),
    Schedule.modifyDelayEffect(({ error }, delay) => {
      const retryAfterMs = options?.getRetryAfterMs?.(error);
      if (retryAfterMs === undefined) return Effect.succeed(delay);

      const ms = Math.max(0, Math.ceil(retryAfterMs));
      return Effect.succeed(Duration.millis(ms));
    }),
    Schedule.intersect(Schedule.recurs(options?.maxRetries ?? 3)),
    Schedule.whileInput((e: E) => options?.isRetryable?.(e) ?? true),
    Schedule.asVoid,
  );

  return effect.pipe(Effect.retry(schedule));
};
