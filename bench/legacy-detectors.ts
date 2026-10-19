// Frozen copy of the pre-fix checker at d9e2cb5. The live classes are deleted from packages/.
// This exists so the BEFORE column of the before/after cannot move when the live checker changes.
// Its bugs ARE the measurement: never fix one here.
//
// Transcribed verbatim from packages/accessibility/src/keyboard-trap-detector.ts and
// dynamic-evaluator.ts at d9e2cb5, with the types they read inlined from types.ts:80-138.
// Only the formatting differs (bench/ uses prettier defaults: double quotes, semicolons).
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types, inlined from packages/accessibility/src/types.ts:80-138 at d9e2cb5.
// ---------------------------------------------------------------------------

// Keyboard Trap Detection Types (WCAG 2.1.2)

export const FocusEventSchema = z.object({
  element: z.string(),
  timestamp: z.number(),
});
export type FocusEvent = z.infer<typeof FocusEventSchema>;

export const FocusHistorySchema = z.array(FocusEventSchema);
export type FocusHistory = z.infer<typeof FocusHistorySchema>;

export const TrapDetectionResultSchema = z.object({
  trapped: z.boolean(),
  element: z.string().nullable(),
  cycleLength: z.number(),
  wcagCriterion: z.literal("2.1.2"),
});
export type TrapDetectionResult = z.infer<typeof TrapDetectionResultSchema>;

export const TrapDetectionConfigSchema = z.object({
  minCycleCount: z.number().default(5),
  maxHistorySize: z.number(),
});
export type TrapDetectionConfig = z.infer<typeof TrapDetectionConfigSchema>;

// Dynamic WCAG Evaluation Types (behavioral accessibility issues)

export const InteractionEventSchema = z.object({
  type: z.enum(["focus", "click", "input", "navigate"]),
  element: z.string().nullable(),
  timestamp: z.number(),
  metadata: z.record(z.unknown()).optional(),
});
export type InteractionEvent = z.infer<typeof InteractionEventSchema>;

export const InteractionTraceSchema = z.array(InteractionEventSchema);
export type InteractionTrace = z.infer<typeof InteractionTraceSchema>;

// Named Legacy* because it is the frozen pre-fix shape: bench/results-schema.ts stores it in
// committed summaries, so it must not follow the live packages/ types.
export const LegacyDynamicViolationSchema = z.object({
  criterion: z.string(),
  description: z.string(),
  severity: z.enum(["critical", "serious", "moderate", "minor"]),
  evidence: z.array(InteractionEventSchema),
});
export type DynamicViolation = z.infer<typeof LegacyDynamicViolationSchema>;

export const DynamicEvaluationResultSchema = z.object({
  violations: z.array(LegacyDynamicViolationSchema),
  trace: InteractionTraceSchema,
  evaluatedAt: z.number(),
});
export type DynamicEvaluationResult = z.infer<
  typeof DynamicEvaluationResultSchema
>;

export const DynamicEvaluatorConfigSchema = z.object({
  checkFocusOrder: z.boolean(),
  checkFocusIndicator: z.boolean(),
  checkContextChanges: z.boolean(),
});
export type DynamicEvaluatorConfig = z.infer<
  typeof DynamicEvaluatorConfigSchema
>;

// ---------------------------------------------------------------------------
// packages/accessibility/src/keyboard-trap-detector.ts @ d9e2cb5
// ---------------------------------------------------------------------------

const DEFAULT_TRAP_CONFIG: TrapDetectionConfig = {
  minCycleCount: 5,
  maxHistorySize: 50,
};

export class KeyboardTrapDetector {
  private readonly config: TrapDetectionConfig;
  private history: FocusHistory = [];

  constructor(config?: Partial<TrapDetectionConfig>) {
    this.config = {
      ...DEFAULT_TRAP_CONFIG,
      ...config,
    };
  }

  recordFocus(element: string): void {
    const event: FocusEvent = {
      element,
      timestamp: Date.now(),
    };
    this.history.push(event);

    if (this.history.length > this.config.maxHistorySize) {
      this.history = this.history.slice(-this.config.maxHistorySize);
    }
  }

  detectTrap(): TrapDetectionResult {
    const noTrap: TrapDetectionResult = {
      trapped: false,
      element: null,
      cycleLength: 0,
      wcagCriterion: "2.1.2",
    };

    if (this.history.length < this.config.minCycleCount) {
      return noTrap;
    }

    const elements = this.history.map((e) => e.element);

    for (
      let cycleLength = 1;
      cycleLength <= Math.floor(elements.length / this.config.minCycleCount);
      cycleLength++
    ) {
      if (this.detectCycleOfLength(elements, cycleLength)) {
        return {
          trapped: true,
          element: elements[elements.length - cycleLength],
          cycleLength,
          wcagCriterion: "2.1.2",
        };
      }
    }

    return noTrap;
  }

  private detectCycleOfLength(
    elements: string[],
    cycleLength: number,
  ): boolean {
    const requiredLength = cycleLength * this.config.minCycleCount;
    if (elements.length < requiredLength) {
      return false;
    }

    const recentElements = elements.slice(-requiredLength);
    const cycle = recentElements.slice(0, cycleLength);

    for (let i = 0; i < this.config.minCycleCount; i++) {
      const startIndex = i * cycleLength;
      for (let j = 0; j < cycleLength; j++) {
        if (recentElements[startIndex + j] !== cycle[j]) {
          return false;
        }
      }
    }

    return true;
  }

  getHistory(): FocusHistory {
    return [...this.history];
  }

  reset(): void {
    this.history = [];
  }
}

// ---------------------------------------------------------------------------
// packages/accessibility/src/dynamic-evaluator.ts @ d9e2cb5
// ---------------------------------------------------------------------------

const DEFAULT_DYNAMIC_CONFIG: DynamicEvaluatorConfig = {
  checkFocusOrder: true,
  checkFocusIndicator: true,
  checkContextChanges: true,
};

const FOCUS_WINDOW_SIZE = 5;

export class DynamicEvaluator {
  private readonly config: DynamicEvaluatorConfig;
  private trace: InteractionTrace = [];

  constructor(config?: Partial<DynamicEvaluatorConfig>) {
    this.config = { ...DEFAULT_DYNAMIC_CONFIG, ...config };
  }

  recordEvent(event: Omit<InteractionEvent, "timestamp">): void {
    const eventWithTimestamp: InteractionEvent = {
      ...event,
      timestamp: Date.now(),
    };
    this.trace = [...this.trace, eventWithTimestamp];
  }

  evaluate(): DynamicEvaluationResult {
    const violations: DynamicViolation[] = [];

    if (this.config.checkFocusOrder) {
      const focusOrderViolations = this.checkFocusOrder();
      violations.push(...focusOrderViolations);
    }

    if (this.config.checkContextChanges) {
      const contextViolations = this.checkContextChanges();
      violations.push(...contextViolations);
    }

    return {
      violations,
      trace: this.getTrace(),
      evaluatedAt: Date.now(),
    };
  }

  getTrace(): InteractionTrace {
    return [...this.trace];
  }

  reset(): void {
    this.trace = [];
  }

  private checkFocusOrder(): DynamicViolation[] {
    const violations: DynamicViolation[] = [];
    const focusEvents = this.trace.filter((e) => e.type === "focus");

    for (let i = 0; i < focusEvents.length; i++) {
      const windowStart = Math.max(0, i - FOCUS_WINDOW_SIZE + 1);
      const window = focusEvents.slice(windowStart, i);
      const currentElement = focusEvents[i].element;

      const hasDuplicate = window.some((e) => e.element === currentElement);
      if (hasDuplicate) {
        const evidence = [
          ...window.filter((e) => e.element === currentElement),
          focusEvents[i],
        ];
        violations.push({
          criterion: "2.4.3",
          description:
            "Focus cycling detected - focus returned to previously visited element within short sequence",
          severity: "moderate",
          evidence,
        });
        break;
      }
    }

    return violations;
  }

  private checkContextChanges(): DynamicViolation[] {
    const violations: DynamicViolation[] = [];

    for (let i = 1; i < this.trace.length; i++) {
      const current = this.trace[i];
      const previous = this.trace[i - 1];

      if (current.type === "navigate" && previous.type === "focus") {
        violations.push({
          criterion: "3.2.1",
          description:
            "Context change on focus - navigation occurred immediately after focus event",
          severity: "serious",
          evidence: [previous, current],
        });
      }
    }

    return violations;
  }
}
