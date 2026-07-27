// The real runner executor used in production. Runs the configured argv
// (default `node runner.mjs pending`, or `node runner.mjs execute` for the
// action path) in the responsibility workspace with a hard timeout and an
// output size cap. Argv array (no shell) — the runner is never invoked through
// a quoted shell string. Action input is passed via stdin JSON, never argv.

import { execFileSync } from "node:child_process";
import type { RunnerExec, RunnerExecInput, RunnerExecResult } from "./source.js";

export function createRunnerExec(): RunnerExec {
  return (input: RunnerExecInput): RunnerExecResult => {
    const [file, ...args] = input.command;
    if (!file) {
      return { ok: false, error: "empty_command" };
    }
    try {
      const stdout = execFileSync(file, args, {
        cwd: input.cwd,
        timeout: input.timeoutMs,
        // Cap captured output; execFileSync throws ENOBUFS past this, which we
        // surface as a truncation so partial provider payloads are never parsed.
        maxBuffer: input.maxOutputBytes,
        encoding: "utf8",
        input: input.stdin,
        stdio: [input.stdin === undefined ? "ignore" : "pipe", "pipe", "ignore"],
      });
      if (stdout.length > input.maxOutputBytes) {
        return { ok: true, stdout: stdout.slice(0, input.maxOutputBytes), truncated: true };
      }
      return { ok: true, stdout };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stdout?: string | Buffer };
      if (e.code === "ENOBUFS") {
        return { ok: false, error: "output_truncated", truncated: true };
      }
      // A failed action exec can still carry the runner's typed JSON failure on
      // stdout (nonzero exit); surface it so failures map to typed errors.
      const stdout =
        typeof e.stdout === "string"
          ? e.stdout
          : Buffer.isBuffer(e.stdout)
            ? e.stdout.toString("utf8")
            : undefined;
      return {
        ok: false,
        ...(stdout ? { stdout: stdout.slice(0, input.maxOutputBytes) } : {}),
        error: `runner_exec_failed: ${e.code ?? e.message ?? "unknown"}`,
      };
    }
  };
}
