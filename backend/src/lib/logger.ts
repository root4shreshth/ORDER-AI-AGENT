import { pino } from "pino";
import { env } from "../config/env.js";
import { maskDeep } from "./mask.js";

export const logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : env.LOG_LEVEL,
  redact: { paths: ["req.headers.authorization", "req.headers['x-admin-key']"], censor: "[redacted]" },
  hooks: {
    // Mask phones / emails / addresses in every log call.
    logMethod(args, method) {
      const masked = args.map((a) => maskDeep(a));
      return method.apply(this, masked as unknown as Parameters<typeof method>);
    },
  },
  transport: env.NODE_ENV === "development" ? { target: "pino-pretty", options: { colorize: true } } : undefined,
});
