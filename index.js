const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
app.use(cors());
app.use(express.json());

/**
 * Returns random delay to mimic human behavior
 */
function humanDelay(min = 200, max = 700) {
  return min + Math.random() * (max - min);
}

/**
 * Anti-detection script injected before any page loads
 */
const stealthScript = `
  // Remove webdriver flag
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined
  });

  // Chrome plugins
  Object.defineProperty(navigator, 'plugins', {
    get: () => [1,2,3,4,5]
  });

  // Languages
  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en']
  });

  // Fix permissions query
  const originalQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (parameters) =>
    parameters.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : originalQuery(parameters);
`;

/**
 * Safe getter for text
 */
async function getText(page, selector) {
  try {
    const el = page.locator(selector);
    if ((await el.count()) === 0) return null;
    return (await el.first().innerText()).trim();
  } catch {
    return null;
  }
}

/**
 * Safe getter for HTML
 */
async function getHTML(page, selector) {
  try {
    const el = page.locator(selector);
    if ((await el.count()) === 0) return null;
    return (await el.first().innerHTML()).trim();
  } catch {
    return null;
  }
}

/**
 * Core scraper with anti-bot + retry logic
 */
async function scrapeJob(jobIdRaw) {
  const cleanId = jobIdRaw.replace(/[^A-Za-z0-9]/g, "");
  const jobUrl = `https://www.upwork.com/jobs/~${cleanId}`;

  const launchArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-infobars",
    "--no-first-run",
    "--window-size=1366,768",
  ];

  const browser = await chromium.launch({
    headless: false,               // ← Critical for anti-detection
    args: launchArgs,
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });

  // Fake cookies (reduces 403 massively)
  await context.addCookies([
    {
      name: "OptanonConsent",
      value: "isIABGlobal=false&datestamp=2025...",
      domain: ".upwork.com",
      path: "/",
    },
  ]);

  const page = await context.newPage();

  // Inject stealth code
  await page.addInitScript(stealthScript);

  // Human-like navigation headers
  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
    "Upgrade-Insecure-Requests": "1",
  });

  const attempts = [];

  for (let i = 1; i <= 3; i++) {
    const start = Date.now();
    try {
      console.log(`[SCRAPER] Attempt ${i} → ${jobUrl}`);

      await page.goto(jobUrl, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });

      // Wait for dynamic content
      try {
        await page.waitForSelector("[data-test='job-description']", {
          timeout: 20000,
        });
      } catch {}

      await page.waitForTimeout(humanDelay());

      // Extract fields
      const data = {
        jobId: cleanId,
        jobUrl,
        job_title: await getText(page, "h1[data-test='job-header-title'], h1"),
        job_description: await getText(
          page,
          "[data-test='job-description'], section[data-test='job-description']"
        ),
        job_description_html: await getHTML(
          page,
          "[data-test='job-description'], section[data-test='job-description']"
        ),
        category: await getText(
          page,
          "[data-test='job-category'], [data-test='breadcrumb'] a:nth-child(2)"
        ),
        subcategory: await getText(
          page,
          "[data-test='job-subcategory'], [data-test='breadcrumb'] a:nth-child(3)"
        ),
        experience_level: await getText(page, "[data-test='experience-level']"),
        project_length: await getText(page, "[data-test='project-length']"),
        hourly_range: await getText(
          page,
          "[data-test='job-type-hourly'], [data-test='budget-hourly']"
        ),
        fixed_budget: await getText(
          page,
          "[data-test='job-type-fixed'], [data-test='budget-fixed']"
        ),
        client_country: await getText(
          page,
          "[data-test='client-location']"
        ),
        client_rating: await getText(page, "[data-test='client-feedback']"),
        client_total_spent: await getText(page, "[data-test='client-spend']"),
        client_hires: await getText(page, "[data-test='client-hires']"),
        client_payment_verified: await getText(
          page,
          "[data-test='payment-verification-status']"
        ),
        raw_job_html: await page.content(),
      };

      await browser.close();
      return data;
    } catch (err) {
      const durationMs = Date.now() - start;
      attempts.push({
        attempt: i,
        jobId: cleanId,
        jobUrl,
        durationMs,
        error: String(err),
      });

      console.error(`[SCRAPER] Attempt ${i} failed →`, String(err));
      await page.waitForTimeout(2000 + Math.random() * 6000);
    }
  }

  await browser.close();

  throw {
    error: "navigation_error",
    message: "All attempts failed",
    job_id: cleanId,
    attempts,
  };
}

app.get("/", (req, res) => {
  res.json({ status: "up", message: "Upwork scraper OK" });
});

app.get("/scrape", async (req, res) => {
  try {
    let { jobId, url } = req.query;
    if (!jobId && url) {
      const match = url.match(/~([A-Za-z0-9]+)/);
      if (match) jobId = match[1];
    }

    if (!jobId)
      return res.status(400).json({
        error: "Provide ?jobId=... or ?url=https://www.upwork.com/jobs/~ID",
      });

    const data = await scrapeJob(jobId);
    res.json(data);
  } catch (err) {
    console.error("SCRAPE ERROR:", err);
    res.status(500).json(err);
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () =>
  console.log(`Upwork scraper listening on port ${PORT}`)
);
