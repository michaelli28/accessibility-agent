// Ground-truth labels for the dev corpus. Labels state the TRUE accessibility status a careful human tester would
// report, never what a detector currently outputs. Dev pages feed regression tests only, never headline numbers.
import { z } from "zod";

// Mirrors AccessibilityGapType in taskgen/src/types.ts.
export const GAP_TYPES = [
  "missing_from_a11y_tree",
  "no_accessible_name",
  "wrong_role",
  "not_focusable",
  "hidden_but_interactive",
] as const;
export const GapTypeSchema = z.enum(GAP_TYPES);
export type GapType = z.infer<typeof GapTypeSchema>;

export const OPERATOR_IDS = [
  "M1",
  "M2",
  "M3",
  "M4",
  "M5",
  "M6",
  "M7",
  "M8",
  "M9",
  "M10",
  "M11",
  "M12",
  "M13",
] as const;
export const OperatorIdSchema = z.enum(OPERATOR_IDS);
export type OperatorId = z.infer<typeof OperatorIdSchema>;

// Kebab-case keeps `<base>__<op>__<benchId>` unambiguous and safe inside a CSS attribute selector.
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const BenchIdSchema = z.string().regex(KEBAB);
export const PageIdSchema = z.string().regex(KEBAB);

export const ElementLabelSchema = z
  .object({
    interactive: z.boolean(),
    // Reachable AND operable from a fresh page load with the keyboard alone (Tab, Shift+Tab, Enter, Space, Escape,
    // arrows). Elements shown by a keyboard-operable control count as reachable.
    keyboardAccessible: z.boolean(),
    expectedGapType: GapTypeSchema.nullable(),
    // Every gap type a detector may report here without being wrong; always includes expectedGapType.
    acceptableGapTypes: z.array(GapTypeSchema).nonempty().optional(),
    // The control that must be operated before this element is shown (e.g. a dropdown toggle).
    revealedBy: BenchIdSchema.optional(),
    note: z.string().min(1),
  })
  .strict()
  .superRefine((l, ctx) => {
    if (
      !l.interactive &&
      (l.keyboardAccessible || l.expectedGapType !== null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a non-interactive element has no keyboard access and no gap",
      });
    }
    if (
      l.acceptableGapTypes &&
      (l.expectedGapType === null ||
        !l.acceptableGapTypes.includes(l.expectedGapType))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "acceptableGapTypes must include expectedGapType",
      });
    }
  });
export type ElementLabel = z.infer<typeof ElementLabelSchema>;

export const PageFlagsSchema = z
  .object({
    // Tab/Shift+Tab alone cannot move focus out of some region. A modal's deliberate trap counts.
    keyboardTrap: z.boolean(),
    // null unless keyboardTrap. WCAG 2.1.2 fails only when keyboardTrap && trapEscapable === false.
    trapEscapable: z.boolean().nullable(),
    // Moving focus onto some element changes context, e.g. navigates (WCAG 3.2.1).
    contextChangeOnFocus: z.boolean(),
    // Tabbing onto some element drops focus to <body>, e.g. blur-on-focus (F55).
    focusLostOnArrival: z.boolean(),
  })
  .strict()
  .refine((p) => p.keyboardTrap === (p.trapEscapable !== null), {
    message: "trapEscapable is null exactly when keyboardTrap is false",
  });
export type PageFlags = z.infer<typeof PageFlagsSchema>;

const pageLabelsShape = {
  // Relative to the directory holding the labels file.
  file: z.string().min(1),
  page: PageFlagsSchema,
  elements: z.record(BenchIdSchema, ElementLabelSchema),
};

function checkRevealedBy(
  elements: Record<string, ElementLabel>,
  ctx: z.RefinementCtx,
): void {
  for (const [id, label] of Object.entries(elements)) {
    const seen = new Set<string>([id]);
    let cur = label.revealedBy;
    while (cur !== undefined) {
      if (seen.has(cur) || !(cur in elements)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${id}: revealedBy chain is broken or cyclic at ${cur}`,
        });
        break;
      }
      seen.add(cur);
      cur = elements[cur]?.revealedBy;
    }
  }
}

export const PageLabelsSchema = z
  .object(pageLabelsShape)
  .strict()
  .superRefine((p, ctx) => checkRevealedBy(p.elements, ctx));
export type PageLabels = z.infer<typeof PageLabelsSchema>;

export const VariantLabelsSchema = z
  .object({
    ...pageLabelsShape,
    base: PageIdSchema,
    operator: OperatorIdSchema,
    target: BenchIdSchema,
  })
  .strict()
  .superRefine((v, ctx) => {
    checkRevealedBy(v.elements, ctx);
    if (!(v.target in v.elements)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `target ${v.target} has no label`,
      });
    }
  });
export type VariantLabels = z.infer<typeof VariantLabelsSchema>;

export const BaseLabelsFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    pages: z.record(PageIdSchema, PageLabelsSchema),
  })
  .strict();
export type BaseLabelsFile = z.infer<typeof BaseLabelsFileSchema>;

export const variantId = (
  base: string,
  op: OperatorId,
  target: string,
): string => `${base}__${op}__${target}`;

export const VariantLabelsFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    variants: z.record(z.string(), VariantLabelsSchema),
  })
  .strict()
  .superRefine((f, ctx) => {
    for (const [id, v] of Object.entries(f.variants)) {
      if (
        id !== variantId(v.base, v.operator, v.target) ||
        v.file !== `${id}.html`
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${id}: id/file do not match base, operator, target`,
        });
      }
    }
  });
export type VariantLabelsFile = z.infer<typeof VariantLabelsFileSchema>;

export function acceptedGapTypes(label: ElementLabel): GapType[] {
  if (label.acceptableGapTypes) return [...label.acceptableGapTypes];
  return label.expectedGapType === null ? [] : [label.expectedGapType];
}

export const LiveSitesFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: z.string().min(1),
    sites: z.array(
      z
        .object({
          id: PageIdSchema,
          url: z.string().url(),
          status: z.enum(["usable", "degraded"]),
          // second-navigation: the first response is a placeholder; wait for the next main-frame navigation.
          // no-networkidle: networkidle may never settle, so never gate on it.
          flags: z.array(z.enum(["second-navigation", "no-networkidle"])),
          note: z.string().min(1),
        })
        .strict(),
    ),
    excluded: z.array(
      z
        .object({
          id: PageIdSchema,
          url: z.string().url(),
          reason: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();
export type LiveSitesFile = z.infer<typeof LiveSitesFileSchema>;
