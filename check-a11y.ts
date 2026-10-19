import { chromium } from 'playwright';

async function checkAccessibility() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://order.mealkeyway.com/customer/release/index?mid=75452b6a42425a6b4f31646a6e4633415168496f75673d3d#/main', {
    waitUntil: 'networkidle'
  });
  
  await page.waitForTimeout(3000);
  
  // Close the modal if present
  try {
    await page.click('.ui_popup_close_btn', { timeout: 2000 });
    await page.waitForTimeout(500);
  } catch (e) {}
  
  // Get all focusable elements
  const focusableElements = await page.evaluate(() => {
    const focusable = document.querySelectorAll(
      'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    return Array.from(focusable).map(el => ({
      tag: el.tagName,
      text: el.textContent?.trim().slice(0, 50),
      tabindex: el.getAttribute('tabindex'),
      role: el.getAttribute('role'),
      className: (el.className?.toString() || '').slice(0, 80)
    }));
  });
  
  console.log('\n=== FOCUSABLE ELEMENTS (can Tab to) ===');
  console.log(`Total: ${focusableElements.length}`);
  focusableElements.slice(0, 20).forEach((el, i) => {
    console.log(`${i+1}. <${el.tag}> "${el.text?.slice(0,30)}" role=${el.role}`);
  });
  
  // Check for elements with cursor:pointer that aren't keyboard accessible
  const clickableNotFocusable = await page.evaluate(() => {
    const allElements = document.querySelectorAll('div, span');
    const results: any[] = [];
    
    for (const el of allElements) {
      const style = window.getComputedStyle(el);
      const hasPointerCursor = style.cursor === 'pointer';
      const isFocusable = el.matches('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
      
      if (hasPointerCursor && !isFocusable) {
        const text = el.textContent?.trim().slice(0, 40);
        if (text && text.length > 2 && !el.closest('[tabindex], button, a')) {
          results.push({
            tag: el.tagName,
            className: (el.className?.toString() || '').slice(0, 60),
            text
          });
        }
      }
    }
    // Dedupe by text
    const seen = new Set();
    return results.filter(r => {
      if (seen.has(r.text)) return false;
      seen.add(r.text);
      return true;
    }).slice(0, 30);
  });
  
  console.log('\n=== CLICKABLE (cursor:pointer) BUT NOT KEYBOARD ACCESSIBLE ===');
  console.log(`Found: ${clickableNotFocusable.length} elements`);
  clickableNotFocusable.forEach((el, i) => {
    console.log(`${i+1}. <${el.tag}> "${el.text}"`);
    console.log(`   class: ${el.className}`);
  });
  
  // Try tabbing through the page and see where focus goes
  console.log('\n=== TAB ORDER TEST ===');
  await page.keyboard.press('Tab');
  for (let i = 0; i < 10; i++) {
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      return {
        tag: el?.tagName,
        text: el?.textContent?.trim().slice(0, 30),
        className: (el?.className?.toString() || '').slice(0, 50)
      };
    });
    console.log(`Tab ${i+1}: <${focused.tag}> "${focused.text}"`);
    await page.keyboard.press('Tab');
  }
  
  await browser.close();
}

checkAccessibility().catch(console.error);
