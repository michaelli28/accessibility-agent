# at-agent Rebuild Design

## Context

The current at-agent codebase has accumulated bugs across architecture, code quality, test coverage, and dependency management. Rather than patch individual issues, we're doing an incremental rebuild with strict TDD practices.

## Goals

The rebuilt system must support:
- Automated accessibility auditing (WCAG violation scanning)
- AI-guided user flow testing (agent navigates and finds barriers)
- Screen reader simulation (test assistive technology experience)
- CI/CD integration (GitHub Actions, Azure DevOps, Jenkins, GitLab)

## Tech Stack

**Keeping:**
- TypeScript (strict mode)
- Playwright (browser automation)
- Zod (validation)

**Changing:**
- Drop LangChain/LangGraph in favor of direct OpenAI SDK
- Simpler, more debuggable AI orchestration

## Architecture

Layered architecture with dependencies flowing downward only:

```
┌─────────────────────────────────────────────────┐
│              Integrations Layer                 │
│    (GitHub Actions, Azure DevOps, Jenkins)      │
└─────────────────────────────────────────────────┘
                        │
┌─────────────────────────────────────────────────┐
│              Application Layer                  │
│         (CLI, API Server, Dashboard)            │
└─────────────────────────────────────────────────┘
                        │
┌─────────────────────────────────────────────────┐
│                Agent Layer                      │
│   (AI orchestration, decision making, tools)    │
└─────────────────────────────────────────────────┘
                        │
┌─────────────────────────────────────────────────┐
│              Accessibility Layer                │
│  (Auditors, screen reader sim, WCAG rules)      │
└─────────────────────────────────────────────────┘
                        │
┌─────────────────────────────────────────────────┐
│               Browser Layer                     │
│    (Playwright wrapper, page interactions)      │
└─────────────────────────────────────────────────┘
```

Each layer is a separate package with its own tests. No layer knows about layers above it.

## Layer Designs

### Browser Layer

**Location:** `packages/browser/`

**Structure:**
```
packages/browser/
├── src/
│   ├── client.ts          # Main BrowserClient class
│   ├── page.ts            # Page wrapper with a11y-focused methods
│   ├── elements.ts        # Element interaction utilities
│   ├── screenshots.ts     # Screenshot capture
│   ├── types.ts           # Shared types
│   └── index.ts           # Public exports
└── tests/
```

**Public API:**
```typescript
interface BrowserClient {
  launch(): Promise<void>
  close(): Promise<void>
  newPage(url: string): Promise<Page>
}

interface Page {
  goto(url: string): Promise<void>
  getByRole(role: string, options?: { name?: string }): Promise<Element[]>
  getByText(text: string): Promise<Element[]>
  screenshot(): Promise<Buffer>
  accessibilityTree(): Promise<AccessibilityNode>
  close(): Promise<void>
}
```

**Scope:** Pure browser automation. No AI, no accessibility rules, no reporting.

### Accessibility Layer

**Location:** `packages/accessibility/`

**Structure:**
```
packages/accessibility/
├── src/
│   ├── auditor.ts         # Main auditor that coordinates scans
│   ├── rules/             # WCAG rule implementations
│   │   ├── index.ts
│   │   ├── perceivable.ts    # 1.x rules
│   │   ├── operable.ts       # 2.x rules
│   │   ├── understandable.ts # 3.x rules
│   │   └── robust.ts         # 4.x rules
│   ├── screen-reader.ts   # Screen reader simulation
│   ├── axe-integration.ts # Axe-core wrapper
│   ├── types.ts
│   └── index.ts
└── tests/
```

**Public API:**
```typescript
interface Auditor {
  audit(page: Page): Promise<AuditResult>
  auditWithScreenReader(page: Page): Promise<ScreenReaderResult>
}

interface AuditResult {
  violations: Violation[]
  passes: Rule[]
  incomplete: Rule[]
}

interface Violation {
  rule: string
  impact: 'critical' | 'serious' | 'moderate' | 'minor'
  nodes: ViolationNode[]
  help: string
  wcag: string[]
}
```

**Scope:** Scanning, rule evaluation, screen reader simulation. No AI, no navigation logic.

### Agent Layer

**Location:** `packages/agent/`

**Structure:**
```
packages/agent/
├── src/
│   ├── agent.ts           # Main agent orchestrator
│   ├── planner.ts         # Breaks goals into steps
│   ├── executor.ts        # Executes individual actions
│   ├── tools/             # Actions the agent can take
│   │   ├── index.ts
│   │   ├── navigate.ts
│   │   ├── interact.ts
│   │   ├── audit.ts
│   │   └── observe.ts
│   ├── prompts/
│   │   ├── system.ts
│   │   └── templates.ts
│   ├── openai.ts          # OpenAI SDK wrapper
│   ├── types.ts
│   └── index.ts
└── tests/
```

**Public API:**
```typescript
interface Agent {
  run(goal: string, options?: AgentOptions): Promise<AgentResult>
  stop(): void
}

interface AgentOptions {
  maxSteps?: number
  startUrl: string
  onStep?: (step: Step) => void
}

interface AgentResult {
  success: boolean
  steps: Step[]
  violations: Violation[]
  summary: string
}
```

**Key decisions:**
- Tools are pure functions (easy to test)
- Agent state is immutable
- OpenAI calls isolated in one file (easy to mock)

### Application Layer

**Location:** `packages/cli/`, `packages/api/`, `packages/dashboard/`

**CLI structure:**
```
packages/cli/
├── src/
│   ├── cli.ts             # Entry point
│   ├── commands/
│   │   ├── audit.ts
│   │   ├── flow.ts
│   │   └── report.ts
│   └── output.ts
└── tests/
```

**CLI usage:**
```bash
at-agent audit https://example.com
at-agent flow https://shop.example.com --goal "complete checkout"
at-agent report ./results.json --output report.html
```

**API endpoints:**
```
POST /audit     { url, options }     → AuditResult
POST /flow      { url, goal }        → AgentResult
GET  /health                         → { status: "ok" }
```

**Dashboard:** Minimal viewer for JSON results. No accounts, no persistence.

### Integrations Layer

**Location:** `integrations/`

**Structure:**
```
integrations/
├── github-action/
├── azure-devops/
├── gitlab-ci/
└── jenkins/
```

**Principle:** Each integration is a thin wrapper around the CLI. No business logic.

**GitHub Action example:**
```yaml
- uses: your-org/accessibility-agent@v1
  with:
    url: https://example.com
    goal: "test login flow"
    fail-on: critical
```

## Rebuild Roadmap

### Phase 1: Browser Layer
- Build `packages/browser` with TDD
- Test against real sites
- Deliverable: Standalone browser automation

### Phase 2: Accessibility Layer
- Build `packages/accessibility`
- Integrate axe-core, custom rules, screen reader sim
- Deliverable: Working audit tool

### Phase 3: Agent Layer
- Build `packages/agent`
- Linear execution first, then planning
- Deliverable: AI-guided flow testing

### Phase 4: Application Layer
- CLI first, API second, dashboard last
- Deliverable: Full local tooling

### Phase 5: Integrations
- GitHub Action first, others as needed
- Deliverable: CI/CD ready

## Transition Strategy

- New packages live alongside old code
- Swap one capability at a time
- Delete old code only after new code is proven
- Keep old system runnable until Phase 4 complete

## Quality Standards

- TDD strict: Every line of production code written in response to a failing test
- TypeScript strict mode
- No `any` types
- Immutable data patterns
- Each layer independently testable
