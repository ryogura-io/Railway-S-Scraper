// index.mjs
import puppeteer from "puppeteer";
import * as cheerio from "cheerio";
import express from "express";
import { MongoClient } from "mongodb";

// === CONFIG ===
const MONGO_URI = "mongodb+srv://Ryou:12345@shoob-cards.6bphku9.mongodb.net/?retryWrites=true&w=majority&appName=Shoob-Cards";
const DB_NAME = "cards-backup";

// 🔑 Change this to scrape a different event
const EVENT_NAME = "halloween";       // e.g. "summer", "valentine", etc.
const COLLECTION_NAME = `cards`; // separate collection per event

const START_PAGE = 1;      // First page to scrape
const END_PAGE = 10;        // Last page to scrape

let db, cardsCollection;

// === Connect to MongoDB ===
async function connectMongo() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(DB_NAME);
  cardsCollection = db.collection(COLLECTION_NAME);
  console.log(`✅ Connected to MongoDB Atlas (Collection: ${COLLECTION_NAME})`);
}

// === Launch Puppeteer ===
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

// === Fetch page HTML ===
async function fetchHtml(browser, url) {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
  const html = await page.content();
  await page.close();
  return html;
}

// === Scrape a single card page ===
async function scrapeCardPage(browser, url) {
  try {
    const html = await fetchHtml(browser, url);
    const $ = cheerio.load(html);

    // image or video
    const img =
      $(".cardData video.img-fluid").attr("src") ||
      $(".cardData img.img-fluid").attr("src") ||
      null;

    const card = {
      url,
      name:
        $("ol.breadcrumb-new li:last-child span[itemprop='name']")
          .text()
          ?.trim() || null,
              tier: $("ol.breadcrumb-new li:nth-child(5) span[itemprop='name']")
    .text()
    ?.trim()
    .replace("Tier ", "") || null,
  isEvent: true,   
      event: EVENT_NAME,
      series:
        $("ol.breadcrumb-new li:nth-child(4) span[itemprop='name']")
          .text()
          ?.trim() || null,
      img,
      maker:
        $("p:has(span.padr5)").text()?.replace("Card Maker:", "").trim() || null,
    };

    if (!card.name || !card.img) {
      console.log("⚠️ Skipped invalid card:", url);
      return null;
    }

    console.log(`✅ Scraped card: ${card.name}`);

    await cardsCollection.updateOne(
      { url: card.url },
      { $set: card },
      { upsert: true }
    );

    return card;
  } catch (err) {
    console.log(`❌ Failed scraping ${url}: ${err.message}`);
    return null;
  }
}

// === Scrape all event pages ===
async function scrapeAllPages(existingUrls) {
  const newCards = [];

  for (let i = START_PAGE; i <= END_PAGE; i++) {
    const pageUrl = `https://shoob.gg/card-events/${EVENT_NAME}?page=${i}&tier=null`;
    console.log(`🔹 Scraping index: ${pageUrl}`);

    let browser;
    try {
      browser = await initBrowser();
      const html = await fetchHtml(browser, pageUrl);
      const $ = cheerio.load(html);

      // collect all event-card links
const cardLinks = [
  ...new Set(
    $(`a[href^='/card-events/${EVENT_NAME}/']`)
      .map((_, a) => "https://shoob.gg" + $(a).attr("href"))
      .get()
  ),
];

      for (const link of cardLinks) {
        if (!existingUrls.has(link)) {
          const card = await scrapeCardPage(browser, link);
          if (card) {
            newCards.push(card);
            existingUrls.add(link);
          }
          await new Promise((r) => setTimeout(r, 1000)); // delay between card pages
        }
      }
    } catch (err) {
      console.log(`⚠️ Failed index page ${pageUrl}: ${err.message}`);
    } finally {
      if (browser) await browser.close();
    }

    await new Promise((r) => setTimeout(r, 2000)); // delay between index pages
  }

  return newCards;
}

// === Run the scraper ===
async function runScraper() {
  const existingCards = await cardsCollection
    .find({}, { projection: { url: 1 } })
    .toArray();

  const existingUrls = new Set(existingCards.map((c) => c.url));
  console.log(`Loaded ${existingUrls.size} existing cards from Mongo`);

  const newCards = await scrapeAllPages(existingUrls);
  console.log(`✅ Added ${newCards.length} new cards for event`);
}

// === Keep-alive Express server ===
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send(`✅ Shoob event scraper is alive! Current event: ${EVENT_NAME}`);
});

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`✅ Keep-alive server running on port ${PORT}`);
  await connectMongo();
  await runScraper();
});










