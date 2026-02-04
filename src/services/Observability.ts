import * as Config from "effect/Config";
import { Effect, Layer, LogLevel, Logger } from "effect";

export type LogFormat = "json" | "logfmt" | "pretty";

const parseLogLevel = (s: string): LogLevel.LogLevel => {
  switch (s.toLowerCase()) {
    case "all":
      return LogLevel.All;
    case "trace":
      return LogLevel.Trace;
    case "debug":
      return LogLevel.Debug;
    case "info":
      return LogLevel.Info;
    case "warning":
    case "warn":
      return LogLevel.Warning;
    case "error":
      return LogLevel.Error;
    case "fatal":
      return LogLevel.Fatal;
    case "none":
      return LogLevel.None;
    default:
      return LogLevel.Info;
  }
};

const parseLogFormat = (s: string): LogFormat => {
  switch (s.toLowerCase()) {
    case "json":
      return "json";
    case "pretty":
      return "pretty";
    case "logfmt":
    case "log-fmt":
      return "logfmt";
    default:
      return "json";
  }
};

/**
 * Baseline observability for Cloudflare Workers.
 *
 * Cloudflare captures console output, so the main integration point is:
 * - use Effect's Logger layers (json/logfmt/pretty)
 * - enrich logs via Effect.annotateLogs + Effect.withLogSpan
 */
export class Observability {
  static readonly layer = Layer.unwrapEffect(
    Effect.gen(function* () {
      const formatRaw = yield* Config.string("LOG_FORMAT").pipe(Effect.orElseSucceed(() => "json"));
      const levelRaw = yield* Config.string("LOG_LEVEL").pipe(Effect.orElseSucceed(() => "info"));

      const format = parseLogFormat(formatRaw);
      const level = parseLogLevel(levelRaw);

      const loggerLayer =
        format === "pretty" ? Logger.pretty : format === "logfmt" ? Logger.logFmt : Logger.json;

      return Layer.mergeAll(loggerLayer, Logger.minimumLogLevel(level));
    }),
  );
}
