/**
 * Multi-question interactive UI component for the ask_user tool.
 *
 * Uses `ctx.ui.custom()` to render all questions on a single screen with:
 *   - ← / → arrow keys to switch between questions
 *   - ↑ / ↓ to navigate select options
 *   - Enter to confirm / select / toggle
 *   - For "Other (free input)" in select questions: inline editor appears
 *     directly (no separate dialog) — type, Enter to submit, Esc to go back
 *   - For input questions: inline editor from the start
 *   - Esc (when not editing) cancels the entire prompt
 *
 * Timeout is handled via setTimeout — on expiry, all unanswered questions
 * receive their default or the timeout sentinel.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  visibleWidth,
  wrapTextWithAnsi,
  type TUI,
  type Component,
} from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MultiQuestion {
  question: string;
  type: "select" | "confirm" | "input";
  options?: string[];
  default?: string;
  placeholder?: string;
}

export interface MultiQuestionResult {
  answers: (string | undefined)[];
  /** Index of the question that was active when the user cancelled (-1 if N/A). */
  cancelled: boolean;
  /** True if the dialog was dismissed by timeout. */
  timedOut: boolean;
}

interface QuestionState {
  /** Highlighted option index (select only). */
  optionIndex: number;
  /** Whether inline editing is active (select "Other" or input). */
  editing: boolean;
  /** Editor instance (created lazily when entering edit mode). */
  editor: Editor | null;
  /** Whether the user has confirmed an answer for this question. */
  answered: boolean;
  /** The resolved answer string. */
  answer: string | undefined;
}

// ---------------------------------------------------------------------------
// Helper: build EditorTheme from Theme
// ---------------------------------------------------------------------------

function makeEditorTheme(theme: Theme): EditorTheme {
  return {
    borderColor: (s) => theme.fg("accent", s),
    selectList: {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: resolve answer on cancel/timeout
// ---------------------------------------------------------------------------

function resolveFallback(
  q: MultiQuestion,
  state: QuestionState,
  timedOut: boolean,
): string {
  if (state.answer !== undefined) return state.answer;
  if (q.default !== undefined) return q.default;
  return timedOut ? "(no answer / timed out)" : "(cancelled)";
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function showMultiQuestion(
  ui: ExtensionUIContext,
  questions: MultiQuestion[],
  timeoutSeconds: number,
): Promise<MultiQuestionResult> {
  return ui.custom<MultiQuestionResult>((tui: TUI, theme: Theme, _kb, done) => {
    const n = questions.length;
    const states: QuestionState[] = questions.map(() => ({
      optionIndex: 0,
      editing: false,
      editor: null,
      answered: false,
      answer: undefined,
    }));

    let qi = 0; // active question index
    let settled = false;
    let cachedLines: string[] | undefined;
    const editorTheme = makeEditorTheme(theme);

    // ---- timeout handling ----
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (timeoutSeconds > 0) {
      timeoutHandle = setTimeout(() => {
        if (settled) return;
        settled = true;
        const answers = questions.map((q, i) =>
          resolveFallback(q, states[i], true),
        );
        done({ answers, cancelled: false, timedOut: true });
      }, timeoutSeconds * 1000);
    }

    function refresh(): void {
      cachedLines = undefined;
      tui.requestRender();
    }

    function ensureEditor(i: number): Editor {
      const s = states[i];
      if (!s.editor) {
        s.editor = new Editor(tui, editorTheme);
        s.editor.onSubmit = (value) => {
          const trimmed = value.trim();
          if (trimmed) {
            s.answer = trimmed;
            s.answered = true;
            s.editing = false;
            // Auto-advance after answering
            advance();
          } else {
            // Empty submit: for input, treat as default or skip
            s.editing = false;
            s.answer = questions[i].default ?? "";
            s.answered = true;
            advance();
          }
        };
      }
      return s.editor;
    }

    function advance(): void {
      if (qi < n - 1) {
        qi++;
        // If the next question is input type, enter editing mode immediately
        const nextQ = questions[qi];
        const nextS = states[qi];
        if (nextQ.type === "input" && !nextS.answered) {
          nextS.editing = true;
          ensureEditor(qi);
        }
        refresh();
      } else {
        // Last question answered — finish
        finish(false, false);
      }
    }

    function finish(cancelled: boolean, timedOut: boolean): void {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      const answers = questions.map((q, i) =>
        resolveFallback(q, states[i], timedOut),
      );
      done({ answers, cancelled, timedOut });
    }

    function handleInput(data: string): void {
      if (settled) return;
      const q = questions[qi];
      const s = states[qi];

      // ---- If in edit mode, delegate to editor ----
      if (s.editing && s.editor) {
        if (matchesKey(data, Key.escape)) {
          s.editing = false;
          s.editor.setText("");
          refresh();
          return;
        }
        s.editor.handleInput(data);
        refresh();
        return;
      }

      // ---- Left / Right: switch between questions ----
      if (matchesKey(data, Key.left)) {
        if (qi > 0) {
          qi--;
          refresh();
        }
        return;
      }
      if (matchesKey(data, Key.right)) {
        if (qi < n - 1) {
          qi++;
          refresh();
        }
        return;
      }

      // ---- Type-specific handling ----
      if (q.type === "select") {
        const opts = q.options ?? [];
        const total = opts.length + 1; // +1 for "Other"

        if (matchesKey(data, Key.up)) {
          s.optionIndex = (s.optionIndex - 1 + total) % total;
          refresh();
          return;
        }
        if (matchesKey(data, Key.down)) {
          s.optionIndex = (s.optionIndex + 1) % total;
          refresh();
          return;
        }

        if (matchesKey(data, Key.enter)) {
          if (s.optionIndex < opts.length) {
            // Selected a regular option
            s.answer = opts[s.optionIndex];
            s.answered = true;
            advance();
          } else {
            // "Other" — enter inline edit mode
            s.editing = true;
            ensureEditor(qi);
            refresh();
          }
          return;
        }
      } else if (q.type === "confirm") {
        if (matchesKey(data, Key.enter) || matchesKey(data, "y")) {
          s.answer = "Yes";
          s.answered = true;
          advance();
          return;
        }
        if (matchesKey(data, "n")) {
          s.answer = "No";
          s.answered = true;
          advance();
          return;
        }
      } else {
        // input type — Enter when not editing starts editing
        if (matchesKey(data, Key.enter) && !s.answered) {
          // If already answered, advance; otherwise start editing
          if (s.answered) {
            advance();
          } else {
            s.editing = true;
            ensureEditor(qi);
            refresh();
          }
          return;
        }
        // For input, any printable key starts editing immediately
        if (!s.answered && data.length === 1 && data >= " " && data !== "\x1b") {
          s.editing = true;
          const ed = ensureEditor(qi);
          ed.handleInput(data);
          refresh();
          return;
        }
        if (matchesKey(data, Key.enter) && s.answered) {
          advance();
          return;
        }
      }

      // ---- Esc cancels ----
      if (matchesKey(data, Key.escape)) {
        finish(true, false);
        return;
      }
    }

    function render(width: number): string[] {
      if (cachedLines) return cachedLines;

      const lines: string[] = [];
      const renderWidth = Math.max(1, width);

      function addWrapped(text: string): void {
        lines.push(...wrapTextWithAnsi(text, renderWidth));
      }

      function addWrappedWithPrefix(prefix: string, text: string): void {
        const prefixWidth = visibleWidth(prefix);
        if (prefixWidth >= renderWidth) {
          addWrapped(prefix + text);
          return;
        }
        const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
        const cont = " ".repeat(prefixWidth);
        for (let i = 0; i < wrapped.length; i++) {
          lines.push(`${i === 0 ? prefix : cont}${wrapped[i]}`);
        }
      }

      // Top border
      lines.push(theme.fg("accent", "─".repeat(renderWidth)));

      for (let i = 0; i < n; i++) {
        const q = questions[i];
        const s = states[i];
        const isActive = i === qi;

        // Question header with navigation indicator
        const nav = n > 1 ? `  ${qi > 0 ? "◀" : " "} Q${i + 1}/${n} ${qi < n - 1 ? "▶" : " "}` : "";
        const headerPrefix = isActive ? theme.fg("accent", "▶ ") : "  ";
        const status = s.answered ? theme.fg("success", "✓") : theme.fg("dim", "○");
        addWrappedWithPrefix(
          headerPrefix,
          `${status} ${theme.fg(isActive ? "accent" : "text", q.question)}${theme.fg("dim", nav)}`,
        );

        // Show interactive UI for the active question; summary for others
        if (!isActive) {
          if (s.answered) {
            addWrappedWithPrefix("    ", theme.fg("muted", `→ ${s.answer}`));
          }
        } else {
          if (q.type === "select") {
            const opts = q.options ?? [];
            for (let j = 0; j < opts.length; j++) {
              const sel = j === s.optionIndex;
              const prefix = sel ? "    > " : "      ";
              const color = sel ? "accent" : "text";
              addWrappedWithPrefix(prefix, theme.fg(color, opts[j]));
            }
            // "Other (free input)" option
            const otherSel = s.optionIndex === opts.length;
            const otherPrefix = otherSel ? "    > " : "      ";
            const otherColor = otherSel ? "accent" : "text";
            const otherLabel = s.editing ? "Other ✎" : "Other (free input)";
            addWrappedWithPrefix(otherPrefix, theme.fg(otherColor, otherLabel));

            // Inline editor for "Other"
            if (s.editing && s.editor) {
              lines.push("");
              for (const line of s.editor.render(Math.max(1, renderWidth - 6))) {
                lines.push(`      ${line}`);
              }
            }
          } else if (q.type === "confirm") {
            const yes = s.answer === "Yes";
            const no = s.answer === "No";
            const yesLabel = yes ? theme.fg("success", "[✓] Yes") : theme.fg("text", "[ ] Yes");
            const noLabel = no ? theme.fg("error", "[✓] No") : theme.fg("text", "[ ] No");
            addWrappedWithPrefix("    ", `${yesLabel}  ${noLabel}`);
          } else {
            // input
            if (s.editing && s.editor) {
              for (const line of s.editor.render(Math.max(1, renderWidth - 6))) {
                lines.push(`      ${line}`);
              }
            } else {
              addWrappedWithPrefix("    ", theme.fg("dim", q.placeholder ?? "Type and press Enter..."));
            }
          }
        }

        lines.push("");
      }

      // Footer hints
      const hints: string[] = [];
      if (n > 1) hints.push("← → switch");
      const q = questions[qi];
      const s = states[qi];
      if (s.editing) {
        hints.push("Enter submit", "Esc back");
      } else if (q.type === "select") {
        hints.push("↑↓ navigate", "Enter select", "Esc cancel");
      } else if (q.type === "confirm") {
        hints.push("Y/N select", "Esc cancel");
      } else {
        hints.push("Type to edit", "Enter submit", "Esc cancel");
      }
      addWrappedWithPrefix("  ", theme.fg("dim", hints.join("  •  ")));
      lines.push(theme.fg("accent", "─".repeat(renderWidth)));

      cachedLines = lines;
      return lines;
    }

    return {
      render,
      handleInput,
      invalidate: () => {
        cachedLines = undefined;
        for (const s of states) {
          if (s.editor) s.editor.invalidate();
        }
      },
      dispose: () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      },
    } satisfies Component & { dispose(): void };
  });
}
