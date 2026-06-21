const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const WebSocket = require('ws');
const https = require('https');
const path = require('path');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 50,
  message: { error: "Too many requests, please try again later." }
});
app.use('/api/', apiLimiter);

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = ''; res.on('data', (chunk) => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// ==========================================
// REST API: MULTI-TIMEFRAME ANALYTICS
// ==========================================
app.get('/api/stock/multiframes', async (req, res) => {
  const { symbol, type } = req.query;
  if (!symbol) return res.status(400).json({ error: 'Stock symbol parameter is required.' });

  try {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const threeMonthsAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    const timeframes = [
      { id: '5m', period: '5m', period1: oneDayAgo, limit: 100 },
      { id: '1h', period: '1h', period1: oneWeekAgo, limit: 100 },
      { id: '1d', period: '1d', period1: threeMonthsAgo, limit: 100 }
    ];

    const results = {};
    for (const frame of timeframes) {
      if (type === 'crypto') {
        try {
          const data = await fetchJson(`https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${frame.period}&limit=${frame.limit}`);
          results[frame.id] = data.map(k => ({ time: k[0], close: parseFloat(k[4]) }));
        } catch (e) { results[frame.id] = []; }
      } else {
        try {
          const data = await yahooFinance.chart(symbol.toUpperCase(), { interval: frame.period, period1: frame.period1 });
          results[frame.id] = data.quotes.filter(q => q.close !== null).map(q => ({ time: new Date(q.date).getTime(), close: q.close }));
        } catch (e) { results[frame.id] = []; }
      }
    }
    res.json({ symbol: symbol.toUpperCase(), timeframes: results });
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve multi-timeframe analytics.', details: error.message });
  }
});

// ==========================================
// REST API: 14-DAY CATEGORIZED NEWS & SENTIMENT (WITH CACHE)
// ==========================================
const newsCache = new Map();
const CACHE_EXPIRY_MS = 5 * 60 * 1000; // 5 Minutes Cache

app.get('/api/stock/news', async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'Stock symbol parameter is required.' });

  const upperSymbol = symbol.toUpperCase();
  const now = Date.now();

  // 1. Check for valid cache
  if (newsCache.has(upperSymbol)) {
    const cachedItem = newsCache.get(upperSymbol);
    if (now - cachedItem.timestamp < CACHE_EXPIRY_MS) {
      console.log(`[Cache Hit] Serving instant news for: ${upperSymbol}`);
      return res.json(cachedItem.data);
    }
  }

  console.log(`[Cache Miss] Fetching fresh news from API for: ${upperSymbol}`);

  try {
    const searchResult = await yahooFinance.search(upperSymbol);
    const rawNews = searchResult.news || [];
    
    if (rawNews.length === 0) {
       console.log(`DEBUG: No news returned by Yahoo for ${upperSymbol}. Raw searchResult keys:`, Object.keys(searchResult));
    }

    const twoWeeksAgo = new Date();
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

    const organizedNews = { dealsAndFunding: [], meetingsAndCorporate: [], improvementsAndUpgrades: [], general: [] };

    let scoreCounter = 50; 
    const drivers = [];

    rawNews.forEach(item => {
      const mappedArticle = {
        title: item.title,
        publisher: item.publisher,
        link: item.link,
        summary: item.summary || '',
        publishedAt: item.providerPublishTime ? new Date(item.providerPublishTime * 1000) : null,
        thumbnail: item.thumbnail?.resolutions?.[0]?.url || null
      };

      if (!mappedArticle.publishedAt) return;
      
      if (mappedArticle.publishedAt >= twoWeeksAgo) {
        const contextualText = `${(mappedArticle.title || '').toLowerCase()} ${(mappedArticle.summary || '').toLowerCase()}`;
        
        if (/growth|upgrade|bull|surge|positive|funding|deal|partnership|breakout|launch/i.test(contextualText)) {
          scoreCounter += 3;
          if (drivers.length < 3) drivers.push(`+ ${mappedArticle.title.substring(0, 45)}...`);
          organizedNews.dealsAndFunding.push(mappedArticle);
        } else if (/loss|lawsuit|bear|drop|crash|negative|fear|decline|hack|sec/i.test(contextualText)) {
          scoreCounter -= 3;
          if (drivers.length < 3) drivers.push(`- ${mappedArticle.title.substring(0, 45)}...`);
          organizedNews.general.push(mappedArticle);
        } else if (/meeting|shareholder|board|guidance|conference|agm|egm|earnings|vote/i.test(contextualText)) {
          organizedNews.meetingsAndCorporate.push(mappedArticle);
        } else {
          organizedNews.general.push(mappedArticle);
        }
      }
    });

    const finalSentiment = Math.max(0, Math.min(100, scoreCounter));
    let sentimentLabel = "Neutral";
    if (finalSentiment >= 75) sentimentLabel = "Extreme Greed";
    else if (finalSentiment >= 60) sentimentLabel = "Greed";
    else if (finalSentiment <= 25) sentimentLabel = "Extreme Fear";
    else if (finalSentiment <= 40) sentimentLabel = "Fear";

    const responseData = { 
      symbol: upperSymbol, 
      categorizedNews: organizedNews,
      sentiment: { 
        score: finalSentiment, 
        label: sentimentLabel, 
        drivers: drivers.length ? drivers : ["Awaiting major market catalysts."] 
      }
    };

    newsCache.set(upperSymbol, {
        timestamp: now,
        data: responseData
    });

    res.json(responseData);
  } catch (error) {
    console.error("News API Error:", error);
    
    if (newsCache.has(upperSymbol)) {
        console.log(`[Cache Fallback] Serving expired cache for ${upperSymbol} due to API failure.`);
        return res.json(newsCache.get(upperSymbol).data);
    }
    
    res.status(500).json({ error: 'Failed to retrieve targeted stock news.', details: error.message });
  }
});

// ==========================================
// REST API: AGGREGATED 7-DAY NEWS (STANDALONE)
// ==========================================
app.get('/api/news/aggregate', async (req, res) => {
  const symbolsQuery = req.query.symbols || '';
  const symbolsArray = symbolsQuery.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

  if (symbolsArray.length === 0) return res.json([]);

  try {
    let aggregatedNews = [];
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    await Promise.all(symbolsArray.map(async (sym) => {
      let fetchSymbol = sym;
      if (['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA'].includes(sym)) {
        fetchSymbol = `${sym}-USD`;
      }

      try {
        const result = await yahooFinance.search(fetchSymbol, { newsCount: 20 });
        if (result && result.news) {
          result.news.forEach(article => {
            const articleDate = new Date(article.providerPublishTime * 1000);
            if (articleDate >= sevenDaysAgo) {
              aggregatedNews.push({
                ...article,
                symbol: sym 
              });
            }
          });
        }
      } catch (e) {
        console.error(`Failed to fetch news index for ${fetchSymbol}:`, e.message);
      }
    }));

    aggregatedNews.sort((a, b) => b.providerPublishTime - a.providerPublishTime);

    res.json(aggregatedNews);
  } catch (error) {
    res.status(500).json({ error: 'Failed to build aggregated news matrix.', details: error.message });
  }
});

// ----------------- INDICATOR MATH ENGINE -----------------
function calculateSMA(prices, period) {
  let sma = [];
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) sma.push(null);
    else { let sum = 0; for (let j = 0; j < period; j++) sum += prices[i - j]; sma.push(Number((sum / period).toFixed(2))); }
  }
  return sma;
}

function calculateEMA(prices, period) {
  let ema = [];
  if (prices.length === 0) return ema;
  let k = 2 / (period + 1), sum = 0;
  for (let i = 0; i < Math.min(period, prices.length); i++) sum += prices[i];
  let currentEma = sum / Math.min(period, prices.length);
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) ema.push(null);
    else {
      if (i === period - 1) ema.push(Number(currentEma.toFixed(2)));
      else { currentEma = prices[i] * k + currentEma * (1 - k); ema.push(Number(currentEma.toFixed(2))); }
    }
  }
  return ema;
}

function calculateRSI(prices, period = 14) {
  let rsi = [];
  if (prices.length <= period) return Array(prices.length).fill(null);
  let gains = [], losses = [];
  for (let i = 1; i < prices.length; i++) { let diff = prices[i] - prices[i - 1]; gains.push(diff > 0 ? diff : 0); losses.push(diff < 0 ? -diff : 0); }
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) { avgGain += gains[i]; avgLoss += losses[i]; }
  avgGain /= period; avgLoss /= period;
  for (let i = 0; i < prices.length; i++) {
    if (i <= period) rsi.push(null);
    else {
      let gain = gains[i - 1], loss = losses[i - 1];
      avgGain = (avgGain * (period - 1) + gain) / period; avgLoss = (avgLoss * (period - 1) + loss) / period;
      if (avgLoss === 0) rsi.push(100); else rsi.push(Number((100 - (100 / (1 + (avgGain / avgLoss)))).toFixed(2)));
    }
  }
  return rsi;
}

function calculateATR(candles, period = 14) {
  let atr = [];
  if (candles.length === 0) return atr;
  let trs = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) trs.push(candles[i].high - candles[i].low);
    else trs.push(Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close)));
  }
  let currentAtr = trs, sum = 0;
  for (let i = 0; i < Math.min(period, trs.length); i++) sum += trs[i];
  currentAtr = sum / Math.min(period, trs.length);
  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) atr.push(null);
    else if (i === period - 1) atr.push(Number(currentAtr.toFixed(4)));
    else { currentAtr = (currentAtr * (period - 1) + trs[i]) / period; atr.push(Number(currentAtr.toFixed(4))); }
  }
  return atr;
}

function detectSupportResistance(candles, windowSize = 5) {
  let supports = [], resistances = [];
  for (let i = windowSize; i < candles.length - windowSize; i++) {
    let currentClose = candles[i].close, isMin = true, isMax = true;
    for (let j = 1; j <= windowSize; j++) {
      if (candles[i - j].close < currentClose || candles[i + j].close < currentClose) isMin = false;
      if (candles[i - j].close > currentClose || candles[i + j].close > currentClose) isMax = false;
    }
    if (isMin) supports.push(currentClose); if (isMax) resistances.push(currentClose);
  }
  let sumDiffs = 0; for (let i = 0; i < candles.length; i++) sumDiffs += (candles[i].high - candles[i].low);
  const groupingThreshold = (candles.length > 0 ? (sumDiffs / candles.length) : 1) * 1.5; 
  function groupLevels(levels) {
    let sorted = [...levels].sort((a, b) => a - b), grouped = [];
    if (sorted.length === 0) return grouped;
    let currentGroup = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      let avg = currentGroup.reduce((s, v) => s + v, 0) / currentGroup.length;
      if (Math.abs(sorted[i] - avg) < groupingThreshold) currentGroup.push(sorted[i]);
      else { grouped.push(Number(avg.toFixed(2))); currentGroup = [sorted[i]]; }
    }
    grouped.push(Number((currentGroup.reduce((s, v) => s + v, 0) / currentGroup.length).toFixed(2)));
    return [...new Set(grouped)].slice(-5);
  }
  return { supports: groupLevels(supports), resistances: groupLevels(resistances) };
}

function detectPatterns(candles) {
  if (candles.length < 5) return [];
  const patterns = [];
  const i = candles.length - 1; 
  const c1 = candles[i], c2 = candles[i - 1], c3 = candles[i - 2];
  
  const c1Body = Math.abs(c1.close - c1.open), c2Body = Math.abs(c2.close - c2.open), c3Body = Math.abs(c3.close - c3.open);
  const c1Range = c1.high - c1.low;
  
  const isC1Bull = c1.close > c1.open, isC2Bull = c2.close > c2.open, isC3Bull = c3.close > c3.open;

  if (!isC2Bull && isC1Bull && c1.open <= c2.close && c1.close >= c2.open) patterns.push('Bullish Engulfing');
  if (isC2Bull && !isC1Bull && c1.open >= c2.close && c1.close <= c2.open) patterns.push('Bearish Engulfing');
  if (c1Range > 0 && (c1.high - Math.max(c1.open, c1.close)) < (c1Range * 0.1) && (Math.min(c1.open, c1.close) - c1.low) >= (c1Body * 2) && c1Body < (c1Range * 0.35)) patterns.push('Bullish Hammer');
  if (c1Range > 0 && (Math.min(c1.open, c1.close) - c1.low) < (c1Range * 0.1) && (c1.high - Math.max(c1.open, c1.close)) >= (c1Body * 2) && c1Body < (c1Range * 0.35)) patterns.push('Shooting Star');

  if (!isC3Bull && c2Body < (c3Body * 0.3) && isC1Bull && c1.close > (c3.open + c3.close)/2) patterns.push('Morning Star Reversal');
  if (isC3Bull && c2Body < (c3Body * 0.3) && !isC1Bull && c1.close < (c3.open + c3.close)/2) patterns.push('Evening Star Reversal');
  if (isC3Bull && isC2Bull && isC1Bull && c2.close > c3.close && c1.close > c2.close) patterns.push('Three White Soldiers');
  if (!isC3Bull && !isC2Bull && !isC1Bull && c2.close < c3.close && c1.close < c2.close) patterns.push('Three Black Crows');

  return patterns;
}

// ----------------- AI SIGNAL ENGINE -----------------
function generateAISignal(candles, indicators, srLevels, predictions) {
  const lastIndex = candles.length - 1;
  const close = candles[lastIndex].close;
  const rsi = indicators.rsi[lastIndex], sma20 = indicators.sma20[lastIndex], ema50 = indicators.ema50[lastIndex], atr = indicators.atr[lastIndex] || (close * 0.01);
  const patterns = detectPatterns(candles);
  
  let score = 0, explanations = [];
  if (ema50 && sma20) {
    if (close > ema50) { score += 20; explanations.push("Asset is trading above EMA(50) (Macro Bullish)."); } else { score -= 20; explanations.push("Asset is trading below EMA(50) (Macro Bearish)."); }
    if (sma20 > ema50) { score += 10; explanations.push("SMA(20) is above EMA(50) (Golden Cross tendency)."); } else { score -= 10; explanations.push("SMA(20) is below EMA(50) (Death Cross tendency)."); }
  }
  if (rsi !== null) {
    if (rsi < 30) { score += 35; explanations.push(`RSI is oversold at ${rsi}. Rebound likely.`); } else if (rsi > 70) { score -= 35; explanations.push(`RSI is overbought at ${rsi}. Correction likely.`); }
    else { explanations.push(`RSI is neutral at ${rsi}.`); }
  }
  if (patterns.length > 0) {
    patterns.forEach(p => { if (p.includes('Bullish') || p.includes('White') || p.includes('Morning')) { score += 30; explanations.push(`Detected ${p} (Bullish).`); } else { score -= 30; explanations.push(`Detected ${p} (Bearish).`); } });
  }

  score = Math.max(-100, Math.min(100, score));
  let signal = score >= 40 ? "BUY" : (score <= -40 ? "SELL" : "HOLD");
  let sentimentScore = 50 + (score / 2), sentimentText = sentimentScore >= 75 ? "Extreme Greed" : (sentimentScore <= 25 ? "Extreme Fear" : "Neutral");
  
  let sl = 0, tp1 = 0, tp2 = 0;
  
  if (signal === "BUY") { 
    sl = close - 1.5 * atr; 
    tp1 = close + 1.5 * (close - sl); 
    tp2 = close + 2.5 * (close - sl); 
  } else if (signal === "SELL") { 
    sl = close + 1.5 * atr; 
    tp1 = close - 1.5 * (sl - close); 
    tp2 = close - 2.5 * (sl - close); 
  }

  const setup = signal !== "HOLD" ? {
    type: signal === "BUY" ? `LONG` : `SHORT`,
    entry: close,
    tp1: Number(tp1.toFixed(2)),
    tp2: Number(tp2.toFixed(2)),
    sl: Number(sl.toFixed(2)),
    confidence: `${Math.min(99, Math.max(40, Math.round(Math.abs(score) * 0.85 + 15)))}%`,
  } : null;
  
  return { 
    signal, 
    score: Math.round(score), 
    confidence: `${Math.min(99, Math.max(15, Math.round(Math.abs(score) * 0.85 + 15)))}%`, 
    marketStrength: Math.abs(score) > 60 ? "Strong Trend" : "Sideways", 
    sentiment: { value: Math.round(sentimentScore), text: sentimentText, volatility: ((atr / close) * 100).toFixed(2) }, 
    tp: Number(tp1.toFixed(2)),
    sl: Number(sl.toFixed(2)), 
    setup, 
    explanations: explanations.length > 0 ? explanations : ["Waiting for breakouts."], 
    rsiValue: rsi 
  };
}

function generateFuturePredictions(candles, indicators, steps = 12) {
  if (candles.length < 30) return [];
  const currentPrice = candles[candles.length - 1].close;
  const intervalMs = candles.length >= 2 ? candles[candles.length - 1].time - candles[candles.length - 2].time : 60000;
  let predictions = [{ time: candles[candles.length - 1].time, value: currentPrice }], projectedPrice = currentPrice;
  for (let t = 1; t <= steps; t++) { projectedPrice += (Math.random() - 0.5) * currentPrice * 0.001; predictions.push({ time: candles[candles.length - 1].time + (t * intervalMs), value: Number(projectedPrice.toFixed(2)) }); }
  return predictions;
}

function enrichCandles(candles) {
  const prices = candles.map(c => c.close), sma20 = calculateSMA(prices, 20), ema50 = calculateEMA(prices, 50), rsi = calculateRSI(prices, 14), atr = calculateATR(candles, 14);
  const indicators = { sma20, ema50, rsi, atr }, srLevels = detectSupportResistance(candles), predictions = generateFuturePredictions(candles, indicators, 10);
  return { candles: candles.map((c, i) => ({ ...c, sma20: sma20[i], ema50: ema50[i], rsi: rsi[i], atr: atr[i] })), srLevels, aiAnalysis: generateAISignal(candles, indicators, srLevels, predictions), predictions };
}

// ----------------- YAHOO & BINANCE STREAMS -----------------
async function fetchYahooStockHistory(symbol, interval) {
  const params = { '1m':{i:'1m',r:'1d'}, '5m':{i:'5m',r:'5d'}, '15m':{i:'15m',r:'15d'}, '1h':{i:'1h',r:'3mo'}, '1d':{i:'1d',r:'2y'} }[interval] || {i:'1d',r:'1y'};
  const data = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol.toUpperCase()}?interval=${params.i}&range=${params.r}`);
  if (data?.chart?.result?.[0]) {
    const q = data.chart.result[0].indicators.quote[0], t = data.chart.result[0].timestamp;
    return t.map((time, i) => q.open[i]!==null ? { time: time*1000, open: Number(q.open[i].toFixed(2)), high: Number(q.high[i].toFixed(2)), low: Number(q.low[i].toFixed(2)), close: Number(q.close[i].toFixed(2)), volume: q.volume[i]||0 } : null).filter(Boolean);
  }
  throw new Error("Empty Yahoo result");
}

function generateSimulatedHistory(symbol, currentPrice, limit = 200) {
  let candles = [], now = Math.floor(Date.now() / 1000) * 1000;
  for (let i = limit; i >= 0; i--) { let c = currentPrice * (1 + (Math.random() - 0.48) * 0.005); candles.push({ time: now - (i * 60000), open: currentPrice, high: Math.max(currentPrice, c)*1.002, low: Math.min(currentPrice, c)*0.998, close: c, volume: 50000 }); currentPrice = c; }
  return candles;
}

class BinanceStreamManager {
  constructor() { this.activeStreams = new Map(); }
  async subscribe(socket, symbol, interval, type = 'crypto') {
    const key = `${symbol.toUpperCase()}_${interval}`; socket.join(key);
    if (this.activeStreams.has(key)) {
      this.activeStreams.get(key).clients.add(socket.id);
      const enriched = enrichCandles(this.activeStreams.get(key).candles);
      socket.emit('history', { symbol, interval, candles: enriched.candles, srLevels: enriched.srLevels, aiAnalysis: enriched.aiAnalysis, predictions: enriched.predictions });
      return;
    }
    const streamInfo = { ws: null, clients: new Set([socket.id]), candles: [], symbol, interval, isCrypto: type === 'crypto' };
    this.activeStreams.set(key, streamInfo);
    
    if (streamInfo.isCrypto) {
      try {
        const klines = await fetchJson(`https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=200`);
        streamInfo.candles = klines.map(k => ({ time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) }));
      } catch (err) { streamInfo.candles = generateSimulatedHistory(symbol, 100); streamInfo.isCrypto = false; }
    } else {
      try { streamInfo.candles = await fetchYahooStockHistory(symbol, interval); } catch (err) { streamInfo.candles = generateSimulatedHistory(symbol, 150); }
    }
    
    const enriched = enrichCandles(streamInfo.candles);
    io.to(key).emit('history', { symbol, interval, candles: enriched.candles, srLevels: enriched.srLevels, aiAnalysis: enriched.aiAnalysis, predictions: enriched.predictions });
    
    if (streamInfo.isCrypto) {
      const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@kline_${interval}`); streamInfo.ws = ws;
      ws.on('error', (err) => console.log(`[WS Log] Stream ${key} error: ${err.message}`));
      ws.on('message', (data) => { const k = JSON.parse(data).k; if (k) this.handleLiveTick(key, { time: k.t, open: parseFloat(k.o), high: parseFloat(k.h), low: parseFloat(k.l), close: parseFloat(k.c), volume: parseFloat(k.v) }, k.x); });
    } else {
      streamInfo.timer = setInterval(async () => {
        if (!this.activeStreams.has(key)) return;
        try {
          const fresh = await fetchYahooStockHistory(symbol, interval);
          if (fresh.length > 0) this.handleLiveTick(key, fresh[fresh.length - 1], fresh[fresh.length - 1].time > streamInfo.candles[streamInfo.candles.length - 1].time);
        } catch (err) { this.handleLiveTick(key, { ...streamInfo.candles[streamInfo.candles.length - 1], close: streamInfo.candles[streamInfo.candles.length - 1].close * (1 + (Math.random()-0.5)*0.0004) }, false); }
      }, 8000);
    }
  }
  handleLiveTick(key, candle, isClosed) {
    const streamInfo = this.activeStreams.get(key); if (!streamInfo) return;
    let candles = streamInfo.candles;
    if (candles.length > 0 && candles[candles.length - 1].time === candle.time) candles[candles.length - 1] = candle; else { if (isClosed) { candles.push(candle); if (candles.length > 300) candles.shift(); } else candles[candles.length - 1] = candle; }
    const enriched = enrichCandles(candles);
    io.to(key).emit('tick', { symbol: streamInfo.symbol, interval: streamInfo.interval, candle: enriched.candles[enriched.candles.length - 1], srLevels: enriched.srLevels, aiAnalysis: enriched.aiAnalysis, predictions: enriched.predictions });
    checkPortfolioTriggers(streamInfo.symbol, candle.close);
  }
  unsubscribeAll(socket) {
    for (const [key, streamInfo] of this.activeStreams.entries()) {
      if (streamInfo.clients.has(socket.id)) { 
        streamInfo.clients.delete(socket.id); 
        if (streamInfo.clients.size === 0) { 
          if (streamInfo.ws) { try { streamInfo.ws.close(); } catch(e) {} } 
          if (streamInfo.timer) clearInterval(streamInfo.timer); 
          this.activeStreams.delete(key); 
        } 
      }
    }
  }
}
const streamManager = new BinanceStreamManager();

// ----------------- PORTFOLIO LIQUIDATION ENGINE -----------------
const portfolios = new Map();
function getPortfolio(socketId) { if (!portfolios.has(socketId)) portfolios.set(socketId, { balance: 10000.00, marginUsed: 0, positions: [], history: [] }); return portfolios.get(socketId); }

function checkPortfolioTriggers(symbol, currentPrice) {
  for (const [socketId, portfolio] of portfolios.entries()) {
    let changed = false;
    portfolio.positions = portfolio.positions.filter(pos => {
      if (pos.symbol.toUpperCase() !== symbol.toUpperCase()) return true;
      let triggerHit = false, exitReason = "", exitPrice = currentPrice;
      
      if (pos.type === 'BUY' && currentPrice <= pos.liqPrice) { triggerHit = true; exitReason = "LIQUIDATION"; exitPrice = pos.liqPrice; }
      else if (pos.type === 'SELL' && currentPrice >= pos.liqPrice) { triggerHit = true; exitReason = "LIQUIDATION"; exitPrice = pos.liqPrice; }
      else if (pos.type === 'BUY') {
        if (pos.sl > 0 && currentPrice <= pos.sl) { triggerHit = true; exitPrice = pos.sl; exitReason = "STOP LOSS"; }
        else if (pos.tp > 0 && currentPrice >= pos.tp) { triggerHit = true; exitPrice = pos.tp; exitReason = "TAKE PROFIT"; }
      } else if (pos.type === 'SELL') {
        if (pos.sl > 0 && currentPrice >= pos.sl) { triggerHit = true; exitPrice = pos.sl; exitReason = "STOP LOSS"; }
        else if (pos.tp > 0 && currentPrice <= pos.tp) { triggerHit = true; exitPrice = pos.tp; exitReason = "TAKE PROFIT"; }
      }
      
      if (triggerHit) {
        let pnl = pos.type === 'BUY' ? (exitPrice - pos.entryPrice) * pos.amount : (pos.entryPrice - exitPrice) * pos.amount;
        portfolio.balance += pos.marginAllocated + pnl;
        portfolio.marginUsed -= pos.marginAllocated;
        portfolio.history.push({ id: pos.id, symbol: pos.symbol, type: pos.type, entryPrice: pos.entryPrice, exitPrice, amount: pos.amount, pnl: Number(pnl.toFixed(2)), exitReason, timestamp: Date.now() });
        changed = true;
        const socket = io.sockets.sockets.get(socketId);
        if (socket) socket.emit('portfolio_event', { type: exitReason === 'LIQUIDATION' ? 'LIQUIDATED' : 'TRIGGER_HIT', message: `${exitReason} hit for ${pos.symbol}! PnL: $${pnl.toFixed(2)}`, portfolio });
        return false; 
      }
      return true; 
    });
    if (changed) updatePortfolioClients(socketId);
  }
}

function updatePortfolioClients(socketId) { const socket = io.sockets.sockets.get(socketId); if (socket) socket.emit('portfolio_update', getPortfolio(socketId)); }

// ----------------- BACKTESTER -----------------
async function runBacktest(symbol, interval, strategy, type = 'crypto') {
  try {
    let candles = [];
    if (type === 'crypto') {
      const data = await fetchJson(`https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=1000`);
      candles = data.map(k => ({ time: k[0], close: parseFloat(k[4]) }));
    } else {
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

      const data = await yahooFinance.chart(symbol.toUpperCase(), { interval: interval, period1: oneYearAgo });
      candles = data.quotes.filter(q => q.close !== null).map(q => ({ time: new Date(q.date).getTime(), close: q.close }));
    }

    if (candles.length < 50) return { error: "Insufficient historical data for backtesting." };

    const prices = candles.map(c => c.close);
    const rsi = calculateRSI(prices, 14);
    let position = null, history = [], wins = 0, losses = 0, netProfit = 0;
    const positionSize = 1000;

    for (let i = 15; i < candles.length; i++) {
      const currentPrice = candles[i].close, currentRsi = rsi[i];
      if (strategy === 'RSI_OVERSOLD') {
        if (!position && currentRsi < 30) position = { entryPrice: currentPrice, time: candles[i].time, size: positionSize / currentPrice };
        else if (position && currentRsi > 70) {
          const pnl = (currentPrice - position.entryPrice) * position.size;
          netProfit += pnl;
          if (pnl > 0) wins++; else losses++;
          history.push({ type: 'BUY', entryPrice: position.entryPrice, exitPrice: currentPrice, pnl: Number(pnl.toFixed(2)), exitReason: 'RSI > 70', time: candles[i].time });
          position = null;
        }
      } else {
          if(Math.random() > 0.8 && !position) position = { entryPrice: currentPrice, time: candles[i].time, size: positionSize / currentPrice };
          else if (position && Math.random() > 0.8) {
              const pnl = (currentPrice - position.entryPrice) * position.size;
              netProfit += pnl; if (pnl > 0) wins++; else losses++;
              history.push({ type: 'BUY', entryPrice: position.entryPrice, exitPrice: currentPrice, pnl: Number(pnl.toFixed(2)), exitReason: 'AI Trigger', time: candles[i].time });
              position = null;
          }
      }
    }

    const totalTrades = wins + losses;
    return { 
      strategy, symbol, interval, totalTrades, 
      winRate: totalTrades > 0 ? `${((wins / totalTrades) * 100).toFixed(1)}%` : '0%', 
      wins, losses, netProfit, 
      roi: `${((netProfit / positionSize) * 100).toFixed(2)}%`, 
      history: history.slice(-10).reverse() 
    };
  } catch (error) { return { error: "Backtest failed. No data." }; }
}

// ----------------- WEBSOCKET API -----------------
io.on('connection', (socket) => {
  updatePortfolioClients(socket.id);
  socket.on('subscribe', async (data) => { streamManager.unsubscribeAll(socket); await streamManager.subscribe(socket, data.symbol, data.interval, data.type || 'crypto'); });
  
  socket.on('submit_order', (order) => {
    const { symbol, type, amount, currentPrice, customTp, customSl, leverage } = order;
    const portfolio = getPortfolio(socket.id);
    const notionalValue = currentPrice * amount, marginRequired = notionalValue / leverage;
    if (portfolio.balance < marginRequired) return socket.emit('portfolio_event', { type: 'ORDER_REJECTED', message: `Insufficient Margin! Req: $${marginRequired.toFixed(2)}` });
    portfolio.balance -= marginRequired; portfolio.marginUsed += marginRequired;
    const liqPrice = type === 'BUY' ? currentPrice - (currentPrice / leverage) : currentPrice + (currentPrice / leverage);
    portfolio.positions.push({ id: Math.random().toString(36).substring(2, 9), symbol: symbol.toUpperCase(), type, leverage, marginAllocated: marginRequired, entryPrice: currentPrice, liqPrice, amount, sl: customSl || 0, tp: customTp || 0, timestamp: Date.now() });
    updatePortfolioClients(socket.id);
    socket.emit('portfolio_event', { type: 'ORDER_FILLED', message: `Executed ${leverage}x ${type} order for ${symbol}`, portfolio });
  });
  
  socket.on('close_position', (data) => {
    const portfolio = getPortfolio(socket.id), posIndex = portfolio.positions.findIndex(p => p.id === data.id);
    if (posIndex === -1) return;
    const pos = portfolio.positions[posIndex];
    let pnl = pos.type === 'BUY' ? (data.currentPrice - pos.entryPrice) * pos.amount : (pos.entryPrice - data.currentPrice) * pos.amount;
    portfolio.balance += pos.marginAllocated + pnl; portfolio.marginUsed -= pos.marginAllocated;
    portfolio.history.push({ id: pos.id, symbol: pos.symbol, type: pos.type, entryPrice: pos.entryPrice, exitPrice: data.currentPrice, amount: pos.amount, pnl: Number(pnl.toFixed(2)), exitReason: "MANUAL CLOSE", timestamp: Date.now() });
    portfolio.positions.splice(posIndex, 1); updatePortfolioClients(socket.id);
    socket.emit('portfolio_event', { type: 'POSITION_CLOSED', message: `Closed position. PnL: $${pnl.toFixed(2)}`, portfolio });
  });
  
  // ==========================================
  // ADVANCED HISTORICAL BACKTESTING ENGINE
  // ==========================================
  socket.on('run_backtest', async (data) => {
    try {
      let symbol = (data.symbol || 'BTC').toUpperCase();
      let strategyInput = (data.strategy || 'ai').toLowerCase();
      
      const cryptoAssets = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA'];
      if (cryptoAssets.includes(symbol) && !symbol.includes('-')) {
        symbol = `${symbol}-USD`;
      } else if (symbol.endsWith('USDT')) {
        symbol = symbol.replace('USDT', '-USD');
      }

      let strategy = 'ai';
      if (strategyInput.includes('rsi')) strategy = 'rsi';
      if (strategyInput.includes('cross') || strategyInput.includes('trend')) strategy = 'crossover';

      console.log(`[Backtest Engine] Running ${strategy.toUpperCase()} strategy for parsed ticker: ${symbol}`);

      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(endDate.getDate() - 90);

      const options = {
        period1: startDate.toISOString().split('T')[0],
        period2: endDate.toISOString().split('T')[0],
        interval: '1d'
      };

      const chartData = await yahooFinance.chart(symbol, options);
      const historicalData = (chartData.quotes || []).filter(q => q.close !== null && q.close !== undefined);

      if (!historicalData || historicalData.length < 15) {
        return socket.emit('backtest_results', {
          success: false,
          error: `No historical data returned for ${symbol}. Try a different asset.`
        });
      }

      // 5. Execute Core Strategy Performance Math
      let balance = 10000; // Starting virtual bankroll
      const initialBalance = balance;
      let position = 0; 
      let tradesCount = 0;
      let winningTrades = 0;
      
      // NEW: Track historical trades and actual entry prices
      let history = [];
      let entryPrice = 0;

      for (let i = 5; i < historicalData.length; i++) {
        const current = historicalData[i];
        const prev = historicalData[i - 1];
        if (!current.close || !prev.close) continue;

        let signal = 'HOLD';

        // Evaluate Selected Technical Rules Matrix
        if (strategy === 'rsi') {
          const isOversold = current.close < prev.close && prev.close < historicalData[i - 2].close;
          const isOverbought = current.close > prev.close && prev.close > historicalData[i - 2].close;
          if (isOversold) signal = 'BUY';
          else if (isOverbought) signal = 'SELL';
        } 
        else if (strategy === 'crossover') {
          const sma5 = (historicalData[i].close + historicalData[i-1].close + historicalData[i-2].close + historicalData[i-3].close + historicalData[i-4].close) / 5;
          if (current.close > sma5 && prev.close <= sma5) signal = 'BUY';
          else if (current.close < sma5 && prev.close >= sma5) signal = 'SELL';
        } 
        else {
          if (current.close > prev.close && current.volume > prev.volume) signal = 'BUY';
          else if (current.close < prev.close && current.volume > prev.volume) signal = 'SELL';
        }

        // Execute orders inside simulated ecosystem
        if (signal === 'BUY' && position === 0) {
          position = balance / current.close;
          entryPrice = current.close; // Store exact entry price
          balance = 0;
        } else if (signal === 'SELL' && position > 0) {
          const closingValue = position * current.close;
          const tradePnL = closingValue - (position * entryPrice); // Calculate real PnL
          
          history.push({
            type: 'BUY', 
            entryPrice: entryPrice,
            exitPrice: current.close,
            pnl: tradePnL,
            exitReason: strategyInput.toUpperCase() + ' Signal',
            time: current.date || Date.now()
          });

          balance = closingValue;
          position = 0;
          tradesCount++;
          if (tradePnL > 0) winningTrades++; // Correct Win/Loss condition
        }
      }

      // Automatically liquidate remaining assets at execution horizon's close
      if (position > 0) {
        const finalClose = historicalData[historicalData.length - 1].close;
        const closingValue = position * finalClose;
        const tradePnL = closingValue - (position * entryPrice);
        
        history.push({
          type: 'BUY',
          entryPrice: entryPrice,
          exitPrice: finalClose,
          pnl: tradePnL,
          exitReason: 'End of Period',
          time: historicalData[historicalData.length - 1].date || Date.now()
        });

        balance = closingValue;
        tradesCount++;
        if (tradePnL > 0) winningTrades++;
        position = 0;
      }

      const totalReturn = ((balance - initialBalance) / initialBalance) * 100;
      const winRate = tradesCount > 0 ? (winningTrades / tradesCount) * 100 : 0;

      // 6. Return standard compliance payload to app.js frontend parser
      socket.emit('backtest_results', {
        success: true,
        symbol: symbol.replace('-USD', ''), 
        strategy: strategyInput.toUpperCase(),
        totalReturn: totalReturn.toFixed(2),
        winRate: winRate.toFixed(2),
        tradesCount: tradesCount, 
        finalBalance: balance.toFixed(2),
        history: history.slice(-10).reverse() 
      });

    } catch (err) {
      console.error('[Backtest Engine Failure]:', err);
      socket.emit('backtest_results', {
        success: false,
        error: `Backtest Engine failed internally: ${err.message}`
      });
    }
  });

  socket.on('disconnect', () => { streamManager.unsubscribeAll(socket); portfolios.delete(socket.id); });
});

server.listen(PORT, () => console.log(`Finsight AI Server on port ${PORT}`));