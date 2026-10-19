# Checkpoint 1 spot-check

20 recorded labels drawn by `npx tsx bench/spotcheck.ts` with seed `checkpoint1-spotcheck`; rerunning overwrites this file.
Start the pages first: `npx tsx bench/seed.ts` (writes the /variants/ pages), then `npx tsx bench/serve.ts` (http://127.0.0.1:4173). Name and role: Chrome DevTools → Elements → Accessibility.
Find an element by selector: DevTools → Elements, Cmd/Ctrl+F, paste the selector.

## Dev element labels (8 of 78: one seeded-variant target per gap operator, M1/M2/M3/M4, from 15; 4 base labels from 63 in bench/corpus/dev/labels.json)

1. [x] **good-operable__M1__search-submit · `search-submit`**
    - open <http://127.0.0.1:4173/variants/good-operable__M1__search-submit.html> and find `[data-bench-id="search-submit"]`
    - test: From a fresh load: Tab (Shift+Tab to go back) and note whether it ever takes focus; if it does, press Enter (and Space if it acts as a button) and check it does what a click does. Check its name and role in DevTools → Elements → Accessibility.
    - recorded: `interactive=true keyboardAccessible=false expectedGapType=wrong_role acceptableGapTypes=wrong_role,not_focusable`: M1: native \<button> replaced by a \<div> with the same content and a click listener; no role, not focusable, mouse-only. Base: Native submit button 'Go'.
    - agree? / note: agree
2. [x] **js-handlers__M2__custom-button · `custom-button`**
    - open <http://127.0.0.1:4173/variants/js-handlers__M2__custom-button.html> and find `[data-bench-id="custom-button"]`
    - test: From a fresh load: Tab (Shift+Tab to go back) and note whether it ever takes focus; if it does, press Enter (and Space if it acts as a button) and check it does what a click does. Check its name and role in DevTools → Elements → Accessibility.
    - recorded: `interactive=true keyboardAccessible=false expectedGapType=not_focusable`: M2: tabindex removed from this role=button div; still exposed as a button but unreachable by keyboard. Base: div role=button tabindex=0; click + keydown Enter/Space attached with addEventListener. Accessible: a clean positive.
    - agree? / note: agree
3. [x] **navbar__M3__brand · `brand`**
    - open <http://127.0.0.1:4173/variants/navbar__M3__brand.html> and find `[data-bench-id="brand"]`
    - test: From a fresh load: Tab (Shift+Tab to go back) and note whether it ever takes focus; if it does, press Enter (and Space if it acts as a button) and check it does what a click does. Check its name and role in DevTools → Elements → Accessibility.
    - recorded: `interactive=true keyboardAccessible=true expectedGapType=hidden_but_interactive acceptableGapTypes=hidden_but_interactive,missing_from_a11y_tree`: M3: aria-hidden="true" added to this visible, focusable control; keyboard still works, assistive tech cannot see it. Base: Brand link.
    - agree? / note: agree
4. [x] **modal__M4__close-button · `close-button`**
    - open <http://127.0.0.1:4173/variants/modal__M4__close-button.html> and find `[data-bench-id="close-button"]`
    - test: From a fresh load: Tab (Shift+Tab to go back) and note whether it ever takes focus; if it does, press Enter (and Space if it acts as a button) and check it does what a click does. Check its name and role in DevTools → Elements → Accessibility.
    - recorded: `interactive=true keyboardAccessible=true expectedGapType=no_accessible_name`: M4: every name source (aria-label/labelledby, title, sr-only text, svg title, img alt) stripped from this icon-only button. Base: Icon-only close button (shadcn pattern): svg aria-hidden plus sr-only text 'Close' as its name.
    - agree? / note: agree
5. [x] **form · `message-textarea`**
    - open <http://127.0.0.1:4173/corpus/dev/base/form.html> and find `[data-bench-id="message-textarea"]`
    - test: From a fresh load: Tab (Shift+Tab to go back) and note whether it ever takes focus; if it does, press Enter (and Space if it acts as a button) and check it does what a click does. Check its name and role in DevTools → Elements → Accessibility.
    - recorded: `interactive=true keyboardAccessible=true expectedGapType=null`: Textarea with \<label for>.
    - agree? / note: agree
6. [x] **identical-links · `read-more-03`**
    - open <http://127.0.0.1:4173/corpus/dev/base/identical-links.html> and find `[data-bench-id="read-more-03"]`
    - test: From a fresh load: Tab (Shift+Tab to go back) and note whether it ever takes focus; if it does, press Enter (and Space if it acts as a button) and check it does what a click does. Check its name and role in DevTools → Elements → Accessibility.
    - recorded: `interactive=true keyboardAccessible=true expectedGapType=null`: One of 12 identical 'Read more' links (same text, same href, no id); only position tells them apart.
    - agree? / note: agree
7. [x] **identical-links · `read-more-11`**
    - open <http://127.0.0.1:4173/corpus/dev/base/identical-links.html> and find `[data-bench-id="read-more-11"]`
    - test: From a fresh load: Tab (Shift+Tab to go back) and note whether it ever takes focus; if it does, press Enter (and Space if it acts as a button) and check it does what a click does. Check its name and role in DevTools → Elements → Accessibility.
    - recorded: `interactive=true keyboardAccessible=true expectedGapType=null`: One of 12 identical 'Read more' links (same text, same href, no id); only position tells them apart.
    - agree? / note: agree
8. [x] **navbar · `dropdown-item-3`**
    - open <http://127.0.0.1:4173/corpus/dev/base/navbar.html> and find `[data-bench-id="dropdown-item-3"]`
    - test: From a fresh load: Reveal it first: Tab to `[data-bench-id="dropdown-toggle"]` and press Enter. Then Tab (Shift+Tab to go back) and note whether it ever takes focus; if it does, press Enter (and Space if it acts as a button) and check it does what a click does. Check its name and role in DevTools → Elements → Accessibility.
    - recorded: `interactive=true keyboardAccessible=true expectedGapType=null revealedBy=dropdown-toggle`: a.dropdown-item in the collapsed menu (display:none until opened). Hidden from everyone while closed, which is correct, not a gap.
    - agree? / note: agree

## Dev page flags (2 of 41: base pages + seeded variants)

9. [x] **js-handlers (base page)**
    - open <http://127.0.0.1:4173/corpus/dev/base/js-handlers.html>
    - test: From a fresh load, Tab through every stop to the end of the page, then Shift+Tab back to the top, opening any menu or dialog on the way with Enter. Trap: focus cycles inside one region and cannot leave (then try Escape). Context change: focusing something, without pressing Enter, navigates or changes the URL. Focus lost: the focus ring vanishes as soon as Tab lands on an element (console: `document.activeElement === document.body`).
    - recorded: `keyboardTrap=false trapEscapable=null contextChangeOnFocus=false focusLostOnArrival=false`
    - agree? / note: agree
10. [x] **navbar__M3__brand (M3 applied to `[data-bench-id="brand"]`)**
    - open <http://127.0.0.1:4173/variants/navbar__M3__brand.html>
    - test: From a fresh load, Tab through every stop to the end of the page, then Shift+Tab back to the top, opening any menu or dialog on the way with Enter. Trap: focus cycles inside one region and cannot leave (then try Escape). Context change: focusing something, without pressing Enter, navigates or changes the URL. Focus lost: the focus ring vanishes as soon as Tab lands on an element (console: `document.activeElement === document.body`).
    - recorded: `keyboardTrap=false trapEscapable=null contextChangeOnFocus=false focusLostOnArrival=false`
    - agree? / note: agree

## BAD page-level results (6 of 48: SC 2.1.1, 2.1.2, 2.4.3, 2.4.7, 3.2.1, 4.1.2, bench/corpus/test/bad-labels.json)

11. [x] **after/news · SC 4.1.2 Name, Role, Value**
    - open <http://127.0.0.1:4173/bad/after/news.html>; the W3C report it was read from is <http://127.0.0.1:4173/bad/after/reports/news.html>
    - test: Inspect each control in DevTools → Elements → Accessibility. Fail if any lacks a name, the right role, or its state.
    - recorded: `result=Pass techniques=G108,H65,H88,H91,SCR21 mappings=0`; reader A quoted "Technique G108 - Using markup features to expose the name and role, allow user-settable properties to be directly set, and provide notification of changes | Technique H65 - Using the title attribute to identify form controls when the label element cannot be used | Technique H88 - Using HTML according to spec | Technique H91 - Using HTML form controls and links | Technique SCR21 - Using functions of the Document Object Model (DOM) to add content to a page"; reader B quoted nothing
    - agree? / note: agree
12. [x] **after/tickets · SC 3.2.1 On Focus**
    - open <http://127.0.0.1:4173/bad/after/tickets.html>; the W3C report it was read from is <http://127.0.0.1:4173/bad/after/reports/tickets.html>
    - test: Tab through the page without pressing Enter. Fail if merely focusing something navigates, opens a window, or throws focus away.
    - recorded: `result=Pass techniques=none mappings=0`; both readers quoted "No changes of context are initiated when any component receives focus"
    - agree? / note: agree
13. [x] **before/home · SC 4.1.2 Name, Role, Value**
    - open <http://127.0.0.1:4173/bad/before/home.html>; the W3C report it was read from is <http://127.0.0.1:4173/bad/before/reports/home.html>
    - test: Inspect each control in DevTools → Elements → Accessibility. Fail if any lacks a name, the right role, or its state.
    - recorded: `result=Fail techniques=F68,F79,F89 mappings=11`; both readers quoted "Failure F68 - Failure of Success Criterion 1.3.1 and 4.1.2 due to the association of label and user interface controls not being programmatically determinable | Failure F79 - Failure of Success Criterion 4.1.2 due to the focus state of a user interface component not being programmatically determinable or no notification of change of focus state available | Failure F89 - Failure of 2.4.4, 2.4.9 and 4.1.2 due to using null alt on an image where the image is the only content in a link"
    - agree? / note: agree
14. [x] **before/news · SC 2.1.1 Keyboard**
    - open <http://127.0.0.1:4173/bad/before/news.html>; the W3C report it was read from is <http://127.0.0.1:4173/bad/before/reports/news.html>
    - test: Using only Tab, Shift+Tab, Enter, Space and arrow keys, try every link, menu and form control. Fail if any function needs the mouse.
    - recorded: `result=Fail techniques=F54,F55 mappings=9`; both readers quoted "Failure F54 - Failure of Success Criterion 2.1.1 due to using only pointing-device-specific event handlers (including gesture) for a function | Failure F55 - Failure of Success Criteria 2.1.1, 2.4.7, and 3.2.1 due to using script to remove focus when focus is received"
    - agree? / note: agree
15. [x] **before/news · SC 4.1.2 Name, Role, Value**
    - open <http://127.0.0.1:4173/bad/before/news.html>; the W3C report it was read from is <http://127.0.0.1:4173/bad/before/reports/news.html>
    - test: Inspect each control in DevTools → Elements → Accessibility. Fail if any lacks a name, the right role, or its state.
    - recorded: `result=Fail techniques=F68,F79,F89 mappings=5`; both readers quoted "Failure F68 - Failure of Success Criterion 1.3.1 and 4.1.2 due to the association of label and user interface controls not being programmatically determinable | Failure F79 - Failure of Success Criterion 4.1.2 due to the focus state of a user interface component not being programmatically determinable or no notification of change of focus state available | Failure F89 - Failure of 2.4.4, 2.4.9 and 4.1.2 due to using null alt on an image where the image is the only content in a link"
    - agree? / note: agree
16. [x] **before/tickets · SC 2.1.1 Keyboard**
    - open <http://127.0.0.1:4173/bad/before/tickets.html>; the W3C report it was read from is <http://127.0.0.1:4173/bad/before/reports/tickets.html>
    - test: Using only Tab, Shift+Tab, Enter, Space and arrow keys, try every link, menu and form control. Fail if any function needs the mouse.
    - recorded: `result=Fail techniques=F54,F55 mappings=9`; both readers quoted "Failure F54 - Failure of Success Criterion 2.1.1 due to using only pointing-device-specific event handlers (including gesture) for a function | Failure F55 - Failure of Success Criteria 2.1.1, 2.4.7, and 3.2.1 due to using script to remove focus when focus is received"
    - agree? / note: agree

## BAD element mappings (4 of 182; the 111 proposed by one reader only are drawn first)

17. [x] **before/home · SC 2.1.1 · `#page .story:nth-child(2) a > img` (reader A only)**
    - open <http://127.0.0.1:4173/bad/before/home.html>; in the console `document.querySelectorAll("#page .story:nth-child(2) a > img").length` should be 1 and it should be the recorded snippet `<img src="./img/morearrow.gif" width="48" height="10" alt="" border="0" onmouseover="this.src='./img/morearrow_a.gif'" onmouseout="this.src='./img/morearrow.gif'" style="vertical-align: bottom">`
    - test: Tab to it, or to the link or control that contains it, and press Enter (Space for buttons and checkboxes). Fail if anything the mouse does to it (click, hover) has no keyboard equivalent.
    - recorded: a failing instance of SC 2.1.1 on this page (page result Fail, techniques F54, F55)
    - agree? / note: agree
18. [x] **before/home · SC 3.2.1 · `#content .newsheadline:nth-child(2) > a` (reader B only)**
    - open <http://127.0.0.1:4173/bad/before/home.html>; in the console `document.querySelectorAll("#content .newsheadline:nth-child(2) > a").length` should be 1 and it should be the recorded snippet `<a href="news.html" onfocus="blur();">Man Gets Nine Months in Violin Case</a>`
    - test: Tab onto it without pressing Enter. Fail if the page navigates, a window opens, or focus is thrown away.
    - recorded: a failing instance of SC 3.2.1 on this page (page result Fail, techniques F55)
    - agree? / note: agree
19. [x] **before/home · SC 4.1.2 · `#page .story:nth-child(2) a` (reader A only)**
    - open <http://127.0.0.1:4173/bad/before/home.html>; in the console `document.querySelectorAll("#page .story:nth-child(2) a").length` should be 1 and it should be the recorded snippet `<a href="news.html" onfocus="blur();"><img src="./img/morearrow.gif" width="48" height="10" alt="" border="0" onmouseover="this.src='./img/morearrow_a.gif'" onmouseout="this.src='./img/morearrow.gif'"…`
    - test: Inspect it in DevTools → Elements → Accessibility. Fail if its name, role or state is missing or wrong.
    - recorded: a failing instance of SC 4.1.2 on this page (page result Fail, techniques F68, F79, F89)
    - agree? / note: agree
20. [x] **before/survey · SC 2.4.3 · `#page #ev` (reader A only)**
    - open <http://127.0.0.1:4173/bad/before/survey.html>; in the console `document.querySelectorAll("#page #ev").length` should be 1 and it should be the recorded snippet `<input type="text" name="ev" id="ev" size="20">`
    - test: Tab onto it from the control before it. Fail if it arrives out of logical sequence.
    - recorded: a failing instance of SC 2.4.3 on this page (page result Fail, techniques F85)
    - agree? / note: agree
