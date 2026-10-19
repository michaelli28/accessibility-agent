import { describe, it, expect } from 'vitest'
import type { FocusRead, TabWalkResult, TabWalkStep } from '../tab-walk.js'
import { groupReach, keyboardEvidence } from './keyboard.js'
import type { FocusFacts } from './types.js'

const fact = (f: Partial<FocusFacts> = {}): FocusFacts => ({
  disabled: false,
  focusable: false,
  radioGroup: null,
  compositeWidget: null,
  keydownHandler: false,
  activeDescendantHost: null,
  ...f,
})

describe('groupReach (G1b: arrow keys reach the rest of a group Tab entered)', () => {
  it('records each unfocused radio of a group whose other member Tab focused, with its rule', () => {
    const facts = new Map([
      [1, fact({ radioGroup: 'f:size' })],
      [2, fact({ radioGroup: 'f:size' })],
      [3, fact({ radioGroup: 'f:size' })],
      [4, fact({ radioGroup: 'f:color' })],
    ])
    expect(groupReach([1], facts)).toEqual([
      { backendNodeId: 2, rule: 'radio-group' },
      { backendNodeId: 3, rule: 'radio-group' },
    ])
  })

  it('records members of the composite widget Tab entered, not those of another widget', () => {
    const facts = new Map([
      [10, fact({ compositeWidget: 100 })],
      [11, fact({ compositeWidget: 100 })],
      [12, fact({ compositeWidget: 200 })],
      [100, fact({ keydownHandler: true })],
    ])
    expect(groupReach([10], facts)).toEqual([
      { backendNodeId: 11, rule: 'composite-widget' },
      { backendNodeId: 100, rule: 'widget-container' },
    ])
    // G1c review: tabbing to the container itself enters the widget — arrow keys reach its members from there.
    expect(groupReach([100], facts)).toEqual([
      { backendNodeId: 10, rule: 'composite-widget' },
      { backendNodeId: 11, rule: 'composite-widget' },
    ])
  })

  it('enters a widget whose container is the Tab stop (menubar with tabindex=0)', () => {
    const facts = new Map([
      [9, fact({ focusable: true, keydownHandler: true })],
      [14, fact({ compositeWidget: 9 })],
      [16, fact({ compositeWidget: 9 })],
    ])
    expect(groupReach([9], facts)).toEqual([
      { backendNodeId: 14, rule: 'composite-widget' },
      { backendNodeId: 16, rule: 'composite-widget' },
    ])
  })

  it('prefers the radio-group rule when a radio is also a composite member, and skips disabled members', () => {
    const facts = new Map([
      [
        20,
        fact({
          radioGroup: 'd:plan',
          compositeWidget: 300,
          keydownHandler: true,
        }),
      ],
      [21, fact({ radioGroup: 'd:plan', compositeWidget: 300 })],
      [22, fact({ radioGroup: 'd:plan', compositeWidget: 300, disabled: true })],
      [23, fact({ compositeWidget: 300 })],
    ])
    expect(groupReach([20], facts)).toEqual([
      { backendNodeId: 21, rule: 'radio-group' },
      { backendNodeId: 23, rule: 'composite-widget' },
    ])
  })

  it('records nothing without a walk or without facts for the reached element', () => {
    const facts = new Map([[30, fact({ radioGroup: 'f:x' })]])
    expect(groupReach([], facts)).toEqual([])
    expect(groupReach([99], facts)).toEqual([])
  })
})

describe('groupReach (G1c: composite widgets)', () => {
  it('N2: reaches the other members only with arrow-key evidence, a keydown on the container or on a member', () => {
    const members = (extra: Partial<FocusFacts>) =>
      new Map([
        [40, fact({ compositeWidget: 400, focusable: true })],
        [41, fact({ compositeWidget: 400, ...extra })],
      ])
    // A toolbar with no key handling: its tabindex=-1 button stays unreachable.
    expect(groupReach([40], members({}))).toEqual([])
    expect(groupReach([40], members({ keydownHandler: true }))).toEqual([
      { backendNodeId: 41, rule: 'composite-widget' },
    ])
    const container = new Map([...members({}), [400, fact({ keydownHandler: true })]])
    expect(groupReach([40], container)).toEqual([
      { backendNodeId: 41, rule: 'composite-widget' },
      { backendNodeId: 400, rule: 'widget-container' },
    ])
  })

  it('N1: counts the container reached when a member was reached or focus was inside it, nested widgets included', () => {
    const facts = new Map([
      // A menubar (500) holding a menu (510) whose item 51 Tab focused; 52 sits in the menubar outside the menu.
      [500, fact()],
      [510, fact({ compositeWidget: 500 })],
      [51, fact({ compositeWidget: 510 })],
      [52, fact({ compositeWidget: 500 })],
      // A grid (600) Tab never entered.
      [600, fact({ keydownHandler: true })],
      [61, fact({ compositeWidget: 600 })],
    ])
    expect(groupReach([51], facts)).toEqual([
      { backendNodeId: 500, rule: 'widget-container' },
      { backendNodeId: 510, rule: 'widget-container' },
    ])
  })

  it('N3: reaches the options of a widget managed by aria-activedescendant when its manager was reached', () => {
    const facts = new Map([
      // A focusable listbox carrying aria-activedescendant: it manages its own options.
      [700, fact({ focusable: true })],
      [71, fact({ compositeWidget: 700, activeDescendantHost: 700 })],
      [72, fact({ compositeWidget: 700, activeDescendantHost: 700 })],
      // A combobox (80) referencing listbox 800: the listbox itself is reached through its options.
      [80, fact({ focusable: true })],
      [800, fact()],
      [81, fact({ compositeWidget: 800, activeDescendantHost: 80 })],
      [
        82,
        fact({
          compositeWidget: 800,
          activeDescendantHost: 80,
          disabled: true,
        }),
      ],
    ])
    expect(groupReach([700, 80], facts)).toEqual([
      { backendNodeId: 71, rule: 'active-descendant' },
      { backendNodeId: 72, rule: 'active-descendant' },
      { backendNodeId: 81, rule: 'active-descendant' },
      { backendNodeId: 800, rule: 'widget-container' },
    ])
    expect(groupReach([], facts)).toEqual([])
  })
})

// acc-gaps#1: a walk is evidence about the crawled document only if it kept one document from its first read on.
describe('keyboardEvidence (one document from the idle baseline to the last press)', () => {
  const URL_ = 'http://walk.test/page.html'
  const read = (backendNodeId: number, tag: string, isBody = false): FocusRead => ({
    backendNodeId,
    tag,
    id: null,
    className: null,
    ariaLabel: null,
    nameAttr: null,
    nameProp: null,
    text: null,
    isBody,
    hasFocus: !isBody,
    url: URL_,
    container: null,
    deep: { backendNodeId, tag, id: null, isBody, classAttr: null },
    deepUnavailable: null,
    part: null,
  })
  const step = (index: number, settled: FocusRead, over: Partial<TabWalkStep> = {}): TabWalkStep => ({
    index,
    key: 'Tab',
    immediate: settled,
    settled,
    focusStyle: null,
    documentReplaced: false,
    wrapped: false,
    focusLost: false,
    indicator: null,
    ...over,
  })
  // Two links, then focus falls off the end: a clean wrap.
  const walk = (idle: TabWalkResult['idle'], over: Partial<TabWalkStep> = {}): TabWalkResult => ({
    direction: 'forward',
    focusableCount: 2,
    fIncomplete: false,
    fIncompleteCauses: { crossOriginFrames: 0, closedShadowRoots: 0 },
    defaultPresses: 3,
    presses: 3,
    settleMs: 150,
    launchFacts: { browserVersion: null, executableBasename: null },
    initial: read(9, 'body', true),
    idle,
    focusableCountEnd: 2,
    steps: [
      step(1, read(900, 'a'), over),
      step(2, read(901, 'a')),
      step(3, read(899, 'body', true), { wrapped: true }),
    ],
    suspectedTrap: false,
    escapeProbe: null,
    error: null,
  })
  const idle = (documentReplaced: boolean): TabWalkResult['idle'] => ({
    after: read(9, 'body', true),
    documentReplaced,
    urlChanged: false,
  })

  it('refuses a walk whose idle baseline saw the document replaced, however cleanly it then wrapped', () => {
    expect(keyboardEvidence(walk(idle(true)))).toMatchObject({
      walkRan: true,
      notFocusableAssessed: false,
      unassessedReasons: ['document-replaced'],
    })
  })

  it('lists document-replaced once when the idle baseline and a press both saw a replacement', () => {
    expect(keyboardEvidence(walk(idle(true), { documentReplaced: true })).unassessedReasons).toEqual([
      'document-replaced',
    ])
  })

  it('assesses a clean wrap with no idle record, or with an idle baseline that kept the document', () => {
    for (const w of [walk(null), walk(idle(false))]) {
      expect(keyboardEvidence(w)).toMatchObject({ notFocusableAssessed: true, unassessedReasons: [] })
    }
  })
})
