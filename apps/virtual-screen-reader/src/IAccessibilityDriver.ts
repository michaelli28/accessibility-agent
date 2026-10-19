import { Page } from 'playwright';
import { UserAction, ActionResult, PerceptualSnapshot } from './driverTypes';

export interface IAccessibilityDriver {
    name: string;

    /**
     * Enables the driver (e.g., starts the screen reader simulation).
     */
    enable(): Promise<void>;

    /**
     * Disables the driver.
     */
    disable(): Promise<void>;

    /**
     * Performs a user action (e.g., pressing a key) and returns the result.
     */
    performAction(action: UserAction): Promise<ActionResult>;

    /**
     * Gets the current perceptual output (what the user "sees" or "hears").
     */
    getPerceptualOutput(): Promise<PerceptualSnapshot>;

    /**
     * Navigate to a specific URL.
     */
    navigateTo(url: string): Promise<void>;

    /**
     * Get the underlying Playwright Page object for browser-based operations.
     */
    getPage(): Page | null;
}
