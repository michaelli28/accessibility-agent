import type { BrowserPage } from '@at-agent/browser'
import {
  Auditor,
  ScreenReaderSimulator,
  runTabWalk,
  judgeKeyboardTrap,
  judgeContextChange,
  type TabKey,
  type KeyboardTrapResult,
  type ContextChangeResult,
  type TabWalkResult,
} from '@at-agent/accessibility'
import {
  type Action,
  type ActionResult,
  type TabPress,
  ExecuteActionOptionsSchema,
  type ExecuteActionOptions,
} from './types.js'

export async function executeAction(
  action: Action,
  page: BrowserPage,
  options: Partial<ExecuteActionOptions> = {},
): Promise<ActionResult> {
  const opts = ExecuteActionOptionsSchema.parse(options)
  switch (action.type) {
    case 'navigate':
      return executeNavigate(action, page)
    case 'click':
      return executeClick(action, page, opts)
    case 'fill':
      return executeFill(action, page, opts)
    case 'audit':
      return executeAudit(page)
    case 'observe':
      return executeObserve(page)
    case 'tab':
      return executeTab(action, page)
    case 'checkKeyboard':
      return executeCheckKeyboard(page)
    case 'done':
      return executeDone(action)
    default:
      return {
        success: false,
        observation: `Unknown action type: ${(action as Action).type}`,
      }
  }
}

async function executeNavigate(action: Action, page: BrowserPage): Promise<ActionResult> {
  try {
    if (!action.target) {
      return { success: false, observation: 'No URL provided' }
    }
    await page.goto(action.target)
    const title = await page.title()
    return {
      success: true,
      observation: `Navigated to ${action.target}. Page title: "${title}"`,
    }
  } catch (error) {
    return {
      success: false,
      observation: `Navigation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}

const DEFAULT_CLICK_TIMEOUT = 5000

async function executeClick(action: Action, page: BrowserPage, opts: ExecuteActionOptions): Promise<ActionResult> {
  try {
    if (!action.target) {
      return { success: false, observation: 'No target provided' }
    }

    // Parse target like "button named Submit" or "link named More information"
    const match = action.target.match(/(\w+)\s+named\s+"([^"]+)"/i)
    if (match) {
      const [, role, name] = match
      if (opts.headed) {
        await page.highlight(role, { name }, 'CLICK', 500)
      }
      await page.clickByRole(role, { name, timeout: DEFAULT_CLICK_TIMEOUT })
      return {
        success: true,
        observation: `Clicked ${role} named "${name}"`,
      }
    }

    // Try clicking by text
    await page.clickByText(action.target)
    return {
      success: true,
      observation: `Clicked element with text "${action.target}"`,
    }
  } catch (error) {
    return {
      success: false,
      observation: `Click failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}

async function executeFill(action: Action, page: BrowserPage, opts: ExecuteActionOptions): Promise<ActionResult> {
  try {
    if (!action.target || !action.value) {
      return { success: false, observation: 'No target or value provided' }
    }

    // Parse target like "textbox named Email"
    const match = action.target.match(/(\w+)\s+named\s+"([^"]+)"/i)
    if (match) {
      const [, role, name] = match
      if (opts.headed) {
        await page.highlight(role, { name }, 'FILL', 500)
      }
      await page.fillByRole(role, action.value, { name })
      return {
        success: true,
        observation: `Filled ${role} named "${name}" with "${action.value}"`,
      }
    }

    return {
      success: false,
      observation: `Could not parse target: ${action.target}`,
    }
  } catch (error) {
    return {
      success: false,
      observation: `Fill failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}

async function executeAudit(page: BrowserPage): Promise<ActionResult> {
  try {
    const auditor = new Auditor()
    const result = await auditor.audit(page)
    const summary = auditor.getSummary(result)

    const observation = [
      `Accessibility audit complete:`,
      `- ${summary.totalViolations} violations found`,
      `- Critical: ${summary.byImpact.critical}`,
      `- Serious: ${summary.byImpact.serious}`,
      `- Moderate: ${summary.byImpact.moderate}`,
      `- Minor: ${summary.byImpact.minor}`,
      `- ${summary.totalPasses} rules passed`,
    ].join('\n')

    return {
      success: true,
      observation,
      violations: result.violations,
    }
  } catch (error) {
    return {
      success: false,
      observation: `Audit failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}

async function executeObserve(page: BrowserPage): Promise<ActionResult> {
  try {
    const url = await page.url()
    const title = await page.title()
    const tree = await page.accessibilityTree()

    // Summarize accessibility tree
    const simulator = new ScreenReaderSimulator(page)
    const headings = await simulator.getHeadings()
    const landmarks = await simulator.getLandmarks()

    const observation = [
      `Current page: ${url}`,
      `Title: "${title}"`,
      `Headings: ${headings.map((h) => `"${h.text}"`).join(', ') || 'None'}`,
      `Landmarks: ${landmarks.map((l) => l.role).join(', ') || 'None'}`,
      `Accessibility tree root: ${tree.role} "${tree.name}"`,
    ].join('\n')

    return {
      success: true,
      observation,
    }
  } catch (error) {
    return {
      success: false,
      observation: `Observe failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}

function executeDone(action: Action): ActionResult {
  return {
    success: true,
    observation: `Agent finished: ${action.reason}`,
  }
}

async function executeTab(action: Action, page: BrowserPage): Promise<ActionResult> {
  const raw = action.value?.trim() || '1'
  const count = /^\d+$/.test(raw) ? Number(raw) : 0
  if (count < 1) {
    return {
      success: false,
      observation: `Tab failed: the press count must be a whole number of at least 1, in digits; got "${action.value}"`,
    }
  }
  const key: TabKey = action.target === 'previous' ? 'Shift+Tab' : 'Tab'

  // One read per PRESS, not one after the run: reading only at the end reports an N-press run as
  // a single element, which the pre-fix detector scored as a one-element cycle.
  const presses: TabPress[] = []
  try {
    for (let i = 0; i < count; i++) {
      await page.playwrightPage.keyboard.press(key)

      // WHY the expression below must not change: bench/legacy.test.ts toolsIdentityExpression()
      // regex-extracts the first playwrightPage.evaluate<string> template literal out of this file and
      // checks in Chromium that bench/legacy.ts rebuilds the frozen BEFORE column's focus strings
      // exactly as it does. Keep it a plain template, no interpolation.
      const element = await page.playwrightPage.evaluate<string>(`
      (() => {
        const el = document.activeElement;
        if (!el || el === document.body) {
          return 'body';
        }

        const tag = el.tagName.toLowerCase();
        const id = el.id ? '#' + el.id : '';
        const className = el.className && typeof el.className === 'string'
          ? '.' + el.className.split(' ').filter(Boolean).join('.')
          : '';
        const name = el.getAttribute('aria-label')
          || el.name
          || (el.textContent || '').slice(0, 30).trim()
          || '';

        return tag + id + className + (name ? ' "' + name + '"' : '');
      })()
    `)

      presses.push({ index: i + 1, key, element, timestamp: Date.now() })
    }

    const elements = presses.map((p) => p.element)
    const observation =
      presses.length === 1 ? `Focused on: ${elements[0]}` : `Tab \u00d7${presses.length}: ${elements.join(' \u2192 ')}`

    return { success: true, observation, presses }
  } catch (error) {
    // The presses read before the failure happened; the run's tabPresses keeps them.
    return {
      success: false,
      observation: `Tab failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      presses,
    }
  }
}

// WCAG 2.1.2 and 3.2.1, answered by driving the page rather than replaying a list of strings.
// runTabWalk takes a raw Playwright Page, so page.playwrightPage is the whole seam.
async function executeCheckKeyboard(page: BrowserPage): Promise<ActionResult> {
  try {
    const walk = await runTabWalk(page.playwrightPage)
    const keyboard = judgeKeyboardTrap([walk])
    const contextChange = judgeContextChange(walk)
    return {
      success: true,
      observation: describeKeyboardCheck({ walk, keyboard, contextChange }),
      keyboard,
      contextChange,
    }
  } catch (error) {
    return {
      success: false,
      observation: `Keyboard check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}

function describeKeyboardCheck({
  walk,
  keyboard,
  contextChange,
}: {
  walk: TabWalkResult
  keyboard: KeyboardTrapResult
  contextChange: ContextChangeResult
}): string {
  const trapDetail =
    keyboard.reason !== null
      ? ` (undetermined: ${keyboard.reason})`
      : keyboard.keyboardTrap
        ? ` (focus is confined; escapable: ${keyboard.trapEscapable === true ? 'yes' : 'no'})`
        : ''
  const contextDetail =
    contextChange.reason !== null
      ? ` (undetermined: ${contextChange.reason})`
      : contextChange.findings.length > 0
        ? ` (${contextChange.findings.length} finding(s))`
        : ''

  return [
    `Keyboard check complete. ${describeKeysPressed(walk)}: do not assume the page is`,
    'still in the state it was in before this check.',
    `- Keyboard trap (WCAG 2.1.2): ${keyboard.verdict}${trapDetail}`,
    `- Change of context on focus (WCAG 3.2.1): ${contextChange.verdict}${contextDetail}`,
  ].join('\n')
}

// Read from the walk, not assumed: its escape probe (Escape, then the opposite key) runs only when
// the end of the walk did not wrap, so on most pages the walk key is the only key pressed.
function describeKeysPressed(walk: TabWalkResult): string {
  const walkKey = walk.direction === 'forward' ? 'Tab' : 'Shift+Tab'
  const probeKey = walk.direction === 'forward' ? 'Shift+Tab' : 'Tab'
  const walked = `It walked focus through the whole page with ${walkKey}`
  const dismissed = 'so a dialog may have been dismissed and focus has moved'
  if (walk.escapeProbe !== null) return `${walked}, then pressed Escape and ${probeKey}, ${dismissed}`
  if (walk.error?.phase === 'escapeProbe') {
    return `${walked}, then may have pressed Escape and ${probeKey} before the check failed, ${dismissed}`
  }
  return `${walked} and did not press Escape or ${probeKey}, so focus has moved`
}
