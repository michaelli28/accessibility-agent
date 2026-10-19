// Seeded defect operators M1-M13: which elements each applies to, how it mutates the DOM (in Chromium), the one inline
// script it may append, and how it changes the ground-truth labels. M8-M13 were added after the labels froze, each to
// show one round-2 checker fix before and after (bench/COVERAGE.md); M13 is a decoy whose right answer is no gap.
import {
  VariantLabelsSchema,
  variantId,
  type ElementLabel,
  type GapType,
  type OperatorId,
  type PageFlags,
  type PageLabels,
  type VariantLabels,
} from "../labels-schema.js";

// Plain JS evaluated in the page as a string: tsx injects a `__name` helper into transpiled functions, which does not
// exist inside the browser. Targets must be visible at load and outside any aria-hidden subtree.
export const IN_PAGE_LIB = String.raw`(function () {
  var CLICKABLE = 'a[href], button, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="tab"], ' +
    '[role="menuitem"], input[type="checkbox"], input[type="radio"], input[type="submit"], input[type="button"], summary';
  var NAME_ONLY = '.sr-only, .visually-hidden, svg title';
  function tagged() { return Array.prototype.slice.call(document.querySelectorAll('[data-bench-id]')); }
  function benchId(el) { return el.getAttribute('data-bench-id'); }
  function visible(el) {
    return el.getClientRects().length > 0 && el.closest('[aria-hidden="true"]') === null &&
      el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  }
  function focusable(el) { return visible(el) && el.tabIndex >= 0 && el.disabled !== true; }
  // A Tab stop as M10's script tests it. No opacity test on purpose: an opacity-0 focus guard is still a Tab stop.
  function tabStop(el) { return el.tabIndex >= 0 && !el.disabled && el.checkVisibility({ visibilityProperty: true }); }
  // A keyboard-focusable scroller: it scrolls, and nothing inside it takes focus (Chromium then makes the box a Tab stop).
  function scrollRegion(el) {
    if (el === null) return false;
    var overflow = getComputedStyle(el).overflowY;
    return (overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight &&
      !Array.prototype.some.call(el.querySelectorAll('*'), function (n) { return n.tabIndex >= 0; });
  }
  function visibleText(el) {
    var copy = el.cloneNode(true);
    copy.querySelectorAll(NAME_ONLY).forEach(function (n) { n.remove(); });
    return copy.textContent.trim();
  }
  function hasNameSource(el) {
    if ((el.getAttribute('aria-label') || '').trim() !== '' || el.hasAttribute('aria-labelledby')) return true;
    if ((el.getAttribute('title') || '').trim() !== '') return true;
    return Array.prototype.some.call(el.querySelectorAll(NAME_ONLY + ', img[alt]'), function (n) {
      return (n.tagName === 'IMG' ? n.getAttribute('alt') : n.textContent).trim() !== '';
    });
  }
  var APPLIES = {
    M1: function (el) { return el.tagName === 'BUTTON' && visible(el) && visibleText(el) !== ''; },
    M2: function (el) {
      return el.tagName !== 'BUTTON' && el.getAttribute('role') === 'button' && el.hasAttribute('tabindex') && focusable(el);
    },
    M3: function (el) { return el.matches(CLICKABLE) && focusable(el); },
    M4: function (el) {
      return (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') && visible(el) &&
        visibleText(el) === '' && hasNameSource(el);
    },
    M5: focusable,
    M6: focusable,
    M7: focusable,
    M8: focusable,
    M9: focusable,
    // The last element in document order, tagged or not, that passes the script's stop test, so the loop holds every
    // stop that test counts. Document order is Tab order only without a positive tabindex, which no dev base has. The
    // test misses stops whose tabIndex reads -1, such as keyboard-focusable scrollers: on scroll-panel the target is
    // agree-button and the two scroll regions after it sit outside the loop (bench/COVERAGE.md).
    M10: function (el) {
      var all = Array.prototype.slice.call(document.querySelectorAll('*'));
      return focusable(el) && !all.slice(all.indexOf(el) + 1).some(tabStop);
    },
    M11: focusable,
    M12: function (el) {
      var next = el.nextElementSibling;
      return focusable(el) && scrollRegion(next) && scrollRegion(next.nextElementSibling);
    },
    M13: focusable
  };
  var MUTATE = {
    M1: function (el) {
      var div = document.createElement('div');
      ['data-bench-id', 'id', 'class', 'style'].forEach(function (a) {
        if (el.hasAttribute(a)) div.setAttribute(a, el.getAttribute(a));
      });
      div.style.cursor = 'pointer';
      div.style.display = 'inline-block';
      while (el.firstChild) div.appendChild(el.firstChild);
      el.replaceWith(div);
    },
    M2: function (el) { el.removeAttribute('tabindex'); },
    M3: function (el) { el.setAttribute('aria-hidden', 'true'); },
    M4: function (el) {
      ['aria-label', 'aria-labelledby', 'title'].forEach(function (a) { el.removeAttribute(a); });
      el.querySelectorAll(NAME_ONLY).forEach(function (n) { n.remove(); });
      el.querySelectorAll('img[alt]').forEach(function (n) { n.setAttribute('alt', ''); });
    },
    M5: function () {},
    M6: function () {},
    M7: function () {},
    M8: function () {},
    M9: function () {},
    M10: function () {},
    M11: function () {},
    M12: function () {},
    M13: function (el) { el.setAttribute('inert', ''); el.style.opacity = '0'; }
  };
  // Document markup with operator scripts dropped and every tagged element collapsed to a slot, so two pages can be
  // compared outside their tagged elements.
  function untaggedMarkup() {
    var root = document.documentElement.cloneNode(true);
    root.querySelectorAll('script[data-bench-op]').forEach(function (s) { s.remove(); });
    root.querySelectorAll('[data-bench-id]').forEach(function (el) {
      var slot = document.createElement('bench-slot');
      slot.setAttribute('data-bench-id', benchId(el));
      el.replaceWith(slot);
    });
    return root.outerHTML;
  }
  window.__benchLib = {
    candidates: function (op) { return tagged().filter(APPLIES[op]).map(benchId).sort(); },
    apply: function (op, target, script) {
      MUTATE[op](document.querySelector('[data-bench-id="' + target + '"]'));
      if (script !== null) {
        var s = document.createElement('script');
        s.setAttribute('data-bench-op', op);
        s.setAttribute('data-bench-target', target);
        s.textContent = script;
        document.body.appendChild(s);
      }
      // No newline after </html>: a reparse would move it into <body> and every reload would grow the page.
      return '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
    },
    snapshot: function () {
      var html = {};
      tagged().forEach(function (el) { html[benchId(el)] = el.outerHTML; });
      return {
        ids: tagged().map(benchId),
        html: html,
        scripts: Array.prototype.map.call(document.querySelectorAll('script[data-bench-op]'), function (s) {
          return {
            op: s.getAttribute('data-bench-op'),
            target: s.getAttribute('data-bench-target'),
            text: s.textContent,
            lastInBody: s.parentElement === document.body && s.nextElementSibling === null
          };
        }),
        rest: untaggedMarkup(),
        hasExternalScript: document.querySelector('script[src]') !== null
      };
    }
  };
})()`;

type Operator = {
  summary: string;
  // Page-level defects are seeded only on pages with none, so the page flag is attributable to the seed.
  pageLevel: boolean;
  // false for script-only operators (M5-M12): the target's markup is untouched and its script carries the change.
  changesMarkup: boolean;
  // Source of the single <script data-bench-op> appended as the last child of <body>, or null.
  script: ((target: string) => string) | null;
  relabel: (label: ElementLabel) => ElementLabel;
  reflag: (flags: PageFlags) => PageFlags;
  // Elements shown only through the target lose keyboard access with it.
  removesKeyboardAccess: boolean;
};

const byId = (target: string): string =>
  `document.querySelector('[data-bench-id="${target}"]')`;

function seeded(
  label: ElementLabel,
  op: OperatorId,
  change: {
    keyboardAccessible: boolean;
    gap: GapType | null;
    acceptable?: [GapType, ...GapType[]];
    what: string;
  },
): ElementLabel {
  return {
    interactive: true,
    keyboardAccessible: change.keyboardAccessible,
    expectedGapType: change.gap,
    ...(change.acceptable ? { acceptableGapTypes: change.acceptable } : {}),
    ...(label.revealedBy ? { revealedBy: label.revealedBy } : {}),
    note: `${op}: ${change.what} Base: ${label.note}`,
  };
}

const samePage = (flags: PageFlags): PageFlags => flags;

export const OPERATORS: Record<OperatorId, Operator> = {
  M1: {
    summary:
      "native <button> -> <div> with the same content and an addEventListener click handler",
    pageLevel: false,
    changesMarkup: true,
    script: (t) =>
      `${byId(t)}.addEventListener('click', function () { (window.__benchClicks = window.__benchClicks || []).push('${t}'); });`,
    relabel: (l) =>
      seeded(l, "M1", {
        keyboardAccessible: false,
        // Chromium keeps the div as an unignored `generic` AX node, so it is NOT missing from the tree.
        gap: "wrong_role",
        acceptable: ["wrong_role", "not_focusable"],
        what: "native <button> replaced by a <div> with the same content and a click listener; no role, not focusable, mouse-only.",
      }),
    reflag: samePage,
    removesKeyboardAccess: true,
  },
  M2: {
    summary: "remove tabindex from a role=button div",
    pageLevel: false,
    changesMarkup: true,
    script: null,
    relabel: (l) =>
      seeded(l, "M2", {
        keyboardAccessible: false,
        gap: "not_focusable",
        what: "tabindex removed from this role=button div; still exposed as a button but unreachable by keyboard.",
      }),
    reflag: samePage,
    removesKeyboardAccess: true,
  },
  M3: {
    summary: 'aria-hidden="true" on a visible clickable element',
    pageLevel: false,
    changesMarkup: true,
    script: null,
    relabel: (l) =>
      seeded(l, "M3", {
        keyboardAccessible: true,
        gap: "hidden_but_interactive",
        // aria-hidden really does remove it from the AX tree, so the literal type is also true.
        acceptable: ["hidden_but_interactive", "missing_from_a11y_tree"],
        what: 'aria-hidden="true" added to this visible, focusable control; keyboard still works, assistive tech cannot see it.',
      }),
    reflag: samePage,
    removesKeyboardAccess: false,
  },
  M4: {
    summary: "strip the accessible name from an icon button",
    pageLevel: false,
    changesMarkup: true,
    script: null,
    relabel: (l) =>
      seeded(l, "M4", {
        keyboardAccessible: true,
        gap: "no_accessible_name",
        what: "every name source (aria-label/labelledby, title, sr-only text, svg title, img alt) stripped from this icon-only button.",
      }),
    reflag: samePage,
    removesKeyboardAccess: false,
  },
  M5: {
    summary:
      "keydown handler that preventDefaults Tab and Shift+Tab on one element",
    pageLevel: true,
    changesMarkup: false,
    script: (t) =>
      `${byId(t)}.addEventListener('keydown', function (e) { if (e.key === 'Tab') e.preventDefault(); });`,
    relabel: (l) => ({
      ...l,
      note: `M5: a keydown handler here swallows Tab and Shift+Tab, trapping focus (page-level keyboardTrap; Escape does not release it). Base: ${l.note}`,
    }),
    reflag: (f) => ({ ...f, keyboardTrap: true, trapEscapable: false }),
    removesKeyboardAccess: false,
  },
  M6: {
    summary: "focus handler on one element that navigates to ?changed=1",
    pageLevel: true,
    changesMarkup: false,
    // The guard stops a reload loop: after the context change the new page behaves normally.
    script: (t) =>
      `${byId(t)}.addEventListener('focus', function () { if (location.search !== '?changed=1') location.search = '?changed=1'; });`,
    relabel: (l) => ({
      ...l,
      note: `M6: focusing this element navigates to ?changed=1 (page-level contextChangeOnFocus). Base: ${l.note}`,
    }),
    reflag: (f) => ({ ...f, contextChangeOnFocus: true }),
    removesKeyboardAccess: false,
  },
  M7: {
    summary:
      "focus handler on one element that immediately blurs it (W3C F55 blur-on-focus)",
    pageLevel: true,
    changesMarkup: false,
    // No guard is needed: focus is dropped to <body> and the next Tab continues AFTER this element
    // (bench/probes/wrap/RESULT.md, fixture E), so the walk moves on instead of looping here.
    script: (t) =>
      `${byId(t)}.addEventListener('focus', function () { this.blur(); });`,
    // Unlike M5/M6 the walk still completes here, so the target's own status is observable and is labelled:
    // not_focusable carries 2.1.1 + 2.4.7 (gaps/gap-detector.ts), the page flag carries F55, and 3.2.1 is
    // the context-change judge's. One observation, one criterion.
    relabel: (l) =>
      seeded(l, "M7", {
        keyboardAccessible: false,
        gap: "not_focusable",
        what: "a focus handler blurs this element as soon as Tab reaches it (W3C F55), so a complete Tab walk never leaves focus on it and it can never be operated; focus continues past it, so this is NOT a 2.1.2 trap.",
      }),
    reflag: (f) => ({ ...f, focusLostOnArrival: true }),
    // An element that cannot hold focus cannot be activated, so whatever it reveals is unreachable too.
    // No M7 target in this corpus reveals another element, so this path is not exercised today.
    removesKeyboardAccess: true,
  },
  M8: {
    summary:
      "focus handler on one element that blurs it 60 ms after focus (a deferred W3C F55)",
    pageLevel: true,
    changesMarkup: false,
    // 60 ms is past the ~1 ms in which a walk first reads focus after a press and inside its 150 ms settle: the
    // deferred removal the round-2 3.2.1 settle fix is built to refuse, so this row records that fix's cost.
    script: (t) =>
      `${byId(t)}.addEventListener('focus', function () { var e = this; setTimeout(function () { e.blur(); }, 60); });`,
    // Labelled by what a person gets, as M7. The gap detector counts an element reached when either read after a Tab
    // press found focus on it (gaps/keyboard.ts), so focus held for 60 ms reads as reachable: every M8 target is a
    // known gap-detector miss (bench/gaps-dev.test.ts), not a label to change.
    relabel: (l) =>
      seeded(l, "M8", {
        keyboardAccessible: false,
        gap: "not_focusable",
        what: "a focus handler blurs this element 60 ms after Tab reaches it (a deferred W3C F55), so focus never stays on it long enough to operate it; focus continues past it, so this is NOT a 2.1.2 trap.",
      }),
    reflag: (f) => ({ ...f, focusLostOnArrival: true }),
    removesKeyboardAccess: true,
  },
  M9: {
    summary:
      "M7's blur-on-focus plus a timer that rewrites the URL fragment every 100 ms (a scroll-spy)",
    pageLevel: true,
    changesMarkup: false,
    // replaceState, not location.hash: the fragment changes while the page idles and no focus moves, so the only focus
    // drops are the target's own. The timer touches no element, so the script still addresses the target alone.
    script: (t) =>
      `${byId(t)}.addEventListener('focus', function () { this.blur(); }); var n = 0; setInterval(function () { n++; history.replaceState(null, '', '#tick-' + n); }, 100);`,
    relabel: (l) =>
      seeded(l, "M9", {
        keyboardAccessible: false,
        gap: "not_focusable",
        what: "a focus handler blurs this element as soon as Tab reaches it (W3C F55) while a timer rewrites only the URL fragment every 100 ms (a scroll-spy that moves no focus and loads nothing); focus continues past it, so this is NOT a 2.1.2 trap.",
      }),
    reflag: (f) => ({ ...f, focusLostOnArrival: true }),
    removesKeyboardAccess: true,
  },
  M10: {
    summary:
      "Tab on the last stop focuses the first, and Shift+Tab on the first focuses the last (a script loop over every stop with tabIndex 0 or more)",
    pageLevel: true,
    changesMarkup: false,
    script: (t) =>
      `(function () { function stop(el) { return el.tabIndex >= 0 && !el.disabled && el.checkVisibility({ visibilityProperty: true }); } var last = ${byId(t)}; function first() { return Array.prototype.find.call(document.querySelectorAll('*'), stop); } document.addEventListener('keydown', function (e) { if (e.key !== 'Tab') return; if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first().focus(); } else if (e.shiftKey && document.activeElement === first()) { e.preventDefault(); last.focus(); } }); })();`,
    // Once focus is in the loop, Tab and Shift+Tab never take it out. Labelled a 2.1.2 trap by reading the loop as the
    // region in "cannot move focus out of some region", a decision recorded with its ambiguity in bench/COVERAGE.md.
    relabel: (l) => ({
      ...l,
      note: `M10: Tab here jumps to the page's first Tab stop and Shift+Tab on that first stop jumps here, so once focus is in this loop Tab and Shift+Tab alone never leave it (page-level keyboardTrap; Escape does not release it). Base: ${l.note}`,
    }),
    reflag: (f) => ({ ...f, keyboardTrap: true, trapEscapable: false }),
    removesKeyboardAccess: false,
  },
  M11: {
    summary:
      "Tab on one element replaces it with a copy of itself and focuses the copy (a stop re-rendered on every press)",
    pageLevel: true,
    changesMarkup: false,
    // The copy keeps data-bench-id, so --check (which presses no key) sees an unchanged page.
    script: (t) =>
      `(function () { var cur = ${byId(t)}; document.addEventListener('keydown', function (e) { if (e.key !== 'Tab' || document.activeElement !== cur) return; e.preventDefault(); var copy = cur.cloneNode(true); cur.replaceWith(copy); cur = copy; copy.focus(); }); })();`,
    relabel: (l) => ({
      ...l,
      note: `M11: Tab and Shift+Tab here replace this element with a copy of itself and focus the copy, so focus never leaves it (page-level keyboardTrap; Escape does not release it). Base: ${l.note}`,
    }),
    reflag: (f) => ({ ...f, keyboardTrap: true, trapEscapable: false }),
    removesKeyboardAccess: false,
  },
  M12: {
    summary:
      "Tab loops among one element and the two scroll regions after it (a trap region padded with stops the walk does not count)",
    pageLevel: true,
    changesMarkup: false,
    // The regions are addressed through the target's siblings, not by data-bench-id: they are keyboard-focusable
    // scrollers, Tab stops that carry no tag and that the walk's focusable count misses.
    script: (t) =>
      `(function () { var el = ${byId(t)}; var region = [el, el.nextElementSibling, el.nextElementSibling.nextElementSibling]; document.addEventListener('keydown', function (e) { if (e.key !== 'Tab') return; if (!e.shiftKey && document.activeElement === region[2]) { e.preventDefault(); region[0].focus(); } else if (e.shiftKey && document.activeElement === region[0]) { e.preventDefault(); region[2].focus(); } }); })();`,
    relabel: (l) => ({
      ...l,
      note: `M12: Tab and Shift+Tab loop focus among this element and the two scroll regions after it, so focus never leaves those three (page-level keyboardTrap; Escape does not release it). Base: ${l.note}`,
    }),
    reflag: (f) => ({ ...f, keyboardTrap: true, trapEscapable: false }),
    removesKeyboardAccess: false,
  },
  M13: {
    summary:
      "inert plus opacity: 0 on one element, as on a fade carousel's inactive slide (a decoy: the right answer is no gap)",
    pageLevel: false,
    changesMarkup: true,
    script: null,
    // Not seeded(), which makes the target interactive: the page switched this element off.
    relabel: (l) => ({
      interactive: false,
      keyboardAccessible: false,
      expectedGapType: null,
      note: `M13 (decoy): inert and opacity: 0 switch this element off for mouse, keyboard and assistive technology alike, as a page does for a fade carousel's inactive slide; no accessibility gap. Base: ${l.note}`,
    }),
    reflag: samePage,
    // Whatever only this element reveals is switched off with it.
    removesKeyboardAccess: true,
  },
};

export const isCleanPage = (f: PageFlags): boolean =>
  !f.keyboardTrap && !f.contextChangeOnFocus && !f.focusLostOnArrival;

// Seeds go on accessible, gap-free, visible-at-load elements so the variant's defect is the seeded one.
export const isCleanTarget = (l: ElementLabel): boolean =>
  l.interactive &&
  l.keyboardAccessible &&
  l.expectedGapType === null &&
  l.revealedBy === undefined;

function revealedThrough(
  elements: Record<string, ElementLabel>,
  id: string,
  target: string,
): boolean {
  const seen = new Set<string>();
  let cur = elements[id]?.revealedBy;
  while (cur !== undefined && !seen.has(cur)) {
    if (cur === target) return true;
    seen.add(cur);
    cur = elements[cur]?.revealedBy;
  }
  return false;
}

export function deriveVariantLabels(
  baseId: string,
  base: PageLabels,
  op: OperatorId,
  target: string,
): VariantLabels {
  const spec = OPERATORS[op];
  const elements: Record<string, ElementLabel> = {};
  for (const [id, label] of Object.entries(base.elements)) {
    if (id === target) {
      elements[id] = spec.relabel(label);
    } else if (
      spec.removesKeyboardAccess &&
      label.keyboardAccessible &&
      revealedThrough(base.elements, id, target)
    ) {
      elements[id] = {
        ...label,
        keyboardAccessible: false,
        note: `${label.note} Unreachable by keyboard in this variant: its opener ${target} is no longer keyboard-operable (${op}).`,
      };
    } else {
      elements[id] = label;
    }
  }
  const id = variantId(baseId, op, target);
  return VariantLabelsSchema.parse({
    file: `${id}.html`,
    base: baseId,
    operator: op,
    target,
    page: spec.reflag(base.page),
    elements,
  });
}
