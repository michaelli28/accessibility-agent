/**
 * Task Templates - Journey-based task templates for accessibility testing.
 *
 * All tasks are journeys that simulate real user behavior while covering
 * accessibility requirements. Each journey explores a page or flow comprehensively.
 *
 * Goal Structure:
 * - Each step is numbered (1. 2. 3.)
 * - Steps start with action verbs (Navigate to, Click, Type, Report)
 * - Final step reports success/failure with specific findings
 */

import { TaskStep, AccessibilityTask, ElementNode, PageElementGraph } from './types';

// ==================== Template Types ====================

export interface TaskTemplate {
  type: 'journey';
  name: string;
  description: string;
  wcagCriteria: string[];
  generateGoal: (context: TemplateContext) => string;
  generateSteps: (context: TemplateContext) => TaskStep[];
}

export interface TemplateContext {
  pageUrl: string;
  pageTitle: string;
  elements: ElementNode[];
  sectionName?: string;
  formName?: string;
  targetUrl?: string;
  searchQuery?: string;
  email?: string;
  password?: string;
  // Element summaries for comprehensive exploration
  headingCount?: number;
  landmarkCount?: number;
  linkCount?: number;
  buttonCount?: number;
  formFieldCount?: number;
  headingNames?: string;
  landmarkNames?: string;
}

// ==================== Journey Task Templates ====================

export const JOURNEY_TEMPLATES: Record<string, TaskTemplate> = {
  /**
   * Comprehensive page exploration - covers landmarks, headings, and interactive elements
   */
  explorePageStructure: {
    type: 'journey',
    name: 'Explore Page Structure',
    description: 'Explore the full page structure including landmarks, headings, and key interactive elements',
    wcagCriteria: ['1.3.1', '2.4.1', '2.4.6', '4.1.2'],
    generateGoal: (ctx) => {
      return [
        `1. Navigate to ${ctx.pageUrl}.`,
        `2. Navigate through all landmarks using D key (expected: ${ctx.landmarkNames || 'banner, navigation, main, contentinfo'}).`,
        `3. Return to top using Control+Home.`,
        `4. Navigate through all headings using H key to understand page structure${ctx.headingNames ? ` (expected: ${ctx.headingNames})` : ''}.`,
        `5. Navigate to main content area.`,
        `6. Explore interactive elements (links, buttons) in the main content using Tab.`,
        `7. Report success with: (a) landmarks found and any missing required ones (main, navigation), (b) heading hierarchy and any issues, (c) any interactive elements without accessible names.`,
      ].join(' ');
    },
    generateSteps: (ctx) => [
      { stepNumber: 1, action: 'navigate', target: ctx.pageUrl },
      { stepNumber: 2, action: 'traverse', key: 'd' },
      { stepNumber: 3, action: 'navigate', target: 'top', key: 'Control+Home' },
      { stepNumber: 4, action: 'traverse', key: 'h' },
      { stepNumber: 5, action: 'navigate', target: 'main', key: 'd' },
      { stepNumber: 6, action: 'traverse', key: 'Tab' },
      { stepNumber: 7, action: 'report', expectedOutcome: 'page structure analysis' },
    ],
  },

  /**
   * Explore navigation menu and verify all links work
   */
  exploreNavigation: {
    type: 'journey',
    name: 'Explore Navigation',
    description: 'Navigate through the main navigation menu and verify link destinations',
    wcagCriteria: ['2.4.4', '2.1.1', '2.4.7'],
    generateGoal: (ctx) => {
      return [
        `1. Navigate to ${ctx.pageUrl}.`,
        `2. Navigate to navigation landmark using D key.`,
        `3. Navigate through navigation links using Tab or K key.`,
        `4. Click the first navigation link and verify page loads.`,
        `5. Navigate back using browser back or navigation.`,
        `6. Click the second navigation link and verify page loads.`,
        `7. Continue testing at least 3-5 navigation links.`,
        `8. Report success with: (a) all navigation links found and their destinations, (b) any links with vague names like "click here" or "read more", (c) any broken links or navigation issues.`,
      ].join(' ');
    },
    generateSteps: (ctx) => [
      { stepNumber: 1, action: 'navigate', target: ctx.pageUrl },
      { stepNumber: 2, action: 'navigate', target: 'navigation', key: 'd' },
      { stepNumber: 3, action: 'traverse', key: 'Tab' },
      { stepNumber: 4, action: 'navigate_click', target: 'first nav link' },
      { stepNumber: 5, action: 'navigate_click', target: 'second nav link' },
      { stepNumber: 6, action: 'report', expectedOutcome: 'navigation analysis' },
    ],
  },

  /**
   * Form interaction journey
   */
  interactWithForm: {
    type: 'journey',
    name: 'Form Interaction',
    description: 'Find and interact with a form, testing all fields and submission',
    wcagCriteria: ['1.3.1', '4.1.2', '3.3.2', '2.1.1'],
    generateGoal: (ctx) => {
      return [
        `1. Navigate to ${ctx.pageUrl}.`,
        `2. Navigate to ${ctx.formName || 'the form'} using landmarks, headings, or Tab navigation.`,
        `3. Navigate through all form fields using Tab key.`,
        `4. For each text field, verify it has a label and type sample data ("Test" for text, "test@example.com" for email, "TestPassword123" for password).`,
        `5. For checkboxes/radio buttons, verify labels and toggle state.`,
        `6. Navigate to and click the Submit/Send button.`,
        `7. Report success with: (a) all form fields found and their labels, (b) any fields missing labels, (c) form submission result or validation errors, (d) any keyboard navigation issues.`,
      ].join(' ');
    },
    generateSteps: (ctx) => [
      { stepNumber: 1, action: 'navigate', target: ctx.pageUrl },
      { stepNumber: 2, action: 'navigate', target: ctx.formName || 'form' },
      { stepNumber: 3, action: 'traverse', key: 'Tab' },
      { stepNumber: 4, action: 'type', target: 'text fields', text: 'test data' },
      { stepNumber: 5, action: 'navigate_click', target: 'Submit button' },
      { stepNumber: 6, action: 'report', expectedOutcome: 'form interaction results' },
    ],
  },

  /**
   * Login flow
   */
  login: {
    type: 'journey',
    name: 'Login Flow',
    description: 'Complete a login flow using keyboard navigation',
    wcagCriteria: ['2.1.1', '4.1.2', '3.3.2'],
    generateGoal: (ctx) => {
      return [
        `1. Navigate to ${ctx.pageUrl}.`,
        `2. Navigate to and click Login/Sign In link.`,
        `3. Navigate to username/email field and type '${ctx.email || 'test@example.com'}'.`,
        `4. Navigate to password field and type '${ctx.password || 'TestPassword123'}'.`,
        `5. Navigate to and click Sign In/Login/Submit button.`,
        `6. Report success with: (a) whether login form was keyboard accessible, (b) whether fields had proper labels, (c) the result (authenticated page URL or error message).`,
      ].join(' ');
    },
    generateSteps: (ctx) => [
      { stepNumber: 1, action: 'navigate', target: ctx.pageUrl },
      { stepNumber: 2, action: 'navigate_click', target: 'Login link' },
      { stepNumber: 3, action: 'type', target: 'email field', text: ctx.email || 'test@example.com' },
      { stepNumber: 4, action: 'type', target: 'password field', text: ctx.password || 'TestPassword123' },
      { stepNumber: 5, action: 'navigate_click', target: 'Sign In button' },
      { stepNumber: 6, action: 'report', expectedOutcome: 'login result' },
    ],
  },

  /**
   * Search flow
   */
  search: {
    type: 'journey',
    name: 'Search Flow',
    description: 'Use search functionality and interact with results',
    wcagCriteria: ['2.1.1', '4.1.2', '1.3.1'],
    generateGoal: (ctx) => {
      return [
        `1. Navigate to ${ctx.pageUrl}.`,
        `2. Navigate to search input field (may be in header or navigation).`,
        `3. Type '${ctx.searchQuery || 'test'}'.`,
        `4. Submit search using Enter or by clicking Search button.`,
        `5. Navigate through search results using headings or Tab.`,
        `6. Click on the first search result.`,
        `7. Report success with: (a) whether search was keyboard accessible, (b) number of results found, (c) whether results were navigable, (d) destination of first result.`,
      ].join(' ');
    },
    generateSteps: (ctx) => [
      { stepNumber: 1, action: 'navigate', target: ctx.pageUrl },
      { stepNumber: 2, action: 'navigate', target: 'search input' },
      { stepNumber: 3, action: 'type', target: 'search input', text: ctx.searchQuery || 'test' },
      { stepNumber: 4, action: 'activate', target: 'search', key: 'Enter' },
      { stepNumber: 5, action: 'traverse', key: 'Tab' },
      { stepNumber: 6, action: 'navigate_click', target: 'first result' },
      { stepNumber: 7, action: 'report', expectedOutcome: 'search results analysis' },
    ],
  },

  /**
   * Contact form submission
   */
  contactForm: {
    type: 'journey',
    name: 'Contact Form',
    description: 'Find and submit a contact form',
    wcagCriteria: ['2.1.1', '4.1.2', '3.3.2'],
    generateGoal: (ctx) => {
      return [
        `1. Navigate to ${ctx.pageUrl}.`,
        `2. Navigate to and click Contact link (may be in navigation or footer).`,
        `3. Navigate to contact form.`,
        `4. Navigate to name field and type 'Test User'.`,
        `5. Navigate to email field and type 'test@example.com'.`,
        `6. Navigate to message/textarea field and type 'This is a test message for accessibility testing.'.`,
        `7. Navigate to and click Submit/Send button.`,
        `8. Report success with: (a) all form fields found, (b) any fields missing labels, (c) confirmation message or validation errors.`,
      ].join(' ');
    },
    generateSteps: (ctx) => [
      { stepNumber: 1, action: 'navigate', target: ctx.pageUrl },
      { stepNumber: 2, action: 'navigate_click', target: 'Contact link' },
      { stepNumber: 3, action: 'type', target: 'name field', text: 'Test User' },
      { stepNumber: 4, action: 'type', target: 'email field', text: 'test@example.com' },
      { stepNumber: 5, action: 'type', target: 'message field', text: 'This is a test message.' },
      { stepNumber: 6, action: 'navigate_click', target: 'Submit button' },
      { stepNumber: 7, action: 'report', expectedOutcome: 'form submission result' },
    ],
  },

  /**
   * Registration flow
   */
  registration: {
    type: 'journey',
    name: 'Registration Flow',
    description: 'Complete a user registration flow',
    wcagCriteria: ['2.1.1', '4.1.2', '3.3.2', '3.3.1'],
    generateGoal: (ctx) => {
      return [
        `1. Navigate to ${ctx.pageUrl}.`,
        `2. Navigate to and click Register/Sign Up/Create Account link.`,
        `3. Navigate through registration form fields using Tab.`,
        `4. Fill in name field with 'Test User'.`,
        `5. Fill in email field with 'test@example.com'.`,
        `6. Fill in password field with 'TestPassword123'.`,
        `7. Fill in confirm password if present with 'TestPassword123'.`,
        `8. Check any required checkboxes (terms, etc.) if present.`,
        `9. Navigate to and click Register/Submit button.`,
        `10. Report success with: (a) all fields found and their labels, (b) any validation errors, (c) registration result.`,
      ].join(' ');
    },
    generateSteps: (ctx) => [
      { stepNumber: 1, action: 'navigate', target: ctx.pageUrl },
      { stepNumber: 2, action: 'navigate_click', target: 'Register link' },
      { stepNumber: 3, action: 'traverse', key: 'Tab' },
      { stepNumber: 4, action: 'type', target: 'fields', text: 'test data' },
      { stepNumber: 5, action: 'navigate_click', target: 'Register button' },
      { stepNumber: 6, action: 'report', expectedOutcome: 'registration result' },
    ],
  },

  /**
   * E-commerce: Add to cart
   */
  addToCart: {
    type: 'journey',
    name: 'Add to Cart',
    description: 'Browse products and add one to cart',
    wcagCriteria: ['2.1.1', '4.1.2', '3.3.2'],
    generateGoal: (ctx) => {
      return [
        `1. Navigate to ${ctx.pageUrl}.`,
        `2. Navigate to Products/Shop/Store link in navigation and click.`,
        `3. Navigate through product listings using headings or Tab.`,
        `4. Click on a product to view details.`,
        `5. Navigate to and click Add to Cart button.`,
        `6. Navigate to Cart/Basket link and click.`,
        `7. Report success with: (a) whether products were keyboard navigable, (b) whether Add to Cart was accessible, (c) cart contents after adding.`,
      ].join(' ');
    },
    generateSteps: (ctx) => [
      { stepNumber: 1, action: 'navigate', target: ctx.pageUrl },
      { stepNumber: 2, action: 'navigate_click', target: 'Products link' },
      { stepNumber: 3, action: 'traverse', key: 'Tab' },
      { stepNumber: 4, action: 'navigate_click', target: 'product' },
      { stepNumber: 5, action: 'navigate_click', target: 'Add to Cart' },
      { stepNumber: 6, action: 'navigate_click', target: 'Cart' },
      { stepNumber: 7, action: 'report', expectedOutcome: 'cart contents' },
    ],
  },

  /**
   * E-commerce: Checkout flow
   */
  checkout: {
    type: 'journey',
    name: 'Checkout Flow',
    description: 'Complete a checkout flow from cart',
    wcagCriteria: ['2.1.1', '4.1.2', '3.3.2', '3.3.1'],
    generateGoal: (ctx) => {
      return [
        `1. Navigate to ${ctx.pageUrl}.`,
        `2. Navigate to Cart link and click.`,
        `3. Navigate to and click Checkout/Proceed button.`,
        `4. Navigate through shipping/billing form fields using Tab.`,
        `5. Fill in required fields (name: 'Test User', address: '123 Test St', city: 'Test City', zip: '12345').`,
        `6. Navigate to and click Continue/Next/Place Order button.`,
        `7. Report success with: (a) checkout form accessibility, (b) any fields missing labels, (c) any validation errors, (d) order result or how far you got.`,
      ].join(' ');
    },
    generateSteps: (ctx) => [
      { stepNumber: 1, action: 'navigate', target: ctx.pageUrl },
      { stepNumber: 2, action: 'navigate_click', target: 'Cart' },
      { stepNumber: 3, action: 'navigate_click', target: 'Checkout' },
      { stepNumber: 4, action: 'traverse', key: 'Tab' },
      { stepNumber: 5, action: 'type', target: 'form fields', text: 'test data' },
      { stepNumber: 6, action: 'navigate_click', target: 'Place Order' },
      { stepNumber: 7, action: 'report', expectedOutcome: 'checkout result' },
    ],
  },

  /**
   * Explore a specific content page (article, blog post, etc.)
   */
  exploreContentPage: {
    type: 'journey',
    name: 'Explore Content Page',
    description: 'Navigate through a content page reading experience',
    wcagCriteria: ['1.3.1', '2.4.6', '2.4.4', '2.1.1'],
    generateGoal: (ctx) => {
      return [
        `1. Navigate to ${ctx.pageUrl}.`,
        `2. Navigate through page headings using H key to understand content structure.`,
        `3. Navigate to main content landmark using D key.`,
        `4. Read through content using Arrow Down key.`,
        `5. Navigate through any links in the content using K key.`,
        `6. Check for any images and verify they have alt text descriptions announced.`,
        `7. Navigate to related content or footer.`,
        `8. Report success with: (a) heading structure (levels and hierarchy), (b) any links with vague names, (c) any images without alt text, (d) overall keyboard navigability.`,
      ].join(' ');
    },
    generateSteps: (ctx) => [
      { stepNumber: 1, action: 'navigate', target: ctx.pageUrl },
      { stepNumber: 2, action: 'traverse', key: 'h' },
      { stepNumber: 3, action: 'navigate', target: 'main', key: 'd' },
      { stepNumber: 4, action: 'traverse', key: 'ArrowDown' },
      { stepNumber: 5, action: 'traverse', key: 'k' },
      { stepNumber: 6, action: 'report', expectedOutcome: 'content accessibility analysis' },
    ],
  },

  /**
   * Footer exploration
   */
  exploreFooter: {
    type: 'journey',
    name: 'Explore Footer',
    description: 'Navigate and explore footer content and links',
    wcagCriteria: ['2.4.1', '2.4.4', '2.1.1'],
    generateGoal: (ctx) => {
      return [
        `1. Navigate to ${ctx.pageUrl}.`,
        `2. Navigate to contentinfo/footer landmark using D key.`,
        `3. Navigate through footer links using Tab or K key.`,
        `4. Identify footer sections (About, Contact, Legal, Social, etc.).`,
        `5. Click on at least 2-3 footer links to verify they work.`,
        `6. Report success with: (a) footer landmark presence, (b) footer links found and their organization, (c) any links with accessibility issues.`,
      ].join(' ');
    },
    generateSteps: (ctx) => [
      { stepNumber: 1, action: 'navigate', target: ctx.pageUrl },
      { stepNumber: 2, action: 'navigate', target: 'contentinfo', key: 'd' },
      { stepNumber: 3, action: 'traverse', key: 'Tab' },
      { stepNumber: 4, action: 'navigate_click', target: 'footer link' },
      { stepNumber: 5, action: 'report', expectedOutcome: 'footer accessibility analysis' },
    ],
  },

  /**
   * Navigate between pages
   */
  navigateBetweenPages: {
    type: 'journey',
    name: 'Navigate Between Pages',
    description: 'Navigate from homepage to multiple internal pages',
    wcagCriteria: ['2.1.1', '2.4.4', '2.4.7'],
    generateGoal: (ctx) => {
      return [
        `1. Navigate to ${ctx.pageUrl}.`,
        `2. Navigate to main navigation using D key.`,
        `3. Click on ${ctx.targetUrl ? `"${ctx.targetUrl}"` : 'the first navigation link'}.`,
        `4. Verify new page loads and has proper structure (main landmark, headings).`,
        `5. Navigate back using browser back or navigation link.`,
        `6. Click on a different navigation link.`,
        `7. Verify that page has proper landmark structure.`,
        `8. Report success with: (a) pages visited, (b) whether each page had proper landmarks and headings, (c) any navigation issues encountered.`,
      ].join(' ');
    },
    generateSteps: (ctx) => [
      { stepNumber: 1, action: 'navigate', target: ctx.pageUrl },
      { stepNumber: 2, action: 'navigate', target: 'navigation', key: 'd' },
      { stepNumber: 3, action: 'navigate_click', target: ctx.targetUrl || 'first nav link' },
      { stepNumber: 4, action: 'navigate', target: 'main', key: 'd' },
      { stepNumber: 5, action: 'report', expectedOutcome: 'multi-page navigation analysis' },
    ],
  },

  /**
   * Interactive components (tabs, accordions, modals)
   */
  testInteractiveComponents: {
    type: 'journey',
    name: 'Test Interactive Components',
    description: 'Find and test interactive components like tabs, accordions, modals',
    wcagCriteria: ['2.1.1', '4.1.2', '2.4.3'],
    generateGoal: (ctx) => {
      return [
        `1. Navigate to ${ctx.pageUrl}.`,
        `2. Navigate through page using Tab to find interactive components (tabs, accordions, dropdowns, modals).`,
        `3. For any tabs found: navigate between tabs using Arrow keys, verify content changes.`,
        `4. For any accordions found: activate with Enter/Space, verify content expands.`,
        `5. For any buttons that open modals: activate and verify modal opens, try to close with Escape.`,
        `6. For any dropdowns: open with Enter/Space, navigate options with Arrow keys.`,
        `7. Report success with: (a) interactive components found, (b) whether each was keyboard operable, (c) any focus management issues, (d) any components that trapped focus.`,
      ].join(' ');
    },
    generateSteps: (ctx) => [
      { stepNumber: 1, action: 'navigate', target: ctx.pageUrl },
      { stepNumber: 2, action: 'traverse', key: 'Tab' },
      { stepNumber: 3, action: 'activate', target: 'interactive component', key: 'Enter' },
      { stepNumber: 4, action: 'traverse', key: 'ArrowDown' },
      { stepNumber: 5, action: 'report', expectedOutcome: 'interactive components analysis' },
    ],
  },

  /**
   * Media content (videos, audio)
   */
  testMediaContent: {
    type: 'journey',
    name: 'Test Media Content',
    description: 'Find and test media players and content',
    wcagCriteria: ['1.2.1', '1.2.2', '2.1.1'],
    generateGoal: (ctx) => {
      return [
        `1. Navigate to ${ctx.pageUrl}.`,
        `2. Navigate through page to find video or audio players.`,
        `3. Navigate to video/audio player controls using Tab.`,
        `4. Test play/pause using Space or Enter.`,
        `5. Test volume controls if present.`,
        `6. Look for captions/subtitles controls.`,
        `7. Report success with: (a) media players found, (b) whether controls were keyboard accessible, (c) whether captions were available, (d) any accessibility issues with media.`,
      ].join(' ');
    },
    generateSteps: (ctx) => [
      { stepNumber: 1, action: 'navigate', target: ctx.pageUrl },
      { stepNumber: 2, action: 'traverse', key: 'Tab' },
      { stepNumber: 3, action: 'activate', target: 'play button', key: 'Space' },
      { stepNumber: 4, action: 'report', expectedOutcome: 'media accessibility analysis' },
    ],
  },
};

// ==================== Template Helpers ====================

/**
 * Generate a unique task ID.
 */
export function generateTaskId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Build a task from a template and context.
 */
export function buildTaskFromTemplate(
  template: TaskTemplate,
  context: TemplateContext,
  targetElements: string[] = [],
  priority: number = 5
): AccessibilityTask {
  return {
    id: generateTaskId(),
    type: template.type,
    url: context.pageUrl,
    goal: template.generateGoal(context),
    steps: template.generateSteps(context),
    targetElements,
    requiredActions: [],
    expectedCoverage: targetElements.length,
    wcagCriteria: template.wcagCriteria,
    elementTypes: [],
    priority,
    dependencies: [],
    attempts: 0,
  };
}

/**
 * Get all available journey templates.
 */
export function getJourneyTemplates(): TaskTemplate[] {
  return Object.values(JOURNEY_TEMPLATES);
}
