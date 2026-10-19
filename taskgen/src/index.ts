/**
 * Task Generation Module - Automatic accessibility task generation.
 *
 * This module provides tools to automatically generate accessibility testing tasks
 * that cover all HTML elements across a website for WCAG 2.1 AA compliance.
 */

// Types
export * from './types';

// Core modules
export { ElementCrawler } from './element-crawler';
export { CoverageAlgorithm } from './coverage';
export { TaskGenerator } from './task-generator';
export { CoverageTracker, AgentTrace, AgentStep, PerceptualSnapshot } from './coverage-tracker';

// Gap detection modules
export { DOMCrawler } from './dom-crawler';
export { GapDetector } from './gap-detector';
export { GapTaskGenerator } from './gap-task-generator';

// Templates
export {
  JOURNEY_TEMPLATES,
  buildTaskFromTemplate,
  generateTaskId,
  getJourneyTemplates,
} from './templates';

// Orchestrator
export {
  TaskGenerationOrchestrator,
  generateTasksForUrl,
  loadGraphFromFile,
  generateTasksFromGraph,
} from './orchestrator';
