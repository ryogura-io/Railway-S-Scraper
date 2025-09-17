// index.mjs
import fs from "fs";
import puppeteer from "puppeteer";
import * as cheerio from "cheerio";
import express from "express";
import { MongoClient } from "mongodb";

// --- CONFIG ---
const MONGO_URI = "mongodb+srv://Ryou:12345@shoob-cards.6bphku9.mongodb.net/?retryWrites=true&w=majority&appName=Shoob-Cards";
const DB_NAME = "cards-backup";
const COLLECTION_NAME = "cards";
const DATA_FILE = "cards.json"; 
const TIERS = [6,'S'];
const PAGE_RANGES = {
  6: [1, 34], 
  'S': [1, 7]
};

let db, cardsCollection;

// --- MongoDB Setup ---
async function connectMongo() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(DB_NAME);
  cardsCollection = db.collection(COLLECTION_NAME);
  console.log("✅ Connected to MongoDB Atlas");
}

// --- Launch Puppeteer ---
async function initBrowser() {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--single-process"
    ]
  });
  console.log("✅ Headless Chrome started");
  return browser;
}

// --- Scrape a page HTML ---
async function fetchHtml(url, waitSelector = null) {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

  if (waitSelector) {
    await page.waitForSelector(waitSelector, { timeout: 30000 });
  }

  const html = await page.content();
  await page.close();
  return html;
}

// --- Scrape a single card page ---
async function scrapeCardPage(browser, url, tier, attempt = 1) {
  try {
    const html = await fetchHtml(url, ".cardData img.img-fluid, .cardData video.img-fluid");
    const $ = cheerio.load(html);

    // img vs video condition
    let img;
    if (tier === 6 || tier === "S") {
      img = $(".cardData video.img-fluid").attr("src") || null;
    } else {
      img = $(".cardData img.img-fluid").attr("src") || null;
    }

    const card = {
      url,
      name: $("ol.breadcrumb-new li:last-child span[itemprop='name']").text()?.trim() || null,
      tier: $("ol.breadcrumb-new li:nth-child(3) span[itemprop='name']").text()?.trim() || null,
      series: $("ol.breadcrumb-new li:nth-child(4) span[itemprop='name']").text()?.trim() || null,
      img,
      maker: $("p:has(span.padr5)").text()?.replace("Card Maker:", "").trim() || null,
    };

    if (!card.name || !card.img) {
      console.log("⚠️ Skipped invalid card:", url);
      return null;
    }

    console.log("✅ Scraped card:", card.name);

    await cardsCollection.updateOne(
      { url: card.url },
      { $set: card },
      { upsert: true }
    );

    return card;
  } catch (err) {
    if (attempt < 3) {
      console.log(`🔁 Retry ${attempt} for ${url} due to error: ${err.message}`);
      // restart browser and try again
      const newBrowser = await initBrowser();
      const result = await scrapeCardPage(newBrowser, url, tier, attempt + 1);
      await newBrowser.close();
      return result;
    }
    console.log(`❌ Failed scraping ${url} after 3 attempts: ${err.message}`);
    return null;
  }
}

// --- Scrape all index pages ---
async function scrapeAllPages(existingUrls) {
  const newCards = [];

  for (const tier of TIERS) {
    const [start, end] = PAGE_RANGES[tier];
    for (let i = start; i <= end; i++) {
      const pageUrl = `https://shoob.gg/cards?page=${i}&tier=${tier}`;
      console.log(`🔹 Scraping index: ${pageUrl}`);

      let browser;
      try {
        browser = await initBrowser(); // restart browser for each index page
        const html = await fetchHtml(pageUrl, "a[href^='/cards/info/']");
        const $ = cheerio.load(html);

        const cardLinks = [
          ...new Set(
            $("a[href^='/cards/info/']")
              .map((_, a) => "https://shoob.gg" + $(a).attr("href"))
              .get()
          ),
        ];

        for (const link of cardLinks) {
          if (!existingUrls.has(link)) {
            const card = await scrapeCardPage(browser, link, tier);
            if (card) {
              newCards.push(card);
              existingUrls.add(link);
            }
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      } catch (err) {
        console.log(`⚠️ Failed index page ${pageUrl}: ${err.message}`);
      } finally {
        if (browser) await browser.close(); // close after each page
      }

      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  return newCards;
}

// --- Run scraper ---
async function runScraper() {
  const existingCards = await cardsCollection.find({}, { projection: { url: 1 } }).toArray();
  const existingUrls = new Set(existingCards.map((c) => c.url));
  console.log(`Loaded ${existingUrls.size} existing cards from Mongo`);

  const newCards = await scrapeAllPages(existingUrls);
  console.log(`✅ Added ${newCards.length} new cards`);
}

// === Keep Alive Server ===
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("✅ Gura Shoob scraper is alive with Puppeteer!");
});

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`✅ Keep-alive server running on port ${PORT}`);
  await connectMongo();
  await runScraper();
});


