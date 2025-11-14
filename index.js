import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { chromium } from "playwright";

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ---------------------------------------------------------
// HEALTH CHECK
// ---------------------------------------------------------
app.get("/", (req, res) => {
  res.send("Upwork scraper online");
});

// ---------------------------------------------------------
// CORE SCRAPER
// ---------------------------------------------------------
async function scrapeJob(jobIdRaw) {
  const cleanId = jobIdRaw.replace(/[^A-Za-z0-9]/g, "");
  const jobUrl = `https://www.upwork.com/jobs/~${cleanId}`;

  console.log(`[SCRAPER] Starting scrape: ${jobUrl}`);

  // Browser (Railway-safe, headless)
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled"
    ]
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 768 },

    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",

    locale: "en-US",
    timezoneId: "America/New_York",
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
      "sec-ch-ua":
        '"Chromium";v="123", "Not:A-Brand";v="8", "Google Chrome";v="123"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"'
    }
  });

  const page = await context.newPage();

  try {
    await page.goto(jobUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45000
    });

    // Soft wait lets dynamic content stabilize
    await page.waitForTimeout(1200);

    const content = await page.content();
    if (content.includes("Access Denied") || content.includes("captcha")) {
      throw new Error("Forbidden (Upwork blocked the request)");
    }

    // Extractors
    const title = await page.locator("h1.up-line-clamp-v2").textContent().catch(() => null);
    const posted = await page.locator("span[data-test='posted-on']").textContent().catch(() => null);
    const description = await page.locator("section[data-test='job-description']").textContent().catch(() => null);

    const hourlyRate = await page.locator("strong[data-test='job-budget']").textContent().catch(() => null);
    const experience = await page.locator("span[data-test='experience-level']").textContent().catch(() => null);
    const location = await page.locator("div[data-test='client-location']").textContent().catch(() => null);

    await browser.close();

    return {
      success: true,
      job_id: cleanId,
      title: title?.trim() || null,
      posted: posted?.trim() || null,
      description: description?.trim() || null,
      hourlyRate: hourlyRate?.trim() || null,
      experience: experience?.trim() || null,
      location: location?.trim() || null
    };

  } catch (err) {
    await browser.close();
    throw err;
  }
}

// ---------------------------------------------------------
// GET /scrape?jobId=XXXX  (debugging-friendly)
// ---------------------------------------------------------
app.get("/scrape", async (req, res) => {
  const { jobId } = req.query;

  if (!jobId) {
    return res.status(400).json({ error: "Missing ?jobId=" });
  }

  console.log(`[API] GET scrape request for: ${jobId}`);

  try {
    const data = await scrapeJob(jobId);
    res.json(data);
  } catch (err) {
    console.error("[SCRAPER] GET error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------
// POST /scrape  (production mode)
// ---------------------------------------------------------
app.post("/scrape", async (req, res) => {
  const { jobId } = req.body;

  if (!jobId) return res.status(400).json({ error: "Missing jobId" });

  console.log(`[API] POST scrape request for: ${jobId}`);

  let attempt = 0;
  const maxAttempts = 3;

  while (attempt < maxAttempts) {
    attempt++;

    try {
      const data = await scrapeJob(jobId);
      return res.json(data);

    } catch (err) {
      console.error(`[SCRAPER] Attempt ${attempt} failed:`, err.message);

      if (attempt === maxAttempts) {
        return res.status(500).json({
          error: err.message,
          jobId,
          attempts: attempt
        });
      }

      // Exponential backoff
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
});

// ---------------------------------------------------------
// START SERVER
// ---------------------------------------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Upwork scraper listening on port ${PORT}`);
});
