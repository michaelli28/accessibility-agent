import type { Page } from 'playwright'

export const RENDERER_CRASHED = "the page's renderer crashed"

// Playwright marks only its own session crashed; a CDP session a check opens is never answered again, and a call in
// flight at the crash never settles, so the page's crash event fails the work instead. A page that crashed before
// this call is not seen.
export async function failOnCrash<T>(page: Page, work: () => Promise<T>): Promise<T> {
  let onCrash = (): void => undefined
  const crashed = new Promise<never>((_, reject) => {
    onCrash = () => reject(new Error(RENDERER_CRASHED))
  })
  page.once('crash', onCrash)
  const running = work()
  // Abandoned on a crash, the work may still settle later, some calls only once the caller closes the page; a
  // rejection then must not surface as unhandled.
  running.catch(() => undefined)
  try {
    return await Promise.race([running, crashed])
  } finally {
    page.off('crash', onCrash)
  }
}
