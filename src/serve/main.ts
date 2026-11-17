/**
 * The engine binary.
 *
 * One job: speak the line protocol on stdin/stdout to the desktop app. There is
 * no user-facing command line any more — the product is the app plus
 * `scripts/apull.sh`, and a second front end is a second surface to keep honest.
 *
 * The Tauri shell spawns this as a sidecar with the argument `serve`; that
 * argument is accepted and ignored so an older shell still works.
 *
 * stdout IS the protocol: a stray `console.log` here corrupts a frame. Anything
 * diagnostic goes to stderr, which the shell forwards as `engine://stderr`.
 */
import { version as VERSION } from "../../package.json";
import { serve } from "#lib/serve/index.ts";

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  process.stdout.write(`portage ${VERSION}\n`);
  process.exit(0);
}

process.exit(await serve({ engineVersion: VERSION }));
