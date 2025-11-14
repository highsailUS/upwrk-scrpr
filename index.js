const express = require("express");
const cors = require("cors");

// --- Playwright Extra + Stealth ---
const { chromium: chromiumVanilla } = require("playwright");
const playwright = require("playwright-extra");
const stealth = require("playwright-extra-plugin-stealth")();

playwright.use(stealth);

const app = express();
app.use(cors());
app.use(express.json());

/**
 * Helper: safe text getter
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
 * Helper: safe HTML getter
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
 * SCRAPE FUNCTION
 * Uses stealth browser + stable launch config
 */
async function scrapeJob(jobIdRaw) {
  const cleanId = jobIdRaw.replace(/[^A-Za-z0-9]/g, "");
  const jobUrl = `https://www.upwork.com/jobs/~${cleanId}`;

  const browser = await playwright.chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();

  // Go to the job page safely
  await page.goto(jobUrl, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });

  // Wait for any meaningful content
  await page.waitForTimeout(1000);
  try {
    await page.waitForSelector("[data-test='job-description']", { timeout: 12000 });
  } catch {
    console.log("⚠️ Description not found in time, continuing anyway.");
  }

  const data = {};

  // TITLE
  data.job_title = await getText(page, "h1[data-test='job-header-title'], h1");

  // DESCRIPTION
  data.job_description = await getText(
    page,
    "[data-test='job-description'], section[data-test='job-description']"
  );

  data.job_description_html = await getHTML(
    page,
    "[data-test='job-description'], section[data-test='job-description']"
  );

  // CATEGORY / SUBCATEGORY
  data.category = await getText(
    page,
    "[data-test='job-features'] [data-test='job-category'], [data-test='breadcrumb'] a:nth-child(2)"
  );

  data.subcategory = await getText(
    page,
    "[data-test='job-features'] [data-test='job-subcategory'], [data-test='breadcrumb'] a:nth-child(3)"
  );

  // EXPERIENCE / LENGTH / BUDGET
  data.experience_level = await getText(page, "[data-test='experience-level']");
  data.project_length = await getText(page, "[data-test='project-length']");
  data.hourly_range = await getText(
    page,
    "[data-test='job-type-hourly'], [data-test='budget-hourly']"
  );
  data.fixed_budget = await getText(
    page,
    "[data-test='job-type-fixed'], [data-test='budget-fixed']"
  );

  // CLIENT DATA
  data.client_country = await getText(page, "[data-test='client-location']");
  data.client_rating = await getText(page, "[data-test='client-feedback']");
  data.client_total_spent = await getText(page, "[data-test='client-spend']");
  data.client_hires = await getText(page, "[data-test='client-hires']");
  data.client_payment_verified = await getText(
    page,
    "[data-test='payment-verification-status']"
  );

  // RAW HTML (but now it's NORMAL HTML, not encoded garbage)
  data.raw_job_html = await page.content();

  await browser.close();

  return {
    job_id: cleanId,
    job_url: jobUrl,
    ...data,
  };
}

/**
 * HEALTH CHECK
 */
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Upwork scraper running" });
});

/**
 * /scrape endpoint
 */
app.get("/scrape", async (req, res) => {
  try {
    let { jobId, url } = req.query;

    if (!jobId && url) {
      const match = url.match(/~([A-Za-z0-9]+)/);
      if (match) jobId = match[1];
    }

    if (!jobId) {
      return res.status(400).json({
        error: "Provide ?jobId=XXXX or ?url=https://www.upwork.com/jobs/~XXXX",
      });
    }

    const scraped = await scrapeJob(jobId);
    res.json(scraped);
  } catch (err) {
    console.error("SCRAPE ERROR:", err);
    res.status(500).json({ error: "Scrape failed", details: String(err) });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("✅ Upwork scraper listening on " + PORT);
});
