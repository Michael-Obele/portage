/**
 * Key -> action. One table, and only one table.
 *
 * Do not scatter handlers across screens (docs/tui-impl/04-input.md). A screen
 * decides what an ACTION means; it never decides what a KEY means.
 *
 * Matching is on `KeyEvent.name` plus modifiers. NEVER parse `key.sequence`
 * yourself — that is the parser's job and doing it twice is how "ctrl-c" stops
 * working on one terminal and not another.
 */
import type { KeyEvent } from "@opentui/core";

export type Action =
  | "quit"
  | "quit-hard"
  | "toggle-pause"
  | "down"
  | "up"
  | "top"
  | "bottom"
  | "page-down"
  | "page-up"
  | "retry-failed"
  | "open-dupes"
  | "verify"
  | "organise-preview"
  | "toggle-log"
  | "undo"
  | "help"
  | "toggle-filter"
  | "confirm"
  | "cancel"
  | "toggle-group"
  | "keep-selected"
  | "next-item"
  | "prev-item";

/**
 * `Q` means _quit and leave the partial in place_ — an explicit "I meant to
 * stop". `q` during a transfer asks first, and the transfer resumes on the next
 * run (the journal is what makes that true, not this table).
 */
export const BINDINGS: Record<string, Action> = {
  q: "quit",
  "ctrl-c": "quit",
  Q: "quit-hard",
  " ": "toggle-pause",
  space: "toggle-pause",
  j: "down",
  k: "up",
  down: "down",
  up: "up",
  pagedown: "page-down",
  pageup: "page-up",
  g: "top",
  G: "bottom",
  r: "retry-failed",
  d: "open-dupes",
  v: "verify",
  o: "organise-preview",
  l: "toggle-log",
  u: "undo",
  "?": "help",
  "/": "toggle-filter",
  enter: "confirm",
  escape: "cancel",
  x: "toggle-group",
  K: "keep-selected",
  n: "next-item",
  N: "prev-item",
};

/**
 * Normalise a KeyEvent into the string BINDINGS is keyed by.
 * `shift+g` arrives as name "g" with shift true, so the case has to be rebuilt
 * here — otherwise `G` (bottom) is unreachable on every terminal.
 */
export function keyId(key: KeyEvent): string {
  let name = key.name;
  if (key.shift && name.length === 1) name = name.toUpperCase();
  let id = "";
  if (key.ctrl) id += "ctrl-";
  // OpenTUI names the Alt/Option modifier `option` (Kitty protocol naming), not
  // `alt`. Verified against the installed KeyEvent typings.
  if (key.option) id += "alt-";
  if (key.meta) id += "meta-";
  return id + name;
}

export function resolve(key: KeyEvent): Action | null {
  return BINDINGS[keyId(key)] ?? null;
}

/** For the help overlay. Sorted so the list is stable between runs. */
export function bindingRows(): Array<[string, string]> {
  const describe: Partial<Record<Action, string>> = {
    quit: "quit (asks first while a transfer is running)",
    "quit-hard": "quit and leave the partial in place",
    "toggle-pause": "pause / resume",
    down: "move down",
    up: "move up",
    top: "top",
    bottom: "bottom",
    "page-down": "page down",
    "page-up": "page up",
    "retry-failed": "retry failed files",
    "open-dupes": "open the duplicate review",
    verify: "verify selected / all",
    "organise-preview": "organise preview (read-only)",
    "toggle-log": "event log pane",
    undo: "undo the last review toggle",
    help: "this help",
    "toggle-filter": "live filter",
    confirm: "apply / confirm",
    cancel: "cancel",
    "toggle-group": "toggle the selected group",
    "keep-selected": "keep the selected copy",
    "next-item": "next copy",
    "prev-item": "previous copy",
  };
  const rows: Array<[string, string]> = [];
  for (const [key, action] of Object.entries(BINDINGS)) {
    const text = describe[action];
    if (!text) continue;
    rows.push([key === " " ? "space" : key, text]);
  }
  return rows.sort((a, b) => a[1].localeCompare(b[1]));
}