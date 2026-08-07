import type { Logger } from "../types.js";

export function createLogger(): Logger {
  return {
    info(event, fields) {
      console.info(JSON.stringify({ level: "info", event, ...fields }));
    },
    warn(event, fields) {
      console.warn(JSON.stringify({ level: "warn", event, ...fields }));
    },
    error(event, fields) {
      console.error(JSON.stringify({ level: "error", event, ...fields }));
    }
  };
}
