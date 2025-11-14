import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { chromium } from "playwright";

const app = express();
app.use(cors());
app.use(bodyParser.json());

app.get("/", (req, res) => {
  res.send("Upwork scraper online");
});

async function scrapeJob(jobIdRaw) {
  const cleanId = jobIdRaw.replace(/[^A-Za-z0-9]/g, "");
  const jobUrl = `https://www.upwork.com/jobs/~${cleanId}`;

  console.log(`[SCRAPER] Starting scrape: ${jobUrl}`);

  // ---------- FIXED: always headless, safe for Railway ----------
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage"
    ]
  });

  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 }
  });

  // ---------- Upwork-friendly user agent ----------
  await page.setExtraHTTPHeaders({
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
  });

  try {
    await page.goto(jobUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45000
    });

    // Give the DOM a moment
    await page.waitForTimeout(1200);

    // Detect forbidden
    const bodyHTML = await page.content();
    if (bodyHTML.includes("Access Denied") || bodyHTML.includes("captcha")) {
      throw new Error("forbidden");
    }

    // Extract fields
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

// ---------- API ROUTE ----------
app.post("/scrape", async (req, res) => {
  const { jobId } = req.body;

  if (!jobId) return res.status(400).json({ error: "Missing jobId" });

  console.log(`[API] Scrape request for: ${jobId}`);

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

      await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
});

// ---------- START SERVER ----------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Upwork scraper listening on port ${PORT}`);
});
