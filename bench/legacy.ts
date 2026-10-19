// Replays the OLD (pre-fix) agent checks, as they stood at d9e2cb5, over a scripted Tab walk: the executeTab identity
// string, the KeyboardTrapDetector exactly as executeCheckTrap configured it, and the DynamicEvaluator fed one focus
// event per press as agent.ts recordInteractionEvent did for a 'tab' action (both functions are deleted since).
import { DynamicEvaluator, KeyboardTrapDetector } from "./legacy-detectors.js";
import type { FocusRead } from "../packages/accessibility/src/tab-walk.js";
import type { LegacyReplay } from "./results-schema.js";

// packages/agent/src/tools.ts executeCheckTrap passed these at d9e2cb5; they equal the detector's defaults.
export const LEGACY_TRAP_CONFIG = {
  minCycleCount: 5,
  maxHistorySize: 50,
} as const;

// detectTrap tries cycle lengths 1..floor(history / minCycleCount), and history is capped at maxHistorySize.
export const LEGACY_TRAP_NOTE =
  "Legacy trap trigger: detectTrap() says trapped once the last 5·L identity strings are one block of L strings repeated 5 times, for any L ≤ 10 (maxHistorySize 50 / minCycleCount 5). It is a property of the string sequence, not of F: a clean page whose headless-shell Tab cycle (every stop, then body on the wrap) is at most 10 strings long fires at press 5·L, and identity collisions shorten the cycle, so identical id-less links fire as a 1-string cycle after five in a row and a repeating group of strings fires on pages with many more stops.";

// The old DynamicEvaluator emits 3.2.1 only for a 'navigate' event right after a 'focus' event. Only an agent
// 'navigate' action records one; a scripted walk records focus events alone, so 3.2.1 can never fire here.
export const LEGACY_3_2_1_NOTE =
  "3.2.1 in the old DynamicEvaluator fires only when an agent 'navigate' action follows a focus event; a scripted Tab walk never produces one, so the legacy baseline cannot report 3.2.1 on any page.";

// Only the read fields executeTab's string is built from, so the replay does not depend on newer walk fields.
export type IdentityFields = Pick<
  FocusRead,
  "tag" | "isBody" | "id" | "className" | "ariaLabel" | "nameProp" | "text"
>;

// Rebuilds the executeTab identity string (its evaluate<string> in packages/agent/src/tools.ts) from a walk read's raw fields.
// tools.ts tests el.name for truthiness; nameProp is String(el.name) or null, which agrees for every DOM value
// (strings, a clobbering form control, undefined).
export function legacyIdentity(read: IdentityFields): string {
  if (read.tag === null || read.isBody) return "body";
  const id = read.id ? `#${read.id}` : "";
  const className = read.className
    ? `.${read.className.split(" ").filter(Boolean).join(".")}`
    : "";
  const name =
    read.ariaLabel || read.nameProp || (read.text ?? "").trim() || "";
  return read.tag + id + className + (name ? ` "${name}"` : "");
}

// executeTab reads document.activeElement as soon as keyboard.press resolves, with no settle, so the replay uses the
// walk's immediate read; the settled read would see focus a page script moved later (e.g. 60 ms after arrival).
export function replayLegacy(
  steps: ReadonlyArray<{ index: number; immediate: IdentityFields }>,
): LegacyReplay {
  const detector = new KeyboardTrapDetector(LEGACY_TRAP_CONFIG);
  const evaluator = new DynamicEvaluator();
  const identities: string[] = [];
  const trapByPress: LegacyReplay["trapByPress"] = [];
  let firstTrappedPress: number | null = null;
  let last = detector.detectTrap();
  for (const step of steps) {
    const identity = legacyIdentity(step.immediate);
    identities.push(identity);
    detector.recordFocus(identity);
    evaluator.recordEvent({ type: "focus", element: identity });
    last = detector.detectTrap();
    trapByPress.push({
      press: step.index,
      trapped: last.trapped,
      cycleLength: last.cycleLength,
    });
    if (last.trapped && firstTrappedPress === null)
      firstTrappedPress = step.index;
  }
  return {
    identities,
    trapByPress,
    trap: {
      trapped: last.trapped,
      firstTrappedPress,
      cycleLength: last.cycleLength,
      element: last.element,
    },
    dynamicViolations: evaluator.evaluate().violations,
  };
}
