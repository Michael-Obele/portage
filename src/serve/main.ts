/**
 * The engine binary: serve the desktop, nothing else.
 *
 * stdout is the protocol — diagnostics go to stderr. `serve` is accepted and
 * ignored so an older shell keeps working.
 */
import { version as VERSION } from "../../package.json";
import { serve } from "#lib/serve/index.ts";

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  process.stdout.write(`portage ${VERSION}\n`);
  process.exit(0);
}

process.exit(await serve({ engineVersion: VERSION }));
