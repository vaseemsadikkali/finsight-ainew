/**
 * Finsight AI Frontend Client v4.0
 * Premium Terminal Controller — Multi-Timeframe, News, Voice, Dark/Light, Alerts, Trade Setups
 */

document.addEventListener('DOMContentLoaded', () => {
  // ==================== ELEMENT REFERENCES ====================
  const socket = io();
  const symbolSelect = document.getElementById('symbol-select');
  const timeframeSelector = document.getElementById('timeframe-selector');
  const livePriceMain = document.getElementById('live-price-main');
  const liveChangePct = document.getElementById('live-change-pct');
  const chartWatermark = document.getElementById('chart-watermark');
  const chartLoader = document.getElementById('chart-loader');
  const connectionIndicator = document.getElementById('connection-indicator');
  const toastElement = document.getElementById('notification-toast');
  const toastMessage = document.getElementById('toast-message');
  const toastIcon = document.getElementById('toast-icon');

  // AI Signal Card
  const signalBadge = document.getElementById('signal-badge');
  const signalConfidence = document.getElementById('signal-confidence');
  const signalStrength = document.getElementById('signal-strength');
  const aiExplanationsList = document.getElementById('ai-explanations-list');
  const resistancesList = document.getElementById('resistances-list');
  const supportsList = document.getElementById('supports-list');

  // Sentiment
  const sentimentText = document.getElementById('sentiment-text');
  const volatilityVal = document.getElementById('volatility-val');
  const sentimentBar = document.getElementById('sentiment-bar');

  // Portfolio
  const portBalance = document.getElementById('port-balance');
  const portEquity = document.getElementById('port-equity');
  const portUnrealized = document.getElementById('port-unrealized');
  const portMarginUsed = document.getElementById('port-margin-used');
  const portTradesCount = document.getElementById('port-trades-count');
  const orderAmount = document.getElementById('order-amount');
  const orderUnit = document.getElementById('order-unit');
  const orderTp = document.getElementById('order-tp');
  const orderSl = document.getElementById('order-sl');
  const orderLeverage = document.getElementById('order-leverage-slider');
  const leverageVal = document.getElementById('leverage-val');
  const orderTypeBuy = document.getElementById('order-type-buy');
  const orderTypeSell = document.getElementById('order-type-sell');
  const suggestTpBtn = document.getElementById('suggest-tp-btn');
  const suggestSlBtn = document.getElementById('suggest-sl-btn');
  const submitOrderBtn = document.getElementById('submit-order-btn');
  const positionsTable = document.getElementById('positions-table').getElementsByTagName('tbody')[0];
  const historyTable = document.getElementById('history-table').getElementsByTagName('tbody')[0];

  // ==================== APPLICATION STATE ====================
  let currentSymbol = 'BTCUSDT';
  let currentTimeframe = '1m';
  let currentSymbolType = 'crypto';
  let currentOrderType = 'BUY';
  let currentPrice = 0;
  let lastPrice = 0;
  let portfolioData = { balance: 10000, marginUsed: 0, positions: [], history: [] };
  let aiSuggestedTp = 0;
  let aiSuggestedSl = 0;
  let showSrLines = true;
  let lastSrLevels = { supports: [], resistances: [] };
  let newsData = null;
  let activeNewsCategory = 'all';

  // Chart instances
  let chart = null, rsiChart = null;
  let candlestickSeries = null, volumeSeries = null, sma20Line = null, ema50Line = null;
  let rsiSeries = null, predictionSeries = null;
  let srLines = [];
  let miniCharts = {};

  // ==================== MATH UTILS ====================
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

  // ==================== SOUND ENGINE ====================
  let audioCtx = null;
  function playTone(freq, type, duration, vol = 0.08) {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type; osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
      gain.gain.setValueAtTime(vol, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.00001, audioCtx.currentTime + duration);
      osc.connect(gain); gain.connect(audioCtx.destination);
      osc.start(); osc.stop(audioCtx.currentTime + duration);
    } catch (e) {}
  }
  function triggerSound(type) {
    if (type === 'success') { playTone(523, 'sine', 0.1, 0.12); setTimeout(() => playTone(659, 'sine', 0.15, 0.12), 80); }
    else if (type === 'error') playTone(180, 'sawtooth', 0.25, 0.08);
    else if (type === 'click') playTone(600, 'sine', 0.04, 0.04);
    else if (type === 'listen') { playTone(440, 'triangle', 0.12, 0.08); setTimeout(() => playTone(554, 'triangle', 0.18, 0.08), 100); }
  }

  // ==================== TOAST & ALERTS ====================
  function showToast(message, type = 'info') {
    toastMessage.textContent = message;
    toastElement.className = `notification-toast show ${type}`;
    if (type === 'success') { toastIcon.className = 'fa-solid fa-circle-check'; triggerSound('success'); }
    else if (type === 'error') { toastIcon.className = 'fa-solid fa-triangle-exclamation'; triggerSound('error'); }
    else { toastIcon.className = 'fa-solid fa-circle-info'; triggerSound('click'); }
    setTimeout(() => toastElement.classList.remove('show'), 3500);
  }

  // ALERTS ENGINE
  let lastAlertTime = 0;
  let prevRsi = 50;
  let prevPrice = 0;

  function triggerSystemAlert(title, message, type = 'info') {
    if (Date.now() - lastAlertTime < 10000) return;
    lastAlertTime = Date.now();

    showToast(message, type);
    
    if (Notification.permission === 'granted') {
      new Notification(`Finsight AI: ${title}`, { body: message });
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission();
    }
  }

  // ==================== SOCKET CONNECTION ====================
  socket.on('connect', () => {
    connectionIndicator.classList.add('connected');
    connectionIndicator.querySelector('.indicator-text').textContent = 'Live Feed';
    showToast('Real-time feed active.', 'success');
    requestSubscription(currentSymbol, currentTimeframe, currentSymbolType);
  });
  
  socket.on('disconnect', (reason) => {
    connectionIndicator.classList.remove('connected');
    connectionIndicator.querySelector('.indicator-text').textContent = 'Disconnected';
    if (reason === 'io server disconnect') { socket.connect(); } 
    else { showToast('Connection lost. Reconnecting...', 'error'); }
  });

  socket.io.on("reconnect", () => { showToast(`Reconnected successfully`, 'success'); });

  function requestSubscription(symbol, interval, type = 'crypto') {
    chartLoader.style.opacity = '1'; chartLoader.style.pointerEvents = 'all';
    socket.emit('subscribe', { symbol, interval, type });
    fetchNewsForSymbol(symbol);
    fetchMultiTimeframeData(symbol, type);
  }

  // ==================== CHART INITIALIZATION ====================
  function getChartColors() {
    const isLight = document.body.classList.contains('light-theme');
    return {
      bg: isLight ? '#ffffff' : '#0f1118',
      text: isLight ? '#111827' : '#d1d4dc',
      grid: isLight ? 'rgba(0, 0, 0, 0.04)' : 'rgba(43, 49, 57, 0.3)',
      border: isLight ? '#dee2e6' : '#2b3139',
      upColor: '#00d68f',
      downColor: '#ff4d6a',
    };
  }

  function initChart() {
    const mainContainer = document.getElementById('main-trading-chart');
    const rsiContainer = document.getElementById('rsi-trading-chart');
    mainContainer.innerHTML = ''; rsiContainer.innerHTML = '';
    const colors = getChartColors();

    chart = LightweightCharts.createChart(mainContainer, {
      layout: { background: { color: colors.bg }, textColor: colors.text, fontSize: 11, fontFamily: "'JetBrains Mono', monospace" },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal, vertLine: { color: 'rgba(99, 102, 241, 0.3)' }, horzLine: { color: 'rgba(99, 102, 241, 0.3)' } },
      timeScale: { visible: false },
      rightPriceScale: { borderColor: colors.border },
    });
    candlestickSeries = chart.addCandlestickSeries({ upColor: colors.upColor, downColor: colors.downColor, borderVisible: false, wickUpColor: colors.upColor, wickDownColor: colors.downColor });
    volumeSeries = chart.addHistogramSeries({ color: 'rgba(99, 102, 241, 0.15)', priceFormat: { type: 'volume' }, priceScaleId: '' });
    chart.priceScale('').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    sma20Line = chart.addLineSeries({ color: '#fbbf24', lineWidth: 1, title: 'SMA 20' });
    ema50Line = chart.addLineSeries({ color: '#6366f1', lineWidth: 1, title: 'EMA 50' });
    predictionSeries = chart.addLineSeries({ color: '#22d3ee', lineWidth: 2, lineStyle: LightweightCharts.LineStyle.Dashed, title: 'AI Forecast' });

    rsiChart = LightweightCharts.createChart(rsiContainer, {
      layout: { background: { color: colors.bg }, textColor: colors.text, fontSize: 10 },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      timeScale: { borderColor: colors.border, timeVisible: true },
      rightPriceScale: { borderColor: colors.border },
    });
    rsiSeries = rsiChart.addLineSeries({ color: '#a78bfa', lineWidth: 1.5, title: 'RSI(14)' });
    rsiSeries.createPriceLine({ price: 70, color: 'rgba(255,77,106,0.4)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: false });
    rsiSeries.createPriceLine({ price: 30, color: 'rgba(0,214,143,0.4)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: false });
    rsiChart.priceScale().applyOptions({ autoScale: false, scaleMargins: { top: 0.1, bottom: 0.1 }, minValue: 0, maxValue: 100 });

    chart.timeScale().subscribeVisibleLogicalRangeChange(range => { if (range) rsiChart.timeScale().setVisibleLogicalRange(range); });
    rsiChart.timeScale().subscribeVisibleLogicalRangeChange(range => { if (range) chart.timeScale().setVisibleLogicalRange(range); });

    new ResizeObserver(() => {
      chart.resize(mainContainer.clientWidth, mainContainer.clientHeight);
      rsiChart.resize(rsiContainer.clientWidth, rsiContainer.clientHeight);
    }).observe(document.querySelector('.chart-container-wrapper'));
  }

  function updateChartTheme() {
    const colors = getChartColors();
    if (chart) {
      chart.applyOptions({
        layout: { background: { color: colors.bg }, textColor: colors.text },
        grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
        rightPriceScale: { borderColor: colors.border },
        timeScale: { borderColor: colors.border }
      });
    }
    if (rsiChart) {
      rsiChart.applyOptions({
        layout: { background: { color: colors.bg }, textColor: colors.text },
        grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
        rightPriceScale: { borderColor: colors.border },
        timeScale: { borderColor: colors.border }
      });
    }
    Object.values(miniCharts).forEach(mc => {
      if (mc.chart) {
        mc.chart.applyOptions({
          layout: { background: { color: colors.bg }, textColor: colors.text },
          grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
        });
      }
    });
  }

  // ==================== S&R LINES ====================
  function updateChartSrLines(srLevels) {
    if (srLevels) lastSrLevels = srLevels;
    srLines.forEach(line => candlestickSeries.removePriceLine(line));
    srLines = [];
    if (!showSrLines || !lastSrLevels) return;

    const isLight = document.body.classList.contains('light-theme');
    const supportColor = isLight ? 'rgba(0, 214, 143, 0.7)' : 'rgba(0, 214, 143, 0.5)';
    const resistanceColor = isLight ? 'rgba(255, 77, 106, 0.7)' : 'rgba(255, 77, 106, 0.5)';

    if (lastSrLevels.supports) {
      [...lastSrLevels.supports].sort((a, b) => b - a).forEach((level, idx) => {
        srLines.push(candlestickSeries.createPriceLine({
          price: level, color: supportColor, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: `S${idx + 1}`,
        }));
      });
    }
    if (lastSrLevels.resistances) {
      [...lastSrLevels.resistances].sort((a, b) => a - b).forEach((level, idx) => {
        srLines.push(candlestickSeries.createPriceLine({
          price: level, color: resistanceColor, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: `R${idx + 1}`,
        }));
      });
    }
  }

  // ==================== MULTI-TIMEFRAME MINI CHARTS ====================
  function initMiniCharts() {
    const timeframes = ['5m', '1h', '1d'];
    timeframes.forEach(tf => {
      const container = document.getElementById(`mini-chart-${tf}`);
      if (!container) return;
      container.innerHTML = '';
      const colors = getChartColors();
      const miniChart = LightweightCharts.createChart(container, {
        layout: { background: { color: colors.bg }, textColor: colors.text, fontSize: 9 },
        grid: { vertLines: { visible: false }, horzLines: { visible: false } },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        timeScale: { visible: false },
        rightPriceScale: { visible: false },
        handleScroll: false,
        handleScale: false,
      });
      const areaSeries = miniChart.addAreaSeries({
        topColor: 'rgba(99, 102, 241, 0.3)',
        bottomColor: 'rgba(99, 102, 241, 0.02)',
        lineColor: '#6366f1',
        lineWidth: 1.5,
      });
      miniCharts[tf] = { chart: miniChart, series: areaSeries };

      new ResizeObserver(() => {
        miniChart.resize(container.clientWidth, container.clientHeight);
      }).observe(container);
    });
  }

  async function fetchMultiTimeframeData(symbol, type) {
    try {
      const res = await fetch(`/api/stock/multiframes?symbol=${encodeURIComponent(symbol)}&type=${type}`);
      const data = await res.json();
      if (data.error) return;

      const timeframes = data.timeframes || {};
      Object.entries(timeframes).forEach(([tf, quotes]) => {
        if (!miniCharts[tf] || !quotes || quotes.length === 0) return;

        const lineData = quotes.map(q => ({ time: Math.floor(q.time / 1000), value: q.close })).sort((a, b) => a.time - b.time);

        if (lineData.length > 0) {
          miniCharts[tf].series.setData(lineData);
          miniCharts[tf].chart.timeScale().fitContent();

          const prices = lineData.map(d => d.value);
          const first = prices[0];
          const last = prices[prices.length - 1];
          const isBullish = last >= first;

          const smaPeriod = Math.min(20, prices.length);
          const sum = prices.slice(-smaPeriod).reduce((a,b)=>a+b,0);
          const avg = sum / smaPeriod;
          const trend = last > avg ? 'Bullish' : 'Bearish';

          const rsiArr = calculateRSI(prices, 14);
          const currentRsi = rsiArr[rsiArr.length - 1] || 50;

          const topColor = isBullish ? 'rgba(0, 214, 143, 0.3)' : 'rgba(255, 77, 106, 0.3)';
          const bottomColor = isBullish ? 'rgba(0, 214, 143, 0.02)' : 'rgba(255, 77, 106, 0.02)';
          const lineColor = isBullish ? '#00d68f' : '#ff4d6a';

          miniCharts[tf].series.applyOptions({ topColor, bottomColor, lineColor });

          const signalEl = document.getElementById(`mf-signal-${tf}`);
          if (signalEl) {
            const pctChange = ((last - first) / first) * 100;
            let signal = 'HOLD';
            if (pctChange > 0.5) signal = 'BUY';
            else if (pctChange < -0.5) signal = 'SELL';
            signalEl.textContent = signal;
            signalEl.className = `tf-signal badge badge-${signal.toLowerCase()}`;
          }

          const trendEl = document.getElementById(`mf-trend-${tf}`);
          if (trendEl) {
              trendEl.textContent = trend;
              trendEl.className = `val ${isBullish ? 'green' : 'red'}`;
          }
          
          const rsiEl = document.getElementById(`mf-rsi-${tf}`);
          if (rsiEl) {
              rsiEl.textContent = currentRsi.toFixed(1);
              rsiEl.className = `val ${currentRsi > 70 ? 'red' : (currentRsi < 30 ? 'green' : '')}`;
          }
        }
      });
    } catch (err) {
      console.log('Multi-timeframe fetch failed:', err.message);
    }
  }

  // ==================== NEWS SYSTEM & SENTIMENT ====================
  async function fetchNewsForSymbol(symbol) {
    const newsFeed = document.getElementById('news-feed');
    const newsStatus = document.getElementById('news-status');
    newsFeed.innerHTML = '<div class="news-loading"><i class="fa-solid fa-spinner fa-spin"></i><span>Loading news...</span></div>';
    newsStatus.style.display = 'none';

    try {
      const res = await fetch(`/api/stock/news?symbol=${encodeURIComponent(symbol)}`);
      const data = await res.json();
      if (data.error) {
        newsFeed.innerHTML = '<div class="news-empty"><i class="fa-solid fa-exclamation-circle"></i><span>No news available</span></div>';
        return;
      }

      newsData = data.categorizedNews;
      activeNewsCategory = 'all';

      if (data.sentiment) {
        document.getElementById('sentiment-text').textContent = `${data.sentiment.label} (${data.sentiment.score}%)`;
        document.getElementById('sentiment-bar').style.width = `${data.sentiment.score}%`;
        const driversList = document.getElementById('sentiment-drivers');
        driversList.innerHTML = data.sentiment.drivers.map(d => `<li>${d}</li>`).join('');
        
        document.getElementById('sentiment-text').className = data.sentiment.score >= 60 ? 'green-text' : (data.sentiment.score <= 40 ? 'red-text' : '');
      }

      const allCount = (newsData.dealsAndFunding?.length || 0) + (newsData.meetingsAndCorporate?.length || 0) + (newsData.improvementsAndUpgrades?.length || 0) + (newsData.general?.length || 0);
      document.getElementById('news-count-all').textContent = allCount;
      document.getElementById('news-count-deals').textContent = newsData.dealsAndFunding?.length || 0;
      document.getElementById('news-count-meetings').textContent = newsData.meetingsAndCorporate?.length || 0;
      document.getElementById('news-count-improvements').textContent = newsData.improvementsAndUpgrades?.length || 0;
      document.getElementById('news-count-general').textContent = newsData.general?.length || 0;

      document.querySelectorAll('.news-tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelector('.news-tab-btn[data-category="all"]').classList.add('active');

      renderNewsFeed('all');
      newsStatus.style.display = 'flex';
    } catch (err) {
      newsFeed.innerHTML = '<div class="news-empty"><i class="fa-solid fa-satellite-dish"></i><span>Failed to load news</span></div>';
    }
  }

  function renderNewsFeed(category) {
    const newsFeed = document.getElementById('news-feed');
    if (!newsData) {
      newsFeed.innerHTML = '<div class="news-empty"><i class="fa-solid fa-satellite-dish"></i><span>Select an asset to load news</span></div>';
      return;
    }

    let articles = [];
    const categoryLabels = {
      dealsAndFunding: { label: 'Deal', class: 'deals' },
      meetingsAndCorporate: { label: 'Meeting', class: 'meetings' },
      improvementsAndUpgrades: { label: 'Growth', class: 'improvements' },
      general: { label: 'General', class: 'general' },
    };

    if (category === 'all') {
      Object.entries(newsData).forEach(([cat, items]) => {
        (items || []).forEach(item => articles.push({ ...item, _category: cat }));
      });
    } else {
      (newsData[category] || []).forEach(item => articles.push({ ...item, _category: category }));
    }

    articles.sort((a, b) => {
      const pubA = a.providerPublishTime;
      const pubB = b.providerPublishTime;
      const dateA = pubA ? new Date(typeof pubA === 'number' ? pubA * 1000 : pubA) : new Date(0);
      const dateB = pubB ? new Date(typeof pubB === 'number' ? pubB * 1000 : pubB) : new Date(0);
      return dateB - dateA;
    });

    if (articles.length === 0) {
      newsFeed.innerHTML = '<div class="news-empty"><i class="fa-solid fa-newspaper"></i><span>No articles in this category</span></div>';
      return;
    }

    newsFeed.innerHTML = articles.map(article => {
      const catInfo = categoryLabels[article._category] || { label: 'News', class: 'general' };
      const pubTime = article.providerPublishTime;
      const dateObj = pubTime ? new Date(typeof pubTime === 'number' ? pubTime * 1000 : pubTime) : null;
      const date = dateObj ? formatNewsDate(dateObj) : '';
      const publisher = article.publisher || '';
      const link = article.link || '#';

      return `
        <div class="news-item" onclick="window.open('${link}', '_blank')" title="Open article">
          <div class="news-item-header">
            <span class="news-item-title">${escapeHtml(article.title || 'Untitled')}</span>
            <span class="news-category-badge ${catInfo.class}">${catInfo.label}</span>
          </div>
          <div class="news-item-meta">
            <span class="publisher">${escapeHtml(publisher)}</span>
            ${date ? `<span>•</span><span>${date}</span>` : ''}
          </div>
        </div>`;
    }).join('');
  }

  function formatNewsDate(date) {
    const now = new Date();
    const diffMs = now - date;
    const diffHrs = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffHrs < 1) return `${Math.floor(diffMs / (1000 * 60))}m ago`;
    if (diffHrs < 24) return `${diffHrs}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  document.querySelectorAll('.news-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.news-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeNewsCategory = btn.getAttribute('data-category');
      renderNewsFeed(activeNewsCategory);
      triggerSound('click');
    });
  });

  // ==================== STREAM LISTENERS ====================
  socket.on('history', (data) => {
    if (data.symbol !== currentSymbol || data.interval !== currentTimeframe) return;
    chartWatermark.textContent = `${data.symbol} · ${data.interval.toUpperCase()}`;

    candlestickSeries.setData(data.candles.map(c => ({ time: c.time / 1000, open: c.open, high: c.high, low: c.low, close: c.close })));
    volumeSeries.setData(data.candles.map(c => ({ time: c.time / 1000, value: c.volume, color: c.close >= c.open ? 'rgba(0, 214, 143, 0.15)' : 'rgba(255, 77, 106, 0.15)' })));
    sma20Line.setData(data.candles.filter(c => c.sma20 !== null).map(c => ({ time: c.time / 1000, value: c.sma20 })));
    ema50Line.setData(data.candles.filter(c => c.ema50 !== null).map(c => ({ time: c.time / 1000, value: c.ema50 })));
    rsiSeries.setData(data.candles.filter(c => c.rsi !== null).map(c => ({ time: c.time / 1000, value: c.rsi })));
    if (data.predictions) predictionSeries.setData(data.predictions.map(p => ({ time: p.time / 1000, value: p.value })));

    updateChartSrLines(data.srLevels);
    handlePriceUpdate(data.candles[data.candles.length - 1].close);
    updateAISignalsUI(data.aiAnalysis, data.srLevels);

    if (shouldSpeakReport) { setTimeout(() => speakVoiceReport(data.aiAnalysis, data.srLevels), 500); shouldSpeakReport = false; }
    chartLoader.style.opacity = '0'; chartLoader.style.pointerEvents = 'none';
  });

  socket.on('tick', (data) => {
    if (data.symbol !== currentSymbol || data.interval !== currentTimeframe) return;
    const c = data.candle, t = c.time / 1000;
    
    const currentRsi = c.rsi;
    if (currentRsi > 70 && prevRsi <= 70) triggerSystemAlert('Overbought Warning', `${data.symbol} RSI crossed 70. Reversal likely.`, 'warning');
    if (currentRsi < 30 && prevRsi >= 30) triggerSystemAlert('Oversold Alert', `${data.symbol} RSI dropped below 30. Rebound possible.`, 'success');
    
    if (data.srLevels && data.srLevels.resistances.length) {
      const topRes = data.srLevels.resistances[0];
      if (c.close > topRes && prevPrice <= topRes) {
        triggerSystemAlert('Breakout Detected', `${data.symbol} broke resistance at $${topRes}`, 'success');
      }
    }
    prevRsi = currentRsi || prevRsi;
    prevPrice = c.close;

    candlestickSeries.update({ time: t, open: c.open, high: c.high, low: c.low, close: c.close });
    volumeSeries.update({ time: t, value: c.volume, color: c.close >= c.open ? 'rgba(0, 214, 143, 0.15)' : 'rgba(255, 77, 106, 0.15)' });
    if (c.sma20) sma20Line.update({ time: t, value: c.sma20 });
    if (c.ema50) ema50Line.update({ time: t, value: c.ema50 });
    if (c.rsi) rsiSeries.update({ time: t, value: c.rsi });
    if (data.predictions) predictionSeries.setData(data.predictions.map(p => ({ time: p.time / 1000, value: p.value })));

    updateChartSrLines(data.srLevels);
    handlePriceUpdate(c.close);
    updateAISignalsUI(data.aiAnalysis, data.srLevels);
  });

  // ==================== PRICE & AI SIGNAL UI ====================
  function handlePriceUpdate(price) {
    currentPrice = price;
    livePriceMain.textContent = price.toFixed(price > 100 ? 2 : 4);
    document.title = `[${currentSymbol} $${price.toFixed(2)}] Finsight AI`;

    if (lastPrice > 0) {
      const diff = price - lastPrice, pct = (diff / lastPrice) * 100;
      liveChangePct.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
      liveChangePct.className = `price-change-pct ${pct >= 0 ? 'green' : 'red'}`;
      livePriceMain.className = `price-val ${diff > 0 ? 'green' : 'red'}`;
      setTimeout(() => livePriceMain.className = 'price-val', 350);
    }
    lastPrice = price;
    updateUnrealizedPnL();
  }

  function updateAISignalsUI(ai, sr) {
    signalBadge.textContent = ai.signal;
    signalBadge.className = `signal-indicator ${ai.signal.toLowerCase()}`;
    signalConfidence.textContent = ai.confidence;
    signalStrength.textContent = ai.marketStrength;
    if (ai.sentiment) {
      volatilityVal.textContent = ai.sentiment.volatility + '%';
    }

    const setupContainer = document.getElementById('trade-setup-container');
    if (ai.setup) {
      setupContainer.style.display = 'block';
      document.getElementById('setup-type').textContent = `${ai.setup.type} ${currentSymbol.replace('USDT','')}`;
      document.getElementById('setup-conf').textContent = ai.setup.confidence;
      document.getElementById('setup-entry').textContent = ai.setup.entry.toFixed(currentPrice > 100 ? 2 : 4);
      document.getElementById('setup-tp1').textContent = ai.setup.tp1;
      document.getElementById('setup-tp2').textContent = ai.setup.tp2;
      document.getElementById('setup-sl').textContent = ai.setup.sl;
      
      aiSuggestedTp = ai.setup.tp1;
      aiSuggestedSl = ai.setup.sl;
    } else {
      setupContainer.style.display = 'none';
      aiSuggestedTp = 0;
      aiSuggestedSl = 0;
    }

    aiExplanationsList.innerHTML = '';
    const ul = document.createElement('ul');
    ai.explanations.forEach(exp => {
      const li = document.createElement('li');
      li.textContent = exp; 
      ul.appendChild(li);
    });
    aiExplanationsList.appendChild(ul);

    resistancesList.innerHTML = '';
    if (sr.resistances.length) {
      sr.resistances.slice().reverse().forEach(r => {
        const li = document.createElement('li');
        li.textContent = r.toFixed(2);
        resistancesList.appendChild(li);
      });
    } else {
      resistancesList.innerHTML = '<li>--</li>';
    }

    supportsList.innerHTML = '';
    if (sr.supports.length) {
      sr.supports.forEach(s => {
        const li = document.createElement('li');
        li.textContent = s.toFixed(2);
        supportsList.appendChild(li);
      });
    } else {
      supportsList.innerHTML = '<li>--</li>';
    }
    updateHeatmapMatrix(ai.rsiValue, ai.signal);
  }

  function updateHeatmapMatrix(rsi, activeSignal) {
    const levels = [{ id: '1m', off: 0 }, { id: '5m', off: 3 }, { id: '15m', off: -5 }, { id: '1h', off: 8 }, { id: '1d', off: -12 }];
    levels.forEach(lvl => {
      const cell = document.getElementById(`matrix-${lvl.id}`);
      if (!cell) return;
      let tfRsi = rsi + lvl.off, tfSig = 'HOLD';
      if (tfRsi < 35) tfSig = 'BUY'; else if (tfRsi > 65) tfSig = 'SELL';
      if (lvl.id === currentTimeframe) tfSig = activeSignal;
      cell.textContent = tfSig;
      cell.className = `badge badge-${tfSig.toLowerCase()}`;
    });
  }

  // ==================== PORTFOLIO ====================
  orderLeverage.addEventListener('input', (e) => leverageVal.textContent = e.target.value + 'x');
  suggestTpBtn.addEventListener('click', (e) => { e.preventDefault(); if (aiSuggestedTp) { orderTp.value = aiSuggestedTp; showToast('AI TP Applied', 'info'); } });
  suggestSlBtn.addEventListener('click', (e) => { e.preventDefault(); if (aiSuggestedSl) { orderSl.value = aiSuggestedSl; showToast('AI SL Applied', 'info'); } });

  submitOrderBtn.addEventListener('click', () => {
    const amount = parseFloat(orderAmount.value), tp = parseFloat(orderTp.value) || 0, sl = parseFloat(orderSl.value) || 0, lev = parseInt(orderLeverage.value);
    if (isNaN(amount) || amount <= 0) return showToast('Invalid size.', 'error');
    if (currentPrice === 0) return showToast('Waiting for live price.', 'error');
    socket.emit('submit_order', { symbol: currentSymbol, type: currentOrderType, leverage: lev, amount, currentPrice, customTp: tp, customSl: sl });
  });

  orderTypeBuy.addEventListener('click', () => { currentOrderType = 'BUY'; triggerSound('click'); orderTypeBuy.classList.add('active'); orderTypeSell.classList.remove('active'); });
  orderTypeSell.addEventListener('click', () => { currentOrderType = 'SELL'; triggerSound('click'); orderTypeSell.classList.add('active'); orderTypeBuy.classList.remove('active'); });

  socket.on('portfolio_update', (data) => { portfolioData = data; renderPortfolioUI(); });
  socket.on('portfolio_event', (evt) => {
    if (evt.type === 'ORDER_FILLED') { showToast(evt.message, 'success'); orderTp.value = ''; orderSl.value = ''; }
    else if (evt.type === 'ORDER_REJECTED' || evt.type === 'LIQUIDATED') showToast(evt.message, 'error');
    else showToast(evt.message, 'info');
    if (evt.portfolio) { portfolioData = evt.portfolio; renderPortfolioUI(); }
  });

  function renderPortfolioUI() {
    portBalance.textContent = `$${portfolioData.balance.toFixed(2)}`;
    portMarginUsed.textContent = `$${portfolioData.marginUsed.toFixed(2)}`;
    portTradesCount.textContent = portfolioData.history.length;

    positionsTable.innerHTML = '';
    if (portfolioData.positions.length === 0) positionsTable.innerHTML = '<tr class="placeholder-row"><td colspan="8">No active positions.</td></tr>';
    else portfolioData.positions.forEach(pos => {
      let pnl = pos.type === 'BUY' ? (currentPrice - pos.entryPrice) * pos.amount : (pos.entryPrice - currentPrice) * pos.amount;
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${pos.symbol}</td><td><span class="badge-order-type ${pos.type.toLowerCase()}">${pos.type}</span></td><td>${pos.amount} / <b>${pos.leverage}x</b></td><td>$${pos.entryPrice.toFixed(2)}</td><td class="warning-text">$${pos.liqPrice.toFixed(2)}</td><td>$${currentPrice.toFixed(2)}</td><td class="${pnl >= 0 ? 'green' : 'red'}">$${pnl.toFixed(2)}</td><td><button class="close-pos-btn" data-id="${pos.id}">CLOSE</button></td>`;
      positionsTable.appendChild(tr);
    });
    document.querySelectorAll('.close-pos-btn').forEach(btn => btn.addEventListener('click', (e) => socket.emit('close_position', { id: e.target.getAttribute('data-id'), currentPrice })));

    historyTable.innerHTML = '';
    if (portfolioData.history.length === 0) historyTable.innerHTML = '<tr class="placeholder-row"><td colspan="8">No trade history.</td></tr>';
    else portfolioData.history.forEach(trade => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${trade.id}</td><td>${trade.symbol}</td><td><span class="badge-order-type ${trade.type.toLowerCase()}">${trade.type}</span></td><td>${trade.amount}</td><td>$${trade.entryPrice.toFixed(2)}</td><td>$${trade.exitPrice.toFixed(2)}</td><td><span class="badge badge-hold" style="font-size:9px;">${trade.exitReason}</span></td><td class="${trade.pnl >= 0 ? 'green' : 'red'}">$${trade.pnl.toFixed(2)}</td>`;
      historyTable.appendChild(tr);
    });
    updateUnrealizedPnL();
  }

  function updateUnrealizedPnL() {
    let totalUnrealized = 0;
    portfolioData.positions.forEach(pos => {
      totalUnrealized += pos.type === 'BUY' ? (currentPrice - pos.entryPrice) * pos.amount : (pos.entryPrice - currentPrice) * pos.amount;
    });
    const equity = portfolioData.balance + portfolioData.marginUsed + totalUnrealized;
    portEquity.textContent = `$${equity.toFixed(2)}`;
    portUnrealized.textContent = `$${totalUnrealized.toFixed(2)}`;
    portUnrealized.className = `val ${totalUnrealized >= 0 ? 'green' : 'red'}`;
  }

  // ==================== ASSET DICTIONARY & VOICE ====================
  const assetMap = {
    'bitcoin': { symbol: 'BTCUSDT', type: 'crypto' }, 'btc': { symbol: 'BTCUSDT', type: 'crypto' },
    'ethereum': { symbol: 'ETHUSDT', type: 'crypto' }, 'eth': { symbol: 'ETHUSDT', type: 'crypto' }, 'ether': { symbol: 'ETHUSDT', type: 'crypto' },
    'solana': { symbol: 'SOLUSDT', type: 'crypto' }, 'sol': { symbol: 'SOLUSDT', type: 'crypto' },
    'ripple': { symbol: 'XRPUSDT', type: 'crypto' }, 'xrp': { symbol: 'XRPUSDT', type: 'crypto' },
    'cardano': { symbol: 'ADAUSDT', type: 'crypto' }, 'ada': { symbol: 'ADAUSDT', type: 'crypto' },
    'dogecoin': { symbol: 'DOGEUSDT', type: 'crypto' }, 'doge': { symbol: 'DOGEUSDT', type: 'crypto' },
    'binance': { symbol: 'BNBUSDT', type: 'crypto' }, 'bnb': { symbol: 'BNBUSDT', type: 'crypto' },
    'polkadot': { symbol: 'DOTUSDT', type: 'crypto' }, 'dot': { symbol: 'DOTUSDT', type: 'crypto' },
    'shiba': { symbol: 'SHIBUSDT', type: 'crypto' }, 'shib': { symbol: 'SHIBUSDT', type: 'crypto' }, 'shiba inu': { symbol: 'SHIBUSDT', type: 'crypto' },
    'polygon': { symbol: 'MATICUSDT', type: 'crypto' }, 'matic': { symbol: 'MATICUSDT', type: 'crypto' },
    'litecoin': { symbol: 'LTCUSDT', type: 'crypto' }, 'ltc': { symbol: 'LTCUSDT', type: 'crypto' },
    'chainlink': { symbol: 'LINKUSDT', type: 'crypto' }, 'link': { symbol: 'LINKUSDT', type: 'crypto' },
    'uniswap': { symbol: 'UNIUSDT', type: 'crypto' }, 'uni': { symbol: 'UNIUSDT', type: 'crypto' },
    'avalanche': { symbol: 'AVAXUSDT', type: 'crypto' }, 'avax': { symbol: 'AVAXUSDT', type: 'crypto' },
    'stellar': { symbol: 'XLMUSDT', type: 'crypto' }, 'xlm': { symbol: 'XLMUSDT', type: 'crypto' },
    'apple': { symbol: 'AAPL', type: 'stock' }, 'aapl': { symbol: 'AAPL', type: 'stock' },
    'tesla': { symbol: 'TSLA', type: 'stock' }, 'tsla': { symbol: 'TSLA', type: 'stock' },
    'microsoft': { symbol: 'MSFT', type: 'stock' }, 'msft': { symbol: 'MSFT', type: 'stock' },
    'google': { symbol: 'GOOG', type: 'stock' }, 'goog': { symbol: 'GOOG', type: 'stock' }, 'googl': { symbol: 'GOOG', type: 'stock' }, 'alphabet': { symbol: 'GOOG', type: 'stock' },
    'nvidia': { symbol: 'NVDA', type: 'stock' }, 'nvda': { symbol: 'NVDA', type: 'stock' },
    'amazon': { symbol: 'AMZN', type: 'stock' }, 'amzn': { symbol: 'AMZN', type: 'stock' },
    'meta': { symbol: 'META', type: 'stock' }, 'facebook': { symbol: 'META', type: 'stock' },
    'netflix': { symbol: 'NFLX', type: 'stock' }, 'nflx': { symbol: 'NFLX', type: 'stock' },
    'amd': { symbol: 'AMD', type: 'stock' },
    'intel': { symbol: 'INTC', type: 'stock' }, 'intc': { symbol: 'INTC', type: 'stock' },
    'berkshire': { symbol: 'BRK-B', type: 'stock' }, 'berkshire hathaway': { symbol: 'BRK-B', type: 'stock' }, 'brk': { symbol: 'BRK-B', type: 'stock' },
    'eli lilly': { symbol: 'LLY', type: 'stock' }, 'lly': { symbol: 'LLY', type: 'stock' },
    'broadcom': { symbol: 'AVGO', type: 'stock' }, 'avgo': { symbol: 'AVGO', type: 'stock' },
    'jpmorgan': { symbol: 'JPM', type: 'stock' }, 'jp morgan': { symbol: 'JPM', type: 'stock' }, 'jpm': { symbol: 'JPM', type: 'stock' },
    'visa': { symbol: 'V', type: 'stock' }, 'v': { symbol: 'V', type: 'stock' },
    'sp 500': { symbol: 'SPY', type: 'stock' }, 's and p 500': { symbol: 'SPY', type: 'stock' },
    's&p 500': { symbol: 'SPY', type: 'stock' }, 's&p': { symbol: 'SPY', type: 'stock' },
    's and p': { symbol: 'SPY', type: 'stock' }, 'spy': { symbol: 'SPY', type: 'stock' },
    'nasdaq': { symbol: 'QQQ', type: 'stock' }, 'nasdaq 100': { symbol: 'QQQ', type: 'stock' }, 'qqq': { symbol: 'QQQ', type: 'stock' }
  };

  function parseVoiceCommand(transcript) {
    const cleanText = transcript.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "").trim();
    if (assetMap[cleanText]) return assetMap[cleanText];

    const patterns = [
      /report of\s+(.+)/i, /report for\s+(.+)/i, /report on\s+(.+)/i,
      /analyze\s+(.+)/i, /show\s+(.+)/i, /chart of\s+(.+)/i, /chart for\s+(.+)/i, /chart\s+(.+)/i,
      /(.+)\s+report/i, /(.+)\s+chart/i, /report\s+(.+)/i,
    ];

    for (let pattern of patterns) {
      const match = cleanText.match(pattern);
      if (match && match[1]) {
        let assetName = match[1].trim().replace(/\b(stock|crypto|coin|shares|currency|equity|index)\b/gi, "").trim();
        if (assetMap[assetName]) return assetMap[assetName];
        const ticker = assetName.toUpperCase().replace(/\s+/g, '');
        if (ticker.length > 0) return { symbol: ticker, type: ticker.endsWith('USDT') ? 'crypto' : 'stock' };
      }
    }

    const words = cleanText.split(/\s+/);
    if (words.length === 1 && words[0].length >= 2 && words[0].length <= 8) {
      const ticker = words[0].toUpperCase();
      return { symbol: ticker, type: ticker.endsWith('USDT') ? 'crypto' : 'stock' };
    }
    return null;
  }

  // ==================== CONTROLS ====================
  symbolSelect.addEventListener('change', (e) => {
    const type = e.target.options[e.target.selectedIndex].getAttribute('data-type');
    if (type === 'custom') document.getElementById('custom-symbol-wrapper').style.display = 'flex';
    else {
      document.getElementById('custom-symbol-wrapper').style.display = 'none';
      currentSymbol = e.target.value; currentSymbolType = type;
      orderUnit.textContent = currentSymbol.replace('USDT', '');
      orderAmount.value = currentSymbolType === 'stock' ? 10 : 0.1;
      requestSubscription(currentSymbol, currentTimeframe, currentSymbolType); triggerSound('click');
    }
  });

  document.getElementById('custom-symbol-apply').addEventListener('click', () => {
    const customInput = document.getElementById('custom-symbol-input');
    const inputVal = customInput.value.trim().toLowerCase();
    if (!inputVal) return showToast('Please type a valid ticker.', 'error');

    let foundAsset = assetMap[inputVal] || assetMap[inputVal.replace(/\b(stock|crypto|coin|shares)\b/gi, "").trim()];
    if (foundAsset) {
      currentSymbol = foundAsset.symbol;
      currentSymbolType = foundAsset.type;
      customInput.value = currentSymbol;
      document.getElementById('custom-symbol-type').value = currentSymbolType;
      showToast(`Resolved "${inputVal}" → ${currentSymbol}`, 'success');
    } else {
      currentSymbol = inputVal.toUpperCase().replace(/\s+/g, '');
      currentSymbolType = document.getElementById('custom-symbol-type').value;
    }
    orderUnit.textContent = currentSymbol.replace('USDT', '');
    requestSubscription(currentSymbol, currentTimeframe, currentSymbolType);
  });

  timeframeSelector.querySelectorAll('.tf-btn').forEach(btn => btn.addEventListener('click', (e) => {
    timeframeSelector.querySelector('.active').classList.remove('active'); e.target.classList.add('active');
    currentTimeframe = e.target.getAttribute('data-tf');
    requestSubscription(currentSymbol, currentTimeframe, currentSymbolType); triggerSound('click');
  }));

  document.querySelectorAll('.mini-chart-container').forEach(container => {
    container.addEventListener('click', () => {
      const tf = container.getAttribute('data-tf');
      timeframeSelector.querySelector('.active').classList.remove('active');
      const tfBtn = timeframeSelector.querySelector(`[data-tf="${tf}"]`);
      if (tfBtn) { tfBtn.classList.add('active'); currentTimeframe = tf; requestSubscription(currentSymbol, currentTimeframe, currentSymbolType); triggerSound('click'); }
    });
  });

  // ==================== TABS & BACKTESTER ====================
  document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', (e) => {
    document.querySelector('.tab-btn.active').classList.remove('active');
    document.querySelector('.tab-content.active').classList.remove('active');
    e.currentTarget.classList.add('active');
    document.getElementById(e.currentTarget.getAttribute('data-tab')).classList.add('active');
    triggerSound('click');
  }));

  document.getElementById('run-backtest-btn').addEventListener('click', (e) => {
    // Structural wrapper clean up before execution
    const placeholder = document.getElementById('backtest-placeholder') || document.querySelector('.backtest-placeholder');
    const oldResultsSection = document.getElementById('backtest-results-section');
    const newResultsGrid = document.querySelector('.backtest-results-grid');

    if (placeholder) placeholder.style.display = 'none';
    if (oldResultsSection) oldResultsSection.style.display = 'none';
    if (newResultsGrid) newResultsGrid.style.display = 'none';

    e.target.disabled = true; 
    e.target.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Simulating...';
    triggerSound('click');
    socket.emit('run_backtest', { symbol: currentSymbol, interval: currentTimeframe, strategy: document.getElementById('backtest-strategy').value, type: currentSymbolType });
  });

  // ======================================================= //
  // DEFENSIVE, ERROR-PROOF BACKTEST RESULTS HANDLER       //
  // ======================================================= //
  socket.on('backtest_results', (data) => {
    // Always release loading indicator button states cleanly first
    const btn = document.getElementById('run-backtest-btn');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-play"></i> Run Backtest';
    }

    // 1. Guard clause: If data is missing or success flag explicitly missing/false, break cleanly
    if (!data || data.error || (data.success === false)) {
      console.error("Backtest Execution Rejected:", data ? data.error : "No response payload received.");
      showToast(`Backtest failed: ${data && data.error ? data.error : 'Execution conditions unfulfilled'}`, 'error');
      return;
    }

    try {
      // 2. Defensive Number Parsing (Ensures safety from unexpected undefined/null parameters)
      const safeTrades = data.totalTrades !== undefined ? data.totalTrades : (data.tradesCount || 0);
      const safeWinRate = parseFloat(data.winRate || 0).toFixed(2);
      
      // Map cross-platform key variants for returns/profit layers safely
      const rawReturn = data.netProfit !== undefined ? data.netProfit : (data.totalReturn || 0);
      const safeReturn = parseFloat(rawReturn).toFixed(2);
      const safeROI = data.roi !== undefined ? data.roi : `${safeReturn}%`;
      const safeBalance = parseFloat(data.finalBalance || 0).toFixed(2);

      // 3. Dynamic layout state transformations
      const placeholder = document.getElementById('backtest-placeholder') || document.querySelector('.backtest-placeholder');
      const resultsSection = document.getElementById('backtest-results-section');
      const resultsGrid = document.querySelector('.backtest-results-grid');
      
      if (placeholder) placeholder.style.display = 'none';
      if (resultsSection) resultsSection.style.display = 'block';
      if (resultsGrid) {
        resultsGrid.style.display = 'grid';
        resultsGrid.classList.remove('hidden');
      }

      // 4. Element Extraction and Safe Inner-Text Interfacing
      const tradesEl = document.getElementById('bt-total-trades') || document.getElementById('bt-trades');
      const winrateEl = document.getElementById('bt-win-rate') || document.getElementById('bt-winrate');
      const ratioEl = document.getElementById('bt-ratio');
      const profitEl = document.getElementById('bt-profit') || document.getElementById('bt-return');
      const roiEl = document.getElementById('bt-roi');
      const balanceEl = document.getElementById('bt-balance');

      if (tradesEl) tradesEl.textContent = safeTrades;
      if (winrateEl) winrateEl.textContent = `${safeWinRate}%`;
      
      if (ratioEl) {
        const wins = data.wins || 0;
        const losses = data.losses || 0;
        ratioEl.textContent = `${wins}W / ${losses}L`;
      }

      if (profitEl) {
        profitEl.textContent = `${rawReturn >= 0 ? '+' : ''}$${safeReturn}`;
        profitEl.className = `val ${rawReturn >= 0 ? 'green' : 'red'}`;
        // Fallback styling compatibility logic
        if (profitEl.id === 'bt-return') {
          profitEl.innerText = `${safeReturn}%`;
          profitEl.style.color = rawReturn >= 0 ? 'var(--color-green)' : 'var(--color-red)';
        }
      }

      if (roiEl) {
        roiEl.textContent = safeROI;
        roiEl.className = `val ${rawReturn >= 0 ? 'green' : 'red'}`;
      }
      
      if (balanceEl) {
        balanceEl.innerText = `$${safeBalance}`;
      }

      // 5. Historical execution trades list parsing
      const tbody = document.getElementById('backtest-table')?.getElementsByTagName('tbody')[0];
      if (tbody) {
        tbody.innerHTML = '';
        const executionHistory = data.history || [];
        
        if (executionHistory.length === 0) {
          tbody.innerHTML = '<tr class="placeholder-row"><td colspan="6">Simulation finished with 0 recorded matches.</td></tr>';
        } else {
          executionHistory.forEach(trade => {
            const tr = document.createElement('tr');
            const tradePnL = trade.pnl !== undefined ? trade.pnl : 0;
            tr.innerHTML = `
              <td><span class="badge-order-type ${trade.type ? trade.type.toLowerCase() : 'hold'}">${trade.type || 'UNKNOWN'}</span></td>
              <td>$${parseFloat(trade.entryPrice || 0).toFixed(2)}</td>
              <td>$${parseFloat(trade.exitPrice || 0).toFixed(2)}</td>
              <td><span class="badge badge-hold" style="font-size:9px;">${escapeHtml(trade.exitReason || 'Target')}</span></td>
              <td class="${tradePnL >= 0 ? 'green' : 'red'}">$${parseFloat(tradePnL).toFixed(2)}</td>
              <td>${trade.time ? new Date(trade.time).toLocaleTimeString() : '--:--:--'}</td>`;
            tbody.appendChild(tr);
          });
        }
      }

      // 6. Push success confirmation toast overlay 
      showToast(`Backtest complete for ${data.symbol || currentSymbol}`, 'success');

    } catch (err) {
      console.error("Critical rendering exception within backtest payload module loop:", err);
    }
  });

  // ==================== VOICE RECOGNITION ====================
  let shouldSpeakReport = false, availableVoices = [];
  const voiceOverlay = document.getElementById('voice-overlay');

  if ('speechSynthesis' in window) {
    window.speechSynthesis.onvoiceschanged = () => { availableVoices = window.speechSynthesis.getVoices(); };
  }

  function speakFeedback(text) {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    if (availableVoices.length === 0) availableVoices = window.speechSynthesis.getVoices();
    const utterance = new SpeechSynthesisUtterance(text); utterance.rate = 1.05;
    const engVoice = availableVoices.find(v => v.lang.startsWith('en') && (v.name.includes('Google') || v.name.includes('Natural') || v.name.includes('Zira')));
    if (engVoice) utterance.voice = engVoice;
    window.speechSynthesis.speak(utterance);
  }

  function speakVoiceReport(ai, sr) {
    let script = `AI report for ${currentSymbol.replace('USDT', '')}. Current price is ${currentPrice.toFixed(2)}. `;
    script += `Signal is ${ai.signal}, classified as ${ai.marketStrength}. `;
    if (sr.supports && sr.supports.length > 0) script += `Nearest support at ${Math.max(...sr.supports).toFixed(2)}. `;
    if (sr.resistances && sr.resistances.length > 0) script += `Nearest resistance at ${Math.min(...sr.resistances).toFixed(2)}. `;
    speakFeedback(script);
  }

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  if (SpeechRecognition) {
    recognition = new SpeechRecognition(); recognition.continuous = false; recognition.lang = 'en-US';
    recognition.onstart = () => { document.getElementById('voice-mic-btn').classList.add('listening'); voiceOverlay.style.display = 'flex'; triggerSound('listen'); };
    recognition.onend = () => { document.getElementById('voice-mic-btn').classList.remove('listening'); voiceOverlay.style.display = 'none'; };

    recognition.onresult = (e) => {
      const transcript = e.results[0][0].transcript.toLowerCase().trim();
      console.log('Voice:', transcript);
      showToast(`Voice: "${transcript}"`, 'info');

      if (transcript.includes("new stocks") || transcript.includes("fresh stocks")) {
        speakFeedback("Active equities include Nvidia, Apple, Tesla, and Amazon.");
      } else {
        const foundAsset = parseVoiceCommand(transcript);
        if (foundAsset) {
          currentSymbol = foundAsset.symbol;
          currentSymbolType = foundAsset.type;
          symbolSelect.value = currentSymbol;
          if (symbolSelect.value !== currentSymbol) {
            symbolSelect.value = 'CUSTOM';
            document.getElementById('custom-symbol-wrapper').style.display = 'flex';
            document.getElementById('custom-symbol-input').value = currentSymbol;
            document.getElementById('custom-symbol-type').value = currentSymbolType;
          } else {
            document.getElementById('custom-symbol-wrapper').style.display = 'none';
          }
          orderUnit.textContent = currentSymbol.replace('USDT', '');
          orderAmount.value = currentSymbolType === 'stock' ? 10 : 0.1;
          shouldSpeakReport = true;
          showToast(`Routing to ${currentSymbol}...`, 'success');
          requestSubscription(currentSymbol, currentTimeframe, currentSymbolType);
        } else {
          speakFeedback("Please state a valid ticker like Apple or Bitcoin.");
        }
      }
    };
  }
  document.getElementById('voice-mic-btn').addEventListener('click', () => { if (recognition) recognition.start(); });
  document.getElementById('voice-cancel-btn').addEventListener('click', () => { if (recognition) recognition.stop(); });

  // ==================== THEME & S&R TOGGLE ====================
  const themeToggleBtn = document.getElementById('theme-toggle-btn');
  const srToggleBtn = document.getElementById('sr-toggle-btn');

  themeToggleBtn.addEventListener('click', () => {
    const isLight = document.body.classList.toggle('light-theme');
    themeToggleBtn.innerHTML = isLight ? '<i class="fa-solid fa-sun"></i>' : '<i class="fa-solid fa-moon"></i>';
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
    updateChartTheme();
    updateChartSrLines(lastSrLevels);
    triggerSound('click');
    showToast(`${isLight ? 'Light' : 'Dark'} Mode`, 'info');
  });

  srToggleBtn.addEventListener('click', () => {
    showSrLines = !showSrLines;
    localStorage.setItem('showSrLines', showSrLines);
    srToggleBtn.classList.toggle('active', showSrLines);
    srToggleBtn.innerHTML = showSrLines ? '<i class="fa-solid fa-eye"></i>' : '<i class="fa-solid fa-eye-slash"></i>';
    showToast(showSrLines ? 'S&R Zones Enabled' : 'S&R Zones Hidden', showSrLines ? 'success' : 'info');
    updateChartSrLines(lastSrLevels);
    triggerSound('click');
  });

  // ==================== LOAD SAVED PREFERENCES ====================
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme === 'light') {
    document.body.classList.add('light-theme');
    themeToggleBtn.innerHTML = '<i class="fa-solid fa-sun"></i>';
  }
  const savedSr = localStorage.getItem('showSrLines');
  if (savedSr === 'false') {
    showSrLines = false;
    srToggleBtn.classList.remove('active');
    srToggleBtn.innerHTML = '<i class="fa-solid fa-eye-slash"></i>';
  }

  // ==================== INIT ====================
  if (Notification && Notification.permission !== 'granted' && Notification.permission !== 'denied') {
    Notification.requestPermission();
  }

  initChart();
  initMiniCharts();
});

// ========================================== //
// NEW FEATURE: REMOVE LOADING SCREEN         //
// ========================================== //
window.addEventListener('load', () => {
  const loadingScreen = document.getElementById('initial-loading-screen');
  if (loadingScreen) {
    setTimeout(() => {
      loadingScreen.classList.add('hidden');
    }, 500); 
  }
});

// ========================================== //
// NEW FEATURE: MARKET NEWS MODAL CONTROLLER  //
// ========================================== //
window.addEventListener('DOMContentLoaded', () => {
  const openNewsBtn = document.getElementById('open-news-btn');
  const closeNewsBtn = document.getElementById('close-news-btn');
  const newsModal = document.getElementById('news-modal-overlay');

  if (openNewsBtn && closeNewsBtn && newsModal) {
    openNewsBtn.addEventListener('click', () => {
      newsModal.classList.remove('hidden');
    });

    closeNewsBtn.addEventListener('click', () => {
      newsModal.classList.add('hidden');
    });

    newsModal.addEventListener('click', (e) => {
      if (e.target === newsModal) {
        newsModal.classList.add('hidden');
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !newsModal.classList.contains('hidden')) {
        newsModal.classList.add('hidden');
      }
    });
  }
});

// ========================================== //
// NEW FEATURE: STANDALONE NEWS TERMINAL      //
// ========================================== //
window.addEventListener('DOMContentLoaded', () => {
  const newsTerminalIcon = document.getElementById('open-news-terminal-btn'); 

  if (newsTerminalIcon) {
    newsTerminalIcon.addEventListener('click', () => {
      const summaryItems = document.querySelectorAll('.summary-item');
      const activeSymbols = Array.from(summaryItems)
        .map(item => item.getAttribute('data-symbol')?.replace('USDT', ''))
        .filter(Boolean)
        .join(',');

      const querySymbols = activeSymbols || 'BTC';
      window.open(`/news.html?symbols=${querySymbols}`, '_blank', 'width=1300,height=850,resizable=yes,scrollbars=yes');
    });
  }
});