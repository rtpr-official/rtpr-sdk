import { RtprClient } from "@rtpr-io/rtpr";

const client = new RtprClient("your_api_key");

async function main() {
  // Get recent articles across all tickers
  const articles = await client.getArticles(10);
  for (const a of articles) {
    console.log(`[${a.ticker}] ${a.title}`);
    console.log(`  Source: ${a.author} | ${a.created}`);
    console.log();
  }

  // Get articles for a specific ticker
  const aapl = await client.getArticlesByTicker("AAPL", 5);
  console.log(`\nAAPL articles: ${aapl.length}`);
}

main().catch(console.error);
