// Core types and interfaces
export * from './IAccessibilityDriver';
export * from './driverTypes';
export * from './types';

// Main driver
export { ScreenReaderDriver, ScreenReaderDriverOptions, TimingOptions } from './ScreenReaderDriver';

// Browser client
export { BrowserClient } from './playwrightClient';

// AX tree components (for advanced usage)
export { AXTreeNavigator } from './AXTreeNavigator';
export { AXAnnouncementGenerator, AnnouncementOptions } from './AXAnnouncementGenerator';
export { AXTreeCache, AXTreeCacheOptions } from './AXTreeCache';
