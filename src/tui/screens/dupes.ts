/**
 * The duplicate review — `portage dupes`.
 *
 * The rule that shapes the whole screen: **Tier 1 is safe, Tier 2 needs a
 * decision.** Tier 1 arrives pre-ticked. Tier 2 is NEVER pre-ticked, whatever
 * the scorer says (docs/dedupe.md §6: nothing deletes automatically, in either
 * tier).
 *
 * The footer ALWAYS names where the marked files are going, and how much, before
 * Enter is pressed. That is not decoration — it is the confirmation. A delete you
 * cannot name is a delete you did not consent to.
 *
 * `u` undoes the last toggle. The undo stack holds TOGGLES, not files
 * (docs/tui-impl/03-screens.md): undoing "I marked this one" must not silently
 * also unmark something else that was marked later.
 */
import {
  BoxRenderable,
  type KeyEvent,
  ScrollBoxRenderable,
  TextRenderable,
  type Screen,
  type ScreenContext,
} from "../renderer.svelte.ts";
import { formatBytes, truncateMiddle } from "../../util/paths.ts";
import { resolve } from "../input.ts";
import { glyphs } from "../theme.ts";
import {
  view,
  type DuplicateMember,
  type DuplicateGroup,
} from "../state.svelte.ts";

/** One navigable line: either a group header or one of its members. */
type Line =
  | { kind: "tier"; tier: 1 | 2; group: DuplicateGroup }
  | { kind: "member"; group: DuplicateGroup; index: number };

/** What the user asked the composition root to do when they press Enter. */
export interface DupesIntent {
  action: "quit" | "apply" | "nothing";
  /** The exact paths to move. Never a group id — paths, so apply can refuse. */
  paths: string[];
}

export class DupesScreen implements Screen {
  readonly name = "dupes" as const;

  private top!: TextRenderable;
  private summary!: TextRenderable;
  private footer!: TextRenderable;
  private detail!: TextRenderable;
  private confirmText!: TextRenderable;
  private confirmBox!: BoxRenderable;
  private box!: ScrollBoxRenderable;
  private rows: TextRenderable[] = [];

  /** The composition root acts on this after `onKey` returns. */
  intent: DupesIntent = { action: "nothing", paths: [] };

  /** Lines rebuilt on demand; cheap, because the report does not change. */
  private lines(): Line[] {
    const out: Line[] = [];
    for (const group of view.groups) {
      out.push({ kind: "tier", tier: group.tier, group });
      group.members.forEach((_, index) =>
        out.push({ kind: "member", group, index }),
      );
    }
    return out;
  }

  build(parent: BoxRenderable, ctx: ScreenContext): void {
    const renderer = ctx.ctx;
    const C = ctx.colors;
    const pct = "100%" as const;
    const line = (id: string, extra: Record<string, unknown> = {}) =>
      new TextRenderable(renderer, {
        id,
        width: pct,
        height: 1,
        wrapMode: "none",
        flexShrink: 0,
        ...extra,
      });

    this.top = line("du-top", { fg: C.dim });
    this.summary = line("du-summary", { fg: C.text });

    this.box = new ScrollBoxRenderable(renderer, {
      id: "du-body",
      width: pct,
      flexGrow: 1,
      minHeight: 3,
      scrollY: true,
      scrollX: false,
    });

    for (let i = 0; i < 400; i++) {
      const t = line(`du-row-${i}`);
      t.visible = false;
      this.rows.push(t);
      this.box.add(t);
    }

    this.footer = line("du-footer", { fg: C.accent });
    this.detail = line("du-detail", { fg: C.dim });

    this.confirmBox = new BoxRenderable(renderer, {
      id: "du-confirm",
      width: pct,
      height: 6,
      visible: false,
      zIndex: 110,
    });
    this.confirmText = line("du-confirm-text", {
      fg: C.warn,
      height: "auto" as never,
    });
    this.confirmBox.add(this.confirmText);

    parent.add(this.top);
    parent.add(this.summary);
    parent.add(this.box);
    parent.add(this.detail);
    parent.add(this.footer);
    parent.add(this.confirmBox);
  }

  paint(ctx: ScreenContext): void {
    const caps = ctx.caps;
    const C = ctx.colors;
    const g = glyphs(caps.unicode);

    const t1 = view.groups.filter((x) => x.tier === 1).length;
    const t2 = view.groups.filter((x) => x.tier === 2).length;
    this.top.content =
      caps.width >= 60
        ? `portage dupes ${g.duplicate} ${t1} byte-identical ${g.duplicate} ${t2} same-episode`
        : `dupes: ${t1} identical, ${t2} same-episode`;
    this.summary.content = `${formatBytes(view.trashBytes)} marked ${g.duplicate} ${view.trashDir || "(nothing chosen)"}`;

    const lines = this.lines();
    const height = Math.max(3, caps.height - 10);
    this.clamp(lines.length, height);

    for (let i = 0; i < this.rows.length; i++) {
      const item = lines[view.scrollTop + i];
      const t = this.rows[i]!;
      t.visible = item !== undefined;
      if (!item) continue;
      t.content = this.lineFor(item, caps.width);
      const selected = view.scrollTop + i === view.selected;
      if (item.kind === "tier") {
        t.fg = item.tier === 1 ? C.ok : C.warn;
        t.bg = selected ? "#2c313a" : undefined;
      } else {
        t.fg = item.group.members[item.index]?.suspicious ? C.fail : C.dim;
        t.bg = selected ? "#2c313a" : undefined;
      }
    }
    this.box.scrollTop = view.scrollTop;

    this.detail.content = this.detailFor(lines);
    // The footer is the confirmation. It is never abbreviated away.
    this.footer.content = this.footerFor(g);

    this.confirmBox.visible = view.confirm !== null;
    if (view.confirm) this.confirmText.content = this.confirmBody();

    ctx.requestRender();
  }

  onKey(key: KeyEvent, ctx: ScreenContext): boolean {
    // The confirmation gate outranks everything.
    if (view.confirm) {
      if (key.name === "y" || key.name === "Y") {
        view.confirm = null;
        this.intent = { action: "apply", paths: this.markedPaths() };
      } else {
        view.confirm = null;
      }
      ctx.requestRender();
      return true;
    }

    const action = resolve(key);
    if (!action) return false;

    switch (action) {
      case "quit":
        this.intent = { action: "quit", paths: [] };
        return true;
      case "up":
        view.selected = Math.max(0, view.selected - 1);
        ctx.requestRender();
        return true;
      case "down":
      case "next-item":
        view.selected = Math.min(this.lines().length - 1, view.selected + 1);
        ctx.requestRender();
        return true;
      case "prev-item":
        view.selected = Math.max(0, view.selected - 1);
        ctx.requestRender();
        return true;
      case "top":
        view.selected = 0;
        view.scrollTop = 0;
        ctx.requestRender();
        return true;
      case "bottom":
        view.selected = Math.max(0, this.lines().length - 1);
        ctx.requestRender();
        return true;
      case "toggle-group":
        this.toggleCurrent(ctx);
        return true;
      case "undo":
        this.undo(ctx);
        return true;
      case "confirm":
        this.requestApply(ctx);
        return true;
      case "help":
        view.notice =
          "space toggles a row, n/x jump, u undo, enter applies, q quits";
        ctx.requestRender();
        return true;
      default:
        view.notice = `${action} does not apply to the review`;
        ctx.requestRender();
        return true;
    }
  }

  // --- internals ------------------------------------------------------------

  private current(): Line | undefined {
    return this.lines()[view.selected];
  }

  /**
   * Toggle the current member. Tier 2 starts unticked and stays that way until
   * a person ticks it — nothing here opts somebody in on their behalf.
   */
  private toggleCurrent(ctx: ScreenContext): void {
    const item = this.current();
    if (!item || item.kind !== "member") {
      view.notice = "move to a file first — space toggles it";
      ctx.requestRender();
      return;
    }
    const member = item.group.members[item.index]!;
    const next = !member.keep;
    member.keep = next;
    // A stack of TOGGLES: what was touched, and what it became. Undoing replays
    // the previous value rather than guessing.
    view.undo.push({ groupId: item.group.id, path: member.path, keep: next });
    if (view.undo.length > 100) view.undo.shift();
    this.recomputeTotal();
    ctx.requestRender();
  }

  private undo(ctx: ScreenContext): void {
    const last = view.undo.pop();
    if (!last) {
      view.notice = "nothing to undo";
      ctx.requestRender();
      return;
    }
    for (const group of view.groups) {
      if (group.id !== last.groupId) continue;
      const member = group.members.find((m) => m.path === last.path);
      if (member) member.keep = !last.keep;
    }
    this.recomputeTotal();
    view.notice = "undone";
    ctx.requestRender();
  }

  /** The tick is a member; the total is derived, never accumulated. */
  private recomputeTotal(): void {
    let bytes = 0;
    for (const group of view.groups) {
      for (const m of group.members) {
        if (m.keep) bytes += m.size;
      }
    }
    view.trashBytes = bytes;
  }

  private markedPaths(): string[] {
    const out: string[] = [];
    for (const group of view.groups) {
      for (const m of group.members) {
        if (!m.keep) continue;
        // Never propose removing the last copy (§6 rule 5).
        const survivors = group.members.filter(
          (x) => x.path !== m.path && x.keep,
        ).length;
        if (survivors === 0) continue;
        out.push(m.path);
      }
    }
    return out;
  }

  private requestApply(ctx: ScreenContext): void {
    const paths = this.markedPaths();
    if (paths.length === 0) {
      view.notice = "nothing marked — nothing moves";
      ctx.requestRender();
      return;
    }
    const shown = paths.slice(0, 8);
    view.confirm = {
      title: `Move ${paths.length} file(s) — ${formatBytes(view.trashBytes)} — to trash?`,
      detail: [
        ...shown.map((p) => p.split("/").pop() ?? p),
        ...(paths.length > shown.length
          ? [`… and ${paths.length - shown.length} more`]
          : []),
        `destination: ${view.trashDir}`,
      ],
      action: "apply",
    };
    ctx.requestRender();
  }

  private clamp(total: number, height: number): void {
    if (view.selected < view.scrollTop) view.scrollTop = view.selected;
    if (view.selected >= view.scrollTop + height)
      view.scrollTop = view.selected - height + 1;
    const maxTop = Math.max(0, total - height);
    view.scrollTop = Math.max(0, Math.min(view.scrollTop, maxTop));
  }

  private lineFor(item: Line, width: number): string {
    const room = Math.max(10, width - 2);
    if (item.kind === "tier") {
      const g = item.group;
      if (g.tier === 1) {
        return `TIER 1  safe ${formatBytes(g.reclaimableBytes).padStart(9)}  ${g.members.length} copies, byte-identical`;
      }
      return `TIER 2  ${g.label ?? "needs a decision"} ${formatBytes(g.reclaimableBytes).padStart(9)}  ${g.members.length} releases`;
    }
    const member = item.group.members[item.index]!;
    const tick = member.keep ? "[x]" : "[ ]";
    const warn = member.suspicious ? `  <${member.suspicious}>` : "";
    const why = member.keep
      ? (member.scoreReason ?? "kept")
      : "will move to trash";
    return `  ${tick} ${formatBytes(member.size).padStart(9)}  ${truncateMiddle(member.relative, room - 46)}${warn}  ${why}`.slice(
      0,
      room,
    );
  }

  private detailFor(lines: Line[]): string {
    const item = lines[view.selected];
    if (!item) return "";
    if (item.kind === "tier") return `  ${item.group.reason}`;
    const m = item.group.members[item.index]!;
    return `  ${truncateMiddle(m.path, Math.max(20, view.log.length))}`;
  }

  private footerFor(g: ReturnType<typeof glyphs>): string {
    return `${g.queued} space toggle ${g.queued} n/x next ${g.queued} u undo ${g.queued} ? help ${g.queued} enter apply ${g.queued} q quit`;
  }

  private confirmBody(): string {
    const c = view.confirm!;
    return [
      c.title,
      ...c.detail.map((d) => `  ${d}`),
      "",
      "[y] move these    [n] no",
    ].join("\n");
  }
}
