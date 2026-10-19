import { chromium, Browser } from 'playwright'
import { BrowserOptionsSchema, type BrowserOptions } from './types.js'
import { BrowserPage } from './page.js'

export class BrowserClient {
  private browser: Browser | null = null
  private readonly options: BrowserOptions

  constructor(options: Partial<BrowserOptions> = {}) {
    this.options = BrowserOptionsSchema.parse(options)
  }

  async launch(): Promise<void> {
    if (this.browser) {
      throw new Error('Browser already launched')
    }
    this.browser = await chromium.launch({
      headless: this.options.headless,
      slowMo: this.options.slowMo,
    })
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close()
      this.browser = null
    }
  }

  isLaunched(): boolean {
    return this.browser !== null
  }

  async newPage(): Promise<BrowserPage> {
    if (!this.browser) {
      throw new Error('Browser not launched')
    }
    const page = await this.browser.newPage()
    return new BrowserPage(page)
  }
}
