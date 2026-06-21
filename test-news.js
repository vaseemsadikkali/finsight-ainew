const https = require('https');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse: ${e.message}`));
        }
      });
    }).on('error', (err) => reject(err));
  });
}

async function test() {
  const symbol = 'AAPL';
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${symbol}&newsCount=10`;
  try {
    console.log(`Fetching news for ${symbol}...`);
    const res = await fetchJson(url);
    if (res && res.news) {
      console.log(`Found ${res.news.length} news articles:`);
      res.news.slice(0, 3).forEach((item, index) => {
        console.log(`\nArticle #${index+1}:`);
        console.log(`Title: ${item.title}`);
        console.log(`Publisher: ${item.publisher}`);
        console.log(`Link: ${item.link}`);
        console.log(`UUID: ${item.uuid}`);
        console.log(`Provider Publish Time: ${new Date(item.providerPublishTime * 1000).toLocaleString()}`);
      });
    } else {
      console.log("No news found. Full response:", JSON.stringify(res, null, 2));
    }
  } catch (err) {
    console.error("Error:", err.message);
  }
}

test();
