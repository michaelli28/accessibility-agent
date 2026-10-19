// Every expected difference between the UNMODIFIED taskgen dual crawl and the fixed packages/accessibility port, per
// parity fixture, tagged with the fix that explains it (F1 hidden candidates, F2 generic roles and aria-hidden, F3 Tab
// walk, F9 discovery and cursor). The G1b/G1c follow-ups (a zero-area element kept only as a Tab stop; disabled
// controls, members of widgets that handle arrow keys or aria-activedescendant, and widget containers holding focus not
// not_focusable) refine F1 and F3 and carry those ids. parity.test.ts fails on any difference missing here and on any
// entry here that no longer occurs. Token formats are documented at diffTokens in parity.test.ts; count repeats an
// identical token.
import { z } from "zod";

export const FIX_IDS = ["F1", "F2", "F3", "F9"] as const;
export const LedgerEntrySchema = z
  .object({
    fix: z.enum(FIX_IDS),
    diff: z.string().min(1),
    count: z.number().int().min(2).optional(),
  })
  .strict();
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;
export const LedgerSchema = z.record(z.string(), z.array(LedgerEntrySchema));

export const DIVERGENCE_LEDGER: Record<string, LedgerEntry[]> =
  LedgerSchema.parse({
    // Unnamed generic and ignored AX nodes are now kept (F2); no gap changes.
    "good-operable": [
      { fix: "F2", diff: 'ax+ generic ""' },
      { fix: "F2", diff: 'ax+ none "" ignored:presentationalRole', count: 3 },
      { fix: "F2", diff: 'ax+ none "" ignored:uninteresting', count: 2 },
    ],
    // Hidden inputs/buttons dropped (F1); unnamed clickable generics and aria-hidden controls get wrong_role/hidden_but_interactive (F2); not_focusable now comes from the Tab walk, which also catches the junk tabindex and the href-less anchor (F3); the <details> is a group, not a control missing its name (F2).
    "branches-inline": [
      { fix: "F2", diff: 'ax+ generic ""', count: 5 },
      { fix: "F2", diff: 'ax+ none "" ignored:ariaHiddenElement' },
      { fix: "F2", diff: 'ax+ none "" ignored:ariaHiddenSubtree' },
      { fix: "F2", diff: 'ax+ none "" ignored:notRendered' },
      { fix: "F2", diff: 'ax+ none "" ignored:presentationalRole', count: 2 },
      { fix: "F2", diff: 'ax+ none "" ignored:uninteresting', count: 4 },
      {
        fix: "F3",
        diff: "gap+ A[anchor-no-href] not_focusable/critical: A element has click handlers but a complete Tab walk never focused it",
      },
      {
        fix: "F2",
        diff: 'gap+ BUTTON[aria-hidden-button] hidden_but_interactive/moderate: BUTTON element has aria-hidden="true" but is interactive',
      },
      {
        fix: "F2",
        diff: 'gap+ DIV[div-onclick] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F3",
        diff: "gap+ DIV[role-button-onclick] not_focusable/critical: DIV element has click handlers but a complete Tab walk never focused it",
      },
      {
        fix: "F3",
        diff: "gap+ DIV[role-button-tabindex-junk] not_focusable/critical: DIV element has click handlers but a complete Tab walk never focused it",
      },
      {
        fix: "F3",
        diff: "gap+ DIV[role-button-tabindex-neg] not_focusable/critical: DIV element has click handlers but a complete Tab walk never focused it",
      },
      {
        fix: "F2",
        diff: 'gap+ SPAN[span-tabindex-neg] wrong_role/serious: SPAN element has click handlers but generic role "generic"',
      },
      {
        fix: "F2",
        diff: "gap- BUTTON[aria-hidden-button] missing_from_a11y_tree/critical: BUTTON element with interactivity signals is not exposed in the accessibility tree",
      },
      {
        fix: "F1",
        diff: "gap- BUTTON[button-hidden-attr] missing_from_a11y_tree/critical: BUTTON element with interactivity signals is not exposed in the accessibility tree",
      },
      {
        fix: "F2",
        diff: "gap- DETAILS[details] no_accessible_name/serious: Interactive DETAILS element has no accessible name",
      },
      {
        fix: "F2",
        diff: "gap- DIV[div-onclick] missing_from_a11y_tree/critical: DIV element with interactivity signals is not exposed in the accessibility tree",
      },
      {
        fix: "F3",
        diff: "gap- DIV[role-button-onclick] not_focusable/critical: DIV element has click handlers but has no tabindex and is not a native interactive element",
      },
      {
        fix: "F3",
        diff: 'gap- DIV[role-button-tabindex-neg] not_focusable/critical: DIV element has click handlers but tabindex="-1" makes it unfocusable',
      },
      {
        fix: "F1",
        diff: "gap- INPUT[input-display-none] missing_from_a11y_tree/critical: INPUT element with interactivity signals is not exposed in the accessibility tree",
      },
      {
        fix: "F1",
        diff: "gap- INPUT[input-hidden] missing_from_a11y_tree/critical: INPUT element with interactivity signals is not exposed in the accessibility tree",
      },
      {
        fix: "F2",
        diff: "gap- SPAN[span-tabindex-neg] missing_from_a11y_tree/critical: SPAN element with interactivity signals is not exposed in the accessibility tree",
      },
    ],
    // The hidden dropdown's links are dropped (F1); the zero-area icon button takes focus, so it is kept and flagged as taskgen does (F1, G1b). Generic listener divs get wrong_role (F2); the plain listener div is discovered (F9); not_focusable from the walk (F3), tab-2 included: its tablist handles no arrow keys (F3, G1c).
    "branches-scripted": [
      { fix: "F2", diff: 'ax+ generic ""', count: 4 },
      { fix: "F2", diff: 'ax+ none "" ignored:uninteresting', count: 2 },
      { fix: "F9", diff: "enum+ DIV[div-listener-plain]" },
      {
        fix: "F2",
        diff: 'gap+ DIV[div-btn-listener] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F9",
        diff: 'gap+ DIV[div-listener-plain] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F3",
        diff: "gap+ DIV[tab-2] not_focusable/critical: DIV element has click handlers but a complete Tab walk never focused it",
      },
      {
        fix: "F3",
        diff: "gap+ SPAN[checkbox-keydown] not_focusable/critical: SPAN element has click handlers but a complete Tab walk never focused it",
      },
      {
        fix: "F3",
        diff: "gap+ SPAN[role-button-listener] not_focusable/critical: SPAN element has click handlers but a complete Tab walk never focused it",
      },
      {
        fix: "F1",
        diff: "gap- A[menu-logout] missing_from_a11y_tree/critical: A element with interactivity signals is not exposed in the accessibility tree",
      },
      {
        fix: "F1",
        diff: "gap- A[menu-orders] missing_from_a11y_tree/critical: A element with interactivity signals is not exposed in the accessibility tree",
      },
      {
        fix: "F1",
        diff: "gap- A[menu-profile] missing_from_a11y_tree/critical: A element with interactivity signals is not exposed in the accessibility tree",
      },
      {
        fix: "F2",
        diff: "gap- DIV[div-btn-listener] missing_from_a11y_tree/critical: DIV element with interactivity signals is not exposed in the accessibility tree",
      },
      {
        fix: "F3",
        diff: 'gap- DIV[tab-2] not_focusable/critical: DIV element has click handlers but tabindex="-1" makes it unfocusable',
      },
      {
        fix: "F3",
        diff: "gap- SPAN[checkbox-keydown] not_focusable/critical: SPAN element has click handlers but has no tabindex and is not a native interactive element",
      },
      {
        fix: "F3",
        diff: "gap- SPAN[role-button-listener] not_focusable/critical: SPAN element has click handlers but has no tabindex and is not a native interactive element",
      },
    ],
    // Unnamed generics get wrong_role instead of missing_from_a11y_tree, the unnamed group and the focused aria-hidden group get wrong_role before the name check (F2); visibility:hidden candidates dropped (F1), while the zero-area img-link takes focus and is kept (F1, G1b); shadow-root elements discovered (F9); cursor:pointer now read, img-link's included (F9); not_focusable from the walk (F3), gc-onclick included: its grid handles no arrow keys (F3, G1c); the inert button, which Chromium leaves out of the tree, is no candidate (F2).
    stress: [
      { fix: "F2", diff: 'ax+ generic ""', count: 24 },
      { fix: "F2", diff: 'ax+ none "" ignored:presentationalRole', count: 6 },
      { fix: "F2", diff: 'ax+ none "" ignored:uninteresting', count: 2 },
      { fix: "F9", diff: "enum+ BUTTON[]" },
      { fix: "F9", diff: "enum+ DIV[.btn]" },
      {
        fix: "F9",
        diff: 'gap+ DIV[.btn] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F2",
        diff: 'gap+ DIV[aria-hidden-focused] wrong_role/serious: DIV element has click handlers but generic role "group"',
      },
      {
        fix: "F2",
        diff: 'gap+ DIV[card] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F2",
        diff: 'gap+ DIV[div-tab-empty] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F2",
        diff: 'gap+ DIV[div-tab-neg2] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F2",
        diff: 'gap+ DIV[div-tab-spaced] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F2",
        diff: 'gap+ DIV[div-tab0-keydown-listener] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F2",
        diff: 'gap+ DIV[div-tab0-onclick] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F2",
        diff: 'gap+ DIV[div-tab3-onclick] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F2",
        diff: 'gap+ DIV[empty-role] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F3",
        diff: "gap+ DIV[gc-onclick] not_focusable/critical: DIV element has click handlers but a complete Tab walk never focused it",
      },
      {
        fix: "F2",
        diff: 'gap+ DIV[group-unnamed-onclick] wrong_role/serious: DIV element has click handlers but generic role "group"',
      },
      {
        fix: "F2",
        diff: 'gap+ DIV[late-btn] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F3",
        diff: "gap+ DIV[late-role-button] not_focusable/critical: DIV element has click handlers but a complete Tab walk never focused it",
      },
      {
        fix: "F2",
        diff: 'gap+ DIV[ng-click] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F3",
        diff: "gap+ DIV[opt-onclick] not_focusable/critical: DIV element has click handlers but a complete Tab walk never focused it",
      },
      {
        fix: "F3",
        diff: "gap+ DIV[opt-touch] not_focusable/critical: DIV element has click handlers but a complete Tab walk never focused it",
      },
      {
        fix: "F2",
        diff: 'gap+ DIV[upper-btn] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F2",
        diff: 'gap+ DIV[vue-von] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F3",
        diff: "gap+ LI[mi-checkbox] not_focusable/critical: LI element has click handlers but a complete Tab walk never focused it",
      },
      {
        fix: "F3",
        diff: "gap+ LI[mi-onclick] not_focusable/critical: LI element has click handlers but a complete Tab walk never focused it",
      },
      {
        fix: "F2",
        diff: 'gap+ SPAN[action-ptr] wrong_role/serious: SPAN element has click handlers but generic role "generic"',
      },
      {
        fix: "F3",
        diff: "gap+ SPAN[inner-rb] not_focusable/critical: SPAN element has click handlers but a complete Tab walk never focused it",
      },
      {
        fix: "F2",
        diff: 'gap+ SPAN[span-onmouseup] wrong_role/serious: SPAN element has click handlers but generic role "generic"',
      },
      {
        fix: "F2",
        diff: "gap- BUTTON[inert-button] missing_from_a11y_tree/critical: BUTTON element with interactivity signals is not exposed in the accessibility tree",
      },
      {
        fix: "F1",
        diff: "gap- BUTTON[visibility-hidden] missing_from_a11y_tree/critical: BUTTON element with interactivity signals is not exposed in the accessibility tree",
      },
      {
        fix: "F2",
        diff: "gap- DIV[aria-hidden-focused] no_accessible_name/serious: Interactive DIV element has no accessible name",
      },
      {
        fix: "F2",
        diff: "gap- DIV[card] missing_from_a11y_tree/critical: DIV element with interactivity signals is not exposed in the accessibility tree",
      },
      {
        fix: "F2",
        diff: "gap- DIV[div-tab-empty] missing_from_a11y_tree/critical: DIV element with interactivity signals is not exposed in the accessibility tree",
      },
      {
        fix: "F2",
        diff: "gap- DIV[div-tab-neg2] missing_from_a11y_tree/critical: DIV element with interactivity signals is not exposed in the accessibility tree",
      },
      {
        fix: "F2",
        diff: "gap- DIV[div-tab-spaced] missing_from_a11y_tree/critical: DIV element with interactivity signals is not exposed in the accessibility tree",
      },
      {
        fix: "F2",
        diff: "gap- DIV[div-tab0-keydown-listener] missing_from_a11y_tree/critical: DIV element with interactivity signals is not exposed in the accessibility tree",
      },
      {
        fix: "F2",
        diff: "gap- DIV[div-tab0-onclick] missing_from_a11y_tree/critical: DIV element with interactivity signals is not exposed in the accessibility tree",
      },
      {
        fix: "F2",
        diff: "gap- DIV[div-tab3-onclick] missing_from_a11y_tree/critical: DIV element with interactivity signals is not exposed in the accessibility tree",
      },
      {
        fix: "F2",
        diff: "gap- DIV[empty-role] missing_from_a11y_tree/critical: DIV element with interactivity signals is not exposed in the accessibility tree",
      },
      {
        fix: "F3",
        diff: "gap- DIV[gc-onclick] not_focusable/critical: DIV element has click handlers but has no tabindex and is not a native interactive element",
      },
      {
        fix: "F2",
        diff: "gap- DIV[group-unnamed-onclick] no_accessible_name/serious: Interactive DIV element has no accessible name",
      },
      {
        fix: "F2",
        diff: "gap- DIV[late-btn] missing_from_a11y_tree/critical: DIV element with interactivity signals is not exposed in the accessibility tree",
      },
      {
        fix: "F3",
        diff: "gap- DIV[late-role-button] not_focusable/critical: DIV element has click handlers but has no tabindex and is not a native interactive element",
      },
      {
        fix: "F2",
        diff: "gap- DIV[ng-click] missing_from_a11y_tree/critical: DIV element with interactivity signals is not exposed in the accessibility tree",
      },
      {
        fix: "F3",
        diff: "gap- DIV[opt-onclick] not_focusable/critical: DIV element has click handlers but has no tabindex and is not a native interactive element",
      },
      {
        fix: "F3",
        diff: "gap- DIV[opt-touch] not_focusable/critical: DIV element has click handlers but has no tabindex and is not a native interactive element",
      },
      {
        fix: "F2",
        diff: "gap- DIV[upper-btn] missing_from_a11y_tree/critical: DIV element with interactivity signals is not exposed in the accessibility tree",
      },
      {
        fix: "F2",
        diff: "gap- DIV[vue-von] missing_from_a11y_tree/critical: DIV element with interactivity signals is not exposed in the accessibility tree",
      },
      {
        fix: "F3",
        diff: "gap- LI[mi-checkbox] not_focusable/critical: LI element has click handlers but has no tabindex and is not a native interactive element",
      },
      {
        fix: "F3",
        diff: "gap- LI[mi-onclick] not_focusable/critical: LI element has click handlers but has no tabindex and is not a native interactive element",
      },
      {
        fix: "F2",
        diff: "gap- SPAN[action-ptr] missing_from_a11y_tree/critical: SPAN element with interactivity signals is not exposed in the accessibility tree",
      },
      {
        fix: "F3",
        diff: "gap- SPAN[inner-rb] not_focusable/critical: SPAN element has click handlers but has no tabindex and is not a native interactive element",
      },
      {
        fix: "F2",
        diff: "gap- SPAN[span-onmouseup] missing_from_a11y_tree/critical: SPAN element with interactivity signals is not exposed in the accessibility tree",
      },
      {
        fix: "F9",
        diff: "signals~ A[img-link] hasCursorPointer: false -> true",
      },
      {
        fix: "F9",
        diff: "signals~ SPAN[action-ptr] hasCursorPointer: false -> true",
      },
    ],
    // not_focusable evidence now cites the Tab walk (F3).
    "focused-hidden-named": [
      { fix: "F2", diff: 'ax+ none "" ignored:uninteresting', count: 2 },
      {
        fix: "F3",
        diff: "gap+ DIV[aria-hidden-focused-named] not_focusable/critical: DIV element has click handlers but a complete Tab walk never focused it",
      },
      {
        fix: "F3",
        diff: 'gap- DIV[aria-hidden-focused-named] not_focusable/critical: DIV element has click handlers but tabindex="-1" makes it unfocusable',
      },
    ],
    // Unnamed generic and ignored AX nodes are now kept (F2); no gap changes.
    "wrap-a": [
      { fix: "F2", diff: 'ax+ none "" ignored:uninteresting', count: 2 },
    ],
    // Unnamed generic and ignored AX nodes are now kept (F2); no gap changes.
    "wrap-b": [
      { fix: "F2", diff: 'ax+ none "" ignored:uninteresting', count: 2 },
    ],
    // Unnamed generic and ignored AX nodes are now kept (F2); no gap changes.
    "wrap-c": [
      { fix: "F2", diff: 'ax+ generic ""' },
      { fix: "F2", diff: 'ax+ none "" ignored:uninteresting', count: 2 },
    ],
    // Unnamed generic and ignored AX nodes are now kept (F2); no gap changes.
    "wrap-d": [
      { fix: "F2", diff: 'ax+ none "" ignored:uninteresting', count: 2 },
    ],
    // F55 blur-on-focus link: Tab lands on it but focus is dropped before any read, so the walk never sees it focused (F3).
    "wrap-e": [
      { fix: "F2", diff: 'ax+ none "" ignored:uninteresting', count: 2 },
      {
        fix: "F3",
        diff: "gap+ A[blurme] not_focusable/critical: A element has cursor:pointer but a complete Tab walk never focused it",
      },
    ],
    // a: wrong_role instead of missing_from_a11y_tree (F2) and cursor:pointer read (F9); b/c (onClick) and g/h/i (onMouseDown/onKeyDown/onPointerDown props) discovered and flagged (F9).
    "react18-prod": [
      { fix: "F2", diff: 'ax+ generic ""', count: 9 },
      { fix: "F2", diff: 'ax+ none "" ignored:uninteresting', count: 2 },
      { fix: "F9", diff: "enum+ DIV[b]" },
      { fix: "F9", diff: "enum+ DIV[c]" },
      { fix: "F9", diff: "enum+ DIV[g]" },
      { fix: "F9", diff: "enum+ DIV[h]" },
      { fix: "F9", diff: "enum+ DIV[i]" },
      {
        fix: "F2",
        diff: 'gap+ DIV[a] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F9",
        diff: 'gap+ DIV[b] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F9",
        diff: 'gap+ DIV[c] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F9",
        diff: 'gap+ DIV[g] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F9",
        diff: 'gap+ DIV[h] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F9",
        diff: 'gap+ DIV[i] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F2",
        diff: "gap- DIV[a] missing_from_a11y_tree/critical: DIV element with interactivity signals is not exposed in the accessibility tree",
      },
      { fix: "F9", diff: "signals~ DIV[a] hasCursorPointer: false -> true" },
    ],
    // a: wrong_role instead of missing_from_a11y_tree (F2) and cursor:pointer read (F9); b/c (onClick) and g/h/i (onMouseDown/onKeyDown/onPointerDown props) discovered and flagged (F9).
    "react18-dev": [
      { fix: "F2", diff: 'ax+ generic ""', count: 9 },
      { fix: "F2", diff: 'ax+ none "" ignored:uninteresting', count: 2 },
      { fix: "F9", diff: "enum+ DIV[b]" },
      { fix: "F9", diff: "enum+ DIV[c]" },
      { fix: "F9", diff: "enum+ DIV[g]" },
      { fix: "F9", diff: "enum+ DIV[h]" },
      { fix: "F9", diff: "enum+ DIV[i]" },
      {
        fix: "F2",
        diff: 'gap+ DIV[a] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F9",
        diff: 'gap+ DIV[b] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F9",
        diff: 'gap+ DIV[c] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F9",
        diff: 'gap+ DIV[g] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F9",
        diff: 'gap+ DIV[h] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F9",
        diff: 'gap+ DIV[i] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F2",
        diff: "gap- DIV[a] missing_from_a11y_tree/critical: DIV element with interactivity signals is not exposed in the accessibility tree",
      },
      { fix: "F9", diff: "signals~ DIV[a] hasCursorPointer: false -> true" },
    ],
    // a: wrong_role instead of missing_from_a11y_tree (F2) and cursor:pointer read (F9); b/c (onClick) and g/h/i (onMouseDown/onKeyDown/onPointerDown props) discovered and flagged (F9).
    "react19-prod": [
      { fix: "F2", diff: 'ax+ generic ""', count: 9 },
      { fix: "F2", diff: 'ax+ none "" ignored:uninteresting', count: 2 },
      { fix: "F9", diff: "enum+ DIV[b]" },
      { fix: "F9", diff: "enum+ DIV[c]" },
      { fix: "F9", diff: "enum+ DIV[g]" },
      { fix: "F9", diff: "enum+ DIV[h]" },
      { fix: "F9", diff: "enum+ DIV[i]" },
      {
        fix: "F2",
        diff: 'gap+ DIV[a] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F9",
        diff: 'gap+ DIV[b] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F9",
        diff: 'gap+ DIV[c] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F9",
        diff: 'gap+ DIV[g] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F9",
        diff: 'gap+ DIV[h] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F9",
        diff: 'gap+ DIV[i] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F2",
        diff: "gap- DIV[a] missing_from_a11y_tree/critical: DIV element with interactivity signals is not exposed in the accessibility tree",
      },
      { fix: "F9", diff: "signals~ DIV[a] hasCursorPointer: false -> true" },
    ],
    // a: wrong_role instead of missing_from_a11y_tree (F2) and cursor:pointer read (F9); b/c (onClick) and g/h/i (onMouseDown/onKeyDown/onPointerDown props) discovered and flagged (F9).
    "react19-dev": [
      { fix: "F2", diff: 'ax+ generic ""', count: 9 },
      { fix: "F2", diff: 'ax+ none "" ignored:uninteresting', count: 2 },
      { fix: "F9", diff: "enum+ DIV[b]" },
      { fix: "F9", diff: "enum+ DIV[c]" },
      { fix: "F9", diff: "enum+ DIV[g]" },
      { fix: "F9", diff: "enum+ DIV[h]" },
      { fix: "F9", diff: "enum+ DIV[i]" },
      {
        fix: "F2",
        diff: 'gap+ DIV[a] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F9",
        diff: 'gap+ DIV[b] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F9",
        diff: 'gap+ DIV[c] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F9",
        diff: 'gap+ DIV[g] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F9",
        diff: 'gap+ DIV[h] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F9",
        diff: 'gap+ DIV[i] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F2",
        diff: "gap- DIV[a] missing_from_a11y_tree/critical: DIV element with interactivity signals is not exposed in the accessibility tree",
      },
      { fix: "F9", diff: "signals~ DIV[a] hasCursorPointer: false -> true" },
    ],
    // The inline-onclick div gets wrong_role (F2); the addEventListener div is discovered (F9).
    control: [
      { fix: "F2", diff: 'ax+ generic ""', count: 3 },
      { fix: "F2", diff: 'ax+ none "" ignored:uninteresting', count: 2 },
      { fix: "F9", diff: "enum+ DIV[ctl-listener]" },
      {
        fix: "F2",
        diff: 'gap+ DIV[ctl-inline] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F9",
        diff: 'gap+ DIV[ctl-listener] wrong_role/serious: DIV element has click handlers but generic role "generic"',
      },
      {
        fix: "F2",
        diff: "gap- DIV[ctl-inline] missing_from_a11y_tree/critical: DIV element with interactivity signals is not exposed in the accessibility tree",
      },
    ],
  });
