import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const outputDir = new URL("../.artifacts/screenshots/", import.meta.url);
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ executablePath: chromePath });
const cases = [
  { name: "desktop-dark", width: 1440, height: 960, colorScheme: "dark" },
  { name: "desktop-light", width: 1440, height: 960, colorScheme: "light" },
  { name: "mobile-dark", width: 390, height: 844, colorScheme: "dark", isMobile: true },
  { name: "mobile-light", width: 390, height: 844, colorScheme: "light", isMobile: true },
];

for (const item of cases) {
  const page = await browser.newPage({
    viewport: { width: item.width, height: item.height },
    colorScheme: item.colorScheme,
    isMobile: Boolean(item.isMobile),
  });
  await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
  if (item.colorScheme === "light") {
    await page.getByRole("button", { name: "Light" }).click();
  }
  await page.screenshot({ path: new URL(`${item.name}.png`, outputDir).pathname, fullPage: true });
  await page.close();
}

await browser.close();
console.log(`Saved screenshots to ${outputDir.pathname}`);
