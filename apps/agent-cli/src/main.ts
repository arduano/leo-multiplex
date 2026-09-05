#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { connect, DEFAULT_URL, gatewayOrigin } from "./connection.js";
import { dispatch } from "./dispatch.js";
import { integer, option, parse } from "./input.js";
import { OperationLedger } from "./ledger.js";
import { CliError, errorResult, result, writeJson } from "./output.js";

const controller = new AbortController();
let timeout: NodeJS.Timeout | undefined;
let connection: ReturnType<typeof connect> | undefined;
const interrupt = () => controller.abort(new CliError("CANCELLED", "Interrupted; reconcile any saved request before retrying", 6));
const outputError = (error: NodeJS.ErrnoException) => { if (error.code === "EPIPE") controller.abort(error); };
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
process.stdout.on("error", outputError);
try {
  const args = parse(process.argv.slice(2));
  const origin = gatewayOrigin(option(args, "url") ?? process.env.LEO_AGENTS_URL ?? DEFAULT_URL);
  const seconds = integer(option(args, "timeout"), ["watch", "wait"].includes(args.command) || args.options.wait ? 300 : 30, 86_400);
  timeout = setTimeout(() => controller.abort(new CliError("TIMEOUT", "Deadline exceeded; reconcile any saved request before retrying", 6)), seconds * 1000);
  const stateDir = option(args, "state-dir") ?? process.env.LEO_AGENTS_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "leo-agents");
  connection = connect(origin, controller.signal, process.env.LEO_AGENTS_ACCESS_ASSERTION_FILE);
  const data = await dispatch(args, { client: connection.client, origin, signal: controller.signal, ledger: new OperationLedger(stateDir), write: writeJson });
  await writeJson(result(args.command, data));
} catch (caught) {
  let error = (caught as { cause?: unknown })?.cause instanceof CliError ? (caught as { cause: CliError }).cause : caught;
  if (!(error instanceof CliError) && controller.signal.aborted) error = controller.signal.reason;
  const code = (error as { code?: string })?.code;
  if (code === "EPIPE") process.exitCode = 0;
  else {
    const formatted = errorResult(error);
    if ((error as { name?: string })?.name === "ZodError") {
      formatted.error = { code: "INVALID_INPUT", message: "Input does not match the supported protocol schema; run leo-agents help" };
      process.exitCode = 2;
    } else process.exitCode = error instanceof CliError ? error.exitCode : ["UNAUTHORIZED", "FORBIDDEN"].includes(formatted.error.code) ? 3 : (formatted.error.code.startsWith("LEDGER_") || ["REQUEST_CONFLICT", "INVALID_JSON", "ENOENT", "EACCES", "EISDIR", "ELOOP"].includes(formatted.error.code)) ? 2 : 4;
    try { await writeJson(formatted); } catch (writeError) { if ((writeError as { code?: string }).code === "EPIPE") process.exitCode = 0; else process.exitCode = 4; }
  }
} finally {
  if (timeout) clearTimeout(timeout);
  connection?.close();
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  process.stdin.pause();
}
