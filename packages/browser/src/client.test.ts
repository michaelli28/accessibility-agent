import { describe, it, expect, afterEach } from 'vitest'
import { BrowserClient } from './client.js'
import { BrowserPage } from './page.js'

describe('BrowserClient', () => {
  let client: BrowserClient | null = null

  afterEach(async () => {
    if (client) {
      await client.close()
      client = null
    }
  })

  describe('launch', () => {
    it('launches browser successfully', async () => {
      client = new BrowserClient()
      await client.launch()
      expect(client.isLaunched()).toBe(true)
    })

    it('launches with custom options', async () => {
      client = new BrowserClient({ headless: true })
      await client.launch()
      expect(client.isLaunched()).toBe(true)
    })

    it('throws if launched twice', async () => {
      client = new BrowserClient()
      await client.launch()
      await expect(client.launch()).rejects.toThrow('Browser already launched')
    })
  })

  describe('close', () => {
    it('closes browser successfully', async () => {
      client = new BrowserClient()
      await client.launch()
      await client.close()
      expect(client.isLaunched()).toBe(false)
      client = null // prevent afterEach from double-closing
    })

    it('is safe to call close when not launched', async () => {
      client = new BrowserClient()
      await expect(client.close()).resolves.not.toThrow()
    })
  })

  describe('newPage', () => {
    it('creates a new page', async () => {
      client = new BrowserClient()
      await client.launch()
      const page = await client.newPage()
      expect(page).toBeInstanceOf(BrowserPage)
    })

    it('throws if browser not launched', async () => {
      client = new BrowserClient()
      await expect(client.newPage()).rejects.toThrow('Browser not launched')
    })
  })
})
