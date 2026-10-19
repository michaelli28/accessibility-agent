import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { BrowserClient, BrowserPage } from "@at-agent/browser"
import { ScreenReaderSimulator } from "./screen-reader.js"

// example.com dropped its <h1> in 2026-10 and asks not to be used for testing; tests that need
// the heading load this fixed copy of the old page instead.
const EXAMPLE_DOMAIN =
  "<title>Example Domain</title><h1>Example Domain</h1>" +
  "<p>This domain is for use in illustrative examples in documents.</p>" +
  '<a href="https://www.iana.org/domains/example">Learn more</a>'

describe("ScreenReaderSimulator", () => {
  let client: BrowserClient
  let page: BrowserPage
  let simulator: ScreenReaderSimulator

  beforeAll(async () => {
    client = new BrowserClient()
    await client.launch()
  })

  afterAll(async () => {
    await client.close()
  })

  describe("readPage", () => {
    it("returns page content in reading order", async () => {
      page = await client.newPage()
      await page.playwrightPage.setContent(EXAMPLE_DOMAIN)
      simulator = new ScreenReaderSimulator(page)

      const content = await simulator.readPage()

      expect(content.length).toBeGreaterThan(0)
      // Should include the heading
      expect(content.some(item => item.role === "heading")).toBe(true)
      await page.close()
    })
  })

  describe("getHeadings", () => {
    it("returns all headings with levels", async () => {
      page = await client.newPage()
      await page.playwrightPage.setContent(EXAMPLE_DOMAIN)
      simulator = new ScreenReaderSimulator(page)

      const headings = await simulator.getHeadings()

      expect(headings.length).toBeGreaterThan(0)
      expect(headings[0].level).toBeDefined()
      expect(headings[0].text).toContain("Example")
      await page.close()
    })
  })

  describe("heading level", () => {
    // F8. Both level paths used to return a hardcoded 1, so a real document outline read as a flat
    // run of h1s: page.ts parsed the snapshot's `heading "x" [level=N]` but threw the level away.
    it("carries the real level through from the snapshot", async () => {
      page = await client.newPage()
      await page.playwrightPage.setContent(
        "<h1>One</h1><h2>Two</h2><h3>Three</h3>"
      )
      simulator = new ScreenReaderSimulator(page)

      const headings = await simulator.getHeadings()

      expect(headings.map(h => h.level)).toEqual([1, 2, 3])
      expect(headings.map(h => h.text)).toEqual(["One", "Two", "Three"])
      await page.close()
    })
  })

  describe("getLandmarks", () => {
    it("returns page landmarks", async () => {
      page = await client.newPage()
      await page.goto("https://example.com")
      simulator = new ScreenReaderSimulator(page)

      const landmarks = await simulator.getLandmarks()

      // Even simple pages have implicit landmarks
      expect(Array.isArray(landmarks)).toBe(true)
      await page.close()
    })
  })
})
