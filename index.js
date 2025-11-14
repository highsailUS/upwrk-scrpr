const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
app.use(cors());
app.use(express.json());

/**
 * --------- CONFIG (TUNE FOR SCALE) ---------
 */
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || "3", 10);
const NAV_TIMEOUT_MS = parseInt(process.env.NAV_TIMEOUT_MS || "45000", 10);
const MIN_DELAY_MS = parseInt(process.env.SCRAPER_MIN_DELAY_MS || "500", 10);
const MAX_DELAY_MS = parseInt(process.env.SCRAPER_MAX_DELAY_MS || "2500", 10);

// Optional proxy rotation: PROXY_LIST="http://user:pass@ip1:port,http://user:pass@ip2:port"
const proxyList = (process.env.PROXY_LIST || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * --------- SMALL HELPERS ---------
 */
function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Mild UA rotation – enough to not look like a bot farm
const USER_AGENTS = [
  // Chrome Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  // Edge desktop
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
];

function pickUserAgent() {
  const i = randInt(0, USER_AGENTS.length - 1);
  return USER_AGENTS[i];
}

let proxyIndex = 0;
function pickProxy() {
  if (!proxyList.length) return null;
  const proxy = proxyList[proxyIndex % proxyList.length];
  proxyIndex += 1;
  return proxy;
}

/**
 * Helper: safe text getter
 */
async function getText(page, selector) {
  try {
    const el = page.locator(selector);
    if ((await el.count()) === 0) return null;
    const txt = await el.first().innerText();
    return txt.trim();
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
    const html = await el.first().innerHTML();
    return html.trim();
  } catch {
    return null;
  }
}

/**
 * Detects common "blocked" / "login" / "error" scenarios from HTML.
 */
function classifyPageContent(html, url, statusCode) {
  const lower = (html || "").toLowerCase();

  if (!html) {
    return "empty_response";
  }

  if (url.includes("/ab/account-security/login")) {
    return "login_required";
  }

  if (lower.includes("please verify you are a human") ||
      lower.includes("unusual activity") ||
      lower.includes("support id")) {
    return "bot_challenge";
  }

  if (statusCode === 403 || lower.includes("access denied")) {
    return "forbidden";
  }

  if (statusCode === 429 || lower.includes("too many requests")) {
    return "rate_limited";
  }

  if (statusCode >= 500 || lower.includes("something went wrong")) {
    return "server_error";
  }

  return "ok";
}

/**
 * Launch a fresh browser with optional proxy & "stealth-ish" config.
 */
async function launchBrowserWithStrategy() {
  const proxy = pickProxy();
  const launchOptions = {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--disable-web-security",
    ],
  };

  if (proxy) {
    launchOptions.proxy = { server: proxy };
    console.log("[SCRAPER] Using proxy:", proxy);
  }

  const browser = await chromium.launch(launchOptions);
  return browser;
}

/**
 * Core single-attempt scraper (no retries).
 * Returns { success, data?, errorType?, message?, statusCode?, attemptMeta }
 */
async function scrapeJobOnce(jobIdRaw, attempt) {
  const cleanId = jobIdRaw.replace(/[^A-Za-z0-9]/g, "");
  const jobUrl = `https://www.upwork.com/jobs/~${cleanId}`;
  const startTime = Date.now();

  let browser;
  let context;
  let page;
  let statusCode = null;

  try {
    // Small random delay before each attempt – looks more "human"
    const preDelay = randInt(MIN_DELAY_MS, MAX_DELAY_MS);
    await sleep(preDelay);

    browser = await launchBrowserWithStrategy();

    const userAgent = pickUserAgent();
    const viewport = {
      width: randInt(1200, 1600),
      height: randInt(700, 950),
    };

    context = await browser.newContext({
      userAgent,
      viewport,
      locale: "en-US",
      timezoneId: "America/New_York",
    });

    await context.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
    });

    page = await context.newPage();

    const response = await page.goto(jobUrl, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });

    if (response) {
      statusCode = response.status();
    }

    // Best-effort additional stabilizing waits
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(randInt(800, 2000));

    // Try to ensure job description exists (but don't hard-fail if not)
    await page.waitForSelector("[data-test='job-description']", {
      timeout: 15000,
    }).catch(() => {});

    const html = await page.content();
    const currentUrl = page.url();
    const classification = classifyPageContent(html, currentUrl, statusCode);

    if (classification !== "ok") {
      // We consider this a "soft fail" that can be retried at a higher level
      return {
        success: false,
        errorType: classification,
        message: `Non-OK page classification: ${classification}`,
        statusCode,
        attemptMeta: {
          attempt,
          jobId: cleanId,
          jobUrl,
          currentUrl,
          durationMs: Date.now() - startTime,
        },
      };
    }

    // --------- ACTUAL DATA SCRAPE ---------
    const data = {};

    // Title & description
    data.job_title = await getText(
      page,
      "h1[data-test='job-header-title'], h1"
    );

    data.job_description = await getText(
      page,
      "[data-test='job-description'], section[data-test='job-description']"
    );

    data.job_description_html = await getHTML(
      page,
      "[data-test='job-description'], section[data-test='job-description']"
    );

    // Category / Subcategory
    data.category = await getText(
      page,
      "[data-test='job-features'] [data-test='job-category'], [data-test='breadcrumb'] a:nth-child(2)"
    );

    data.subcategory = await getText(
      page,
      "[data-test='job-features'] [data-test='job-subcategory'], [data-test='breadcrumb'] a:nth-child(3)"
    );

    // Budget / type / duration / experience
    data.experience_level = await getText(
      page,
      "[data-test='experience-level']"
    );
    data.project_length = await getText(page, "[data-test='project-length']");
    data.hourly_range = await getText(
      page,
      "[data-test='job-type-hourly'], [data-test='budget-hourly']"
    );
    data.fixed_budget = await getText(
      page,
      "[data-test='job-type-fixed'], [data-test='budget-fixed']"
    );

    // Client info
    data.client_country = await getText(page, "[data-test='client-location']");
    data.client_rating = await getText(page, "[data-test='client-feedback']");
    data.client_total_spent = await getText(page, "[data-test='client-spend']");
    data.client_hires = await getText(page, "[data-test='client-hires']");
    data.client_payment_verified = await getText(
      page,
      "[data-test='payment-verification-status']"
    );

    // Raw HTML (for backup / future parsing)
    data.raw_job_html = html;

    return {
      success: true,
      data: {
        job_id: cleanId,
        job_url: jobUrl,
        ...data,
      },
      attemptMeta: {
        attempt,
        jobId: cleanId,
        jobUrl,
        currentUrl,
        statusCode,
        durationMs: Date.now() - startTime,
        userAgent,
        viewport,
      },
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    return {
      success: false,
      errorType:
        (err && err.name === "TimeoutError")
          ? "timeout"
          : "navigation_error",
      message: String(err),
      statusCode,
      attemptMeta: {
        attempt,
        jobId: jobIdRaw,
        jobUrl,
        durationMs,
      },
    };
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {}
    }
    if (context) {
      try {
        await context.close();
      } catch {}
    }
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
}

/**
 * High-level retry wrapper.
 * Will retry on:
 *  - timeout
 *  - empty_response
 *  - bot_challenge
 *  - forbidden
 *  - rate_limited
 *  - server_error
 */
async function scrapeJobWithRetries(jobIdRaw) {
  const retryableErrors = new Set([
    "timeout",
    "empty_response",
    "bot_challenge",
    "forbidden",
    "rate_limited",
    "server_error",
    "navigation_error",
  ]);

  let lastError = null;
  const attemptsMeta = [];

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const result = await scrapeJobOnce(jobIdRaw, attempt);
    attemptsMeta.push(result.attemptMeta);

    if (result.success) {
      return {
        success: true,
        data: result.data,
        attempts: attemptsMeta,
      };
    }

    lastError = result;

    if (!retryableErrors.has(result.errorType)) {
      break; // non-retryable classification
    }

    // Backoff between attempts
    const backoffMs = randInt(1500 * attempt, 4000 * attempt);
    console.warn(
      `[SCRAPER] Attempt ${attempt} failed (${result.errorType}). Retrying in ${backoffMs}ms`
    );
    await sleep(backoffMs);
  }

  return {
    success: false,
    errorType: lastError?.errorType || "unknown",
    message: lastError?.message || "Unknown scrape failure",
    statusCode: lastError?.statusCode || null,
    attempts: attemptsMeta,
  };
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
    let { jobId, url } = req.query;

    if (!jobId && url) {
      const match = url.match(/~([A-Za-z0-9]+)/);
      if (match) jobId = match[1];
    }

    if (!jobId) {
      return res.status(400).json({
        error: "missing_parameters",
        message:
          "Provide ?jobId=... or ?url=https://www.upwork.com/jobs/~ID",
      });
    }

    const result = await scrapeJobWithRetries(jobId);

    if (!result.success) {
      // 4xx vs 5xx decision based on errorType
      const isRateOrLogin =
        result.errorType === "rate_limited" ||
        result.errorType === "bot_challenge" ||
        result.errorType === "login_required" ||
        result.errorType === "forbidden";

      const statusCode = isRateOrLogin ? 429 : 502;

      return res.status(statusCode).json({
        error: result.errorType,
        message: result.message,
        job_id: jobId,
        attempts: result.attempts,
      });
    }

    // Success
    return res.json({
      ...result.data,
      _meta: {
        attempts: result.attempts,
      },
    });
  } catch (err) {
    console.error("SCRAPE ERROR (unhandled):", err);
    res.status(500).json({
      error: "scrape_failed",
      message: String(err),
    });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Upwork scraper listening on port ${PORT}`);
});
