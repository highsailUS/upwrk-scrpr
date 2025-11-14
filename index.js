const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

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
    const txt = await el.first().innerText();
    return txt.trim();
  } catch (e) {
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
    const html = await el.first().innerHTML();
    return html.trim();
  } catch (e) {
    return null;
  }
}

/**
 * Core scraper – loads the Upwork job page and extracts fields.
 */
async function scrapeJob(url) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });

  // Reasonable UA so we look like a normal browser
  await page.setExtraHTTPHeaders({
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  });

  await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });

  // Give it a moment to render dynamic bits
  await page.waitForTimeout(1500);

  const data = {};

  // TITLE & DESCRIPTION
  data.job_title = await getText(page, "h1[data-test='job-header-title'], h1");
  data.job_description = await getText(
    page,
    "[data-test='job-description'], section[data-test='job-description']"
  );
  data.job_description_html = await getHTML(
    page,
    "[data-test='job-description'], section[data-test='job-description']"
  );

  // CATEGORY / SUBCATEGORY (breadcrumbs style)
  data.category = await getText(
    page,
    "[data-test='job-features'] [data-test='job-category'], [data-test='breadcrumb'] a:nth-child(2)"
  );
  data.subcategory = await getText(
    page,
    "[data-test='job-features'] [data-test='job-subcategory'], [data-test='breadcrumb'] a:nth-child(3)"
  );

  // BUDGET / TYPE / DURATION / EXPERIENCE
  data.experience_level = await getText(page, "[data-test='experience-level']");
  data.project_length = await getText(page, "[data-test='project-length']");
  data.hourly_range = await getText(page, "[data-test='job-type-hourly'], [data-test='budget-hourly']");
  data.fixed_budget = await getText(page, "[data-test='job-type-fixed'], [data-test='budget-fixed']");

  // CLIENT INFO BLOCK
  data.client_country = await getText(page, "[data-test='client-location']");
  data.client_rating = await getText(page, "[data-test='client-feedback']");
  data.client_total_spent = await getText(page, "[data-test='client-spend']");
  data.client_hires = await getText(page, "[data-test='client-hires']");
  data.client_payment_verified = await getText(
    page,
    "[data-test='payment-verification-status']"
  );

  // RAW HTML (optional, nice for debugging / backup)
  data.raw_job_html = await page.content();

  await browser.close();
  return data;
}

/**
 * Health check
 */
app.get("/", (req, res) => {
  res.json({ status: "up", message: "Upwork scraper is running" });
});

/**
 * /scrape endpoint
 * Accepts:
 *   - ?jobId=XXXXXXXX
 *   - OR ?url=https://www.upwork.com/jobs/~XXXXXXXX
 */
app.get("/scrape", async (req, res) => {
  try {
    const { jobId, url } = req.query;

    let finalJobId = jobId || null;

    if (!finalJobId && url) {
      const match = url.match(/~([A-Za-z0-9]+)/);
      if (match) finalJobId = match[1];
    }

    if (!finalJobId) {
      return res
        .status(400)
        .json({ error: "Provide ?jobId=... or ?url=https://www.upwork.com/jobs/~ID" });
    }

    const jobUrl = `https://www.upwork.com/jobs/~${finalJobId}`;

    const scraped = await scrapeJob(jobUrl);

    res.json({
      job_id: finalJobId,
      job_url: jobUrl,
      ...scraped,
    });
  } catch (err) {
    console.error("SCRAPE ERROR:", err);
    res.status(500).json({ error: "Scrape failed", details: String(err) });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Upwork scraper listening on port ${PORT}`);
});
