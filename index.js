const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------
// HEALTH CHECK
// ---------------------------------------------------------
app.get("/", (req, res) => {
  res.send("Upwork scraper online (local)");
});

// ---------------------------------------------------------
// CORE SCRAPER
// ---------------------------------------------------------
function normalizeJobUrl(input) {
  if (!input || typeof input !== "string") {
    throw new Error("Missing URL or jobId");
  }

  // If they passed a full URL, just return it
  if (input.startsWith("http://") || input.startsWith("https://")) {
    return input;
  }

  // Otherwise assume it's a jobId (like 0aBcd123EfGhijkLm)
  const cleanId = input.replace(/[^A-Za-z0-9]/g, "");
  if (!cleanId) throw new Error("Invalid jobId");
  return `https://www.upwork.com/jobs/~${cleanId}`;
}

async function scrapeJobPage(rawUrlOrId) {
  const jobUrl = normalizeJobUrl(rawUrlOrId);

  console.log(`[SCRAPER] Starting scrape: ${jobUrl}`);

  let browser;
  let context;
  let page;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage"
      ]
    });

    context = await browser.newContext({
      viewport: { width: 1280, height: 768 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      locale: "en-US",
      timezoneId: "America/New_York"
    });

    page = await context.newPage();

    await page.goto(jobUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45000
    });

    // Give dynamic content a moment
    await page.waitForTimeout(1200);

    const html = await page.content();

    // Very basic block detection
    const lower = html.toLowerCase();
    if (lower.includes("access denied") || lower.includes("captcha")) {
      const err = new Error("Blocked or forbidden by upstream site");
      err.code = "FORBIDDEN";
      throw err;
    }

    // Helper to get text safely
    const getText = async (selector) => {
      try {
        const el = await page.$(selector);
        if (!el) return null;
        const text = await el.textContent();
        return text ? text.trim() : null;
      } catch {
        return null;
      }
    };

    // Upwork job page selectors
    const title = await getText("h1.up-line-clamp-v2");
    const posted = await getText("span[data-test='posted-on']");
    const description = await getText("section[data-test='job-description']");
    const hourlyRate = await getText("strong[data-test='job-budget']");
    const experience = await getText("span[data-test='experience-level']");
    const location = await getText("div[data-test='client-location']");

    // Extract jobId from URL if present
    const jobIdMatch = jobUrl.match(/jobs\/~([A-Za-z0-9]+)/);
    const jobId = jobIdMatch ? jobIdMatch[1] : null;

    return {
      success: true,
      url: jobUrl,
      jobId,
      title,
      posted,
      description,
      hourlyRate,
      experience,
      location
    };

  } catch (err) {
    console.error("[SCRAPER] Error during scrape:", err.message);
    const error = new Error(err.message || "Unknown error during scrape");
    error.code = err.code || "SCRAPE_FAILED";
    throw error;

  } finally {
    try {
      if (page) await page.close();
    } catch (_) {}
    try {
      if (context) await context.close();
    } catch (_) {}
    try {
      if (browser) await browser.close();
    } catch (_) {}
  }
}

// ---------------------------------------------------------
// GET /scrape?url=... or ?jobId=...  (debugging)
// ---------------------------------------------------------
app.get("/scrape", async (req, res) => {
  const { url, jobId } = req.query;
  const input = url || jobId;

  if (!input) {
    return res.status(400).json({ error: "Missing ?url= or ?jobId=" });
  }

  console.log(`[API] GET /scrape input=${input}`);

  try {
    const data = await scrapeJobPage(input);
    return res.json(data);
  } catch (err) {
    const status =
      err.code === "FORBIDDEN" ? 403 :
      500;

    return res.status(status).json({
      success: false,
      error: err.message,
      code: err.code || "SCRAPE_FAILED"
    });
  }
});

// ---------------------------------------------------------
// POST /scrape  { url } or { jobId }
// ---------------------------------------------------------
app.post("/scrape", async (req, res) => {
  const { url, jobId } = req.body || {};
  const input = url || jobId;

  if (!input) {
    return res.status(400).json({ error: "Missing 'url' or 'jobId' in body" });
  }

  console.log(`[API] POST /scrape input=${input}`);

  const maxAttempts = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`[SCRAPER] Attempt ${attempt}/${maxAttempts} for ${input}`);

    try {
      const data = await scrapeJobPage(input);
      return res.json(data);
    } catch (err) {
      lastError = err;
      console.error(
        `[SCRAPER] Attempt ${attempt} failed: ${err.message} (code=${err.code || "SCRAPE_FAILED"})`
      );

      if (err.code === "FORBIDDEN") {
        break;
      }

      if (attempt < maxAttempts) {
        const delay = attempt * 2000;
        console.log(`[SCRAPER] Backing off for ${delay}ms before next attempt`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  const status =
    lastError?.code === "FORBIDDEN" ? 403 :
    500;

  return res.status(status).json({
    success: false,
    error: lastError?.message || "Failed to scrape after retries",
    code: lastError?.code || "SCRAPE_FAILED",
    input
  });
});

// ---------------------------------------------------------
// START SERVER
// ---------------------------------------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Upwork scraper listening on port ${PORT} (local mode)`);
});
