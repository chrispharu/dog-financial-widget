const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');

// [重要] v2 版正確引入方式
const yahooFinance = require('yahoo-finance2').default;

const app = express();
const PORT = 3000;
const CONFIG = {
    CACHE_TIME_PRICE: 60 * 1000, // 股價快取 60秒 (毫秒單位)
};
app.use(cors());
app.use(express.json());

// ==========================================
// 🛡️ YahooService: 爬蟲服務層 (抗封鎖核心)
// ==========================================
class YahooService {
    constructor() {
        this.quoteCache = {
            data: {},
            timestamp: 0
        };
    }
    // 偽裝 Header (axios 用)
    getHeaders() {
        return {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7'
        };
    }
    async fetchExchangeRates(targetCurrencies = []) {
        // 如果沒有指定，預設抓 USD
        const curList = (targetCurrencies.length > 0) ? targetCurrencies : ['USD'];

        // 轉換成 Yahoo 格式: USD -> USDTWD=X
        const symbols = curList.map(c => `${c}TWD=X`);
        const results = {};

        try {
            console.log(`[YahooService] 抓取匯率 (${symbols.length} 筆)...`);
            const quotes = await yahooFinance.quote(symbols, {}, {
                fetchOptions: { headers: { 'User-Agent': 'Mozilla/5.0' } }
            });

            const list = Array.isArray(quotes) ? quotes : [quotes];

            list.forEach(q => {
                // symbol 格式為 USDTWD=X，我們要取前三碼 USD 當 key
                const code = q.symbol.substring(0, 3);
                results[code] = {
                    price: q.regularMarketPrice || 0,
                    prevClose: q.regularMarketPreviousClose || 0
                };
            });
        } catch (e) {
            console.error('[YahooService] 匯率抓取失敗:', e.message);
            // 失敗時回傳 0，前端會顯示灰色
            curList.forEach(c => results[c] = { price: 0, prevClose: 0 });
        }
        return results;
    }
    // 抓國泰匯率已停用
    // async fetchExchangeRates() {
    //     const rates = { 'TWD': 1 };
    //     try {
    //         const { data } = await axios.get('https://accessibility.cathaybk.com.tw/exchange-rate-search.aspx', { headers: this.getHeaders() });
    //         const $ = cheerio.load(data);
    //         $('table tbody tr').each((i, el) => {
    //             const tds = $(el).find('td');
    //             if (tds.length >= 3) {
    //                 const name = $(tds[0]).text().trim();
    //                 const val = parseFloat($(tds[2]).text().trim());
    //                 const match = name.match(/\(([A-Z]+)\)/);
    //                 if (match && !isNaN(val)) rates[match[1]] = val;
    //             }
    //         });
    //     } catch (e) { console.error('[YahooService] 匯率失敗:', e.message); }
    //     return rates;
    // }

    async fetchGold() {
        let current = 0;
        let high = 0;      // [FIX] 用來存最高價
        let trendDiff = 0; // 用來決定紅綠色

        // ---------------------------------------------------------
        // 任務 1: 抓台銀 (BOT) - 取得「現價」與「本月最高價」
        // ---------------------------------------------------------
        try {
            // 1.1 抓即時牌價
            const { data: currentData } = await axios.get('https://rate.bot.com.tw/gold?Lang=zh-TW', { headers: this.getHeaders() });
            const $ = cheerio.load(currentData);
            current = parseFloat($('td.text-right').eq(1).text().trim()) || 0;

            // 1.2 [FIX] 把抓取歷史高點的邏輯加回來
            const { data: chartData } = await axios.get('https://rate.bot.com.tw/gold/chart/year/TWD', { headers: this.getHeaders() });

            if (chartData && chartData.nodes && chartData.nodes.length > 0) {
                const nodes = chartData.nodes;
                // 計算本月最高價
                const ym = new Date().toISOString().slice(0, 7).replace('-', ''); // 格式: YYYYMM
                const prices = nodes.filter(n => n.x.startsWith(ym)).map(n => parseFloat(n.y));

                if (prices.length > 0) {
                    high = Math.max(...prices);
                }
            }

            // 如果今天剛好創新高，圖表可能還沒更新，手動校正
            if (current > high) high = current;

        } catch (e) {
            console.error('[YahooService] 台銀資料(現價/圖表)抓取部分失敗:', e.message);
            // 如果圖表抓失敗，至少 high 要等於 current，才不會顯示 0
            if (high === 0) high = current;
        }

        // ---------------------------------------------------------
        // 任務 2: 抓 Yahoo - 取得「漲跌趨勢」 (決定紅綠色)
        // ---------------------------------------------------------
        try {
            const quotes = await yahooFinance.quote(['XAUTWD=X', 'GC=F'], {}, {
                fetchOptions: { headers: { 'User-Agent': 'Mozilla/5.0' } }
            });

            let q = null;
            if (Array.isArray(quotes)) {
                q = quotes.find(item => item.symbol === 'XAUTWD=X') || quotes.find(item => item.symbol === 'GC=F');
            } else {
                q = quotes;
            }

            if (q && q.regularMarketPrice) {
                const price = q.regularMarketPrice || 0;
                const prev = q.regularMarketPreviousClose || 0;
                trendDiff = price - prev;
                // console.log(`[Gold] 參考趨勢(${q.symbol}): ${trendDiff}`);
            }

        } catch (e) {
            console.error('[YahooService] 黃金趨勢抓取異常:', e.message);
        }

        // ---------------------------------------------------------
        // 回傳整合結果
        // ---------------------------------------------------------
        return {
            current,
            prevClose: current - trendDiff, // 逆推昨收，讓前端算出正確顏色
            high: high // [FIX] 回傳正確計算出的最高價
        };
    }

    async fetchQuotes(symbols) {
        const results = {};
        if (!symbols.length) return results;

        // [NEW] 1. 檢查快取：如果距離上次抓取還沒超過 60 秒，直接回傳舊資料
        const now = Date.now();
        if (now - this.quoteCache.timestamp < CONFIG.CACHE_TIME_PRICE) {
            // 檢查是否所有請求的股票都在快取裡 (簡單起見，只要快取有效就回傳，不夠的下一次再更新)
            console.log(`[YahooService] 使用快取股價 (效期剩餘 ${Math.round((CONFIG.CACHE_TIME_PRICE - (now - this.quoteCache.timestamp))/1000)} 秒)`);
            return this.quoteCache.data;
        }

        try {
            console.log(`[YahooService] 快取過期，重新連線 Yahoo (${symbols.length} 檔)...`);
            
            const quotes = await yahooFinance.quote(symbols, {}, { 
                fetchOptions: {
                    headers: { 
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7'
                    }
                }
            });

            const list = Array.isArray(quotes) ? quotes : [quotes];

            list.forEach(q => {
                const price = q.regularMarketPrice || 0;
                const prevClose = q.regularMarketPreviousClose || 0;

                results[q.symbol] = {
                    price: price,
                    prevClose: prevClose, // 昨收
                    high: q.regularMarketDayHigh || q.dayHigh || 0,
                    low: q.regularMarketDayLow || q.dayLow || 0,
                    currency: q.currency
                };
            });
            // [NEW] 2. 更新快取
            this.quoteCache.data = results;
            this.quoteCache.timestamp = now;
            
            console.log('[YahooService] 連線成功！快取已更新');

        } catch (e) {
            console.error('[YahooService] 連線異常:', e.message);
            // 失敗時回傳空物件，但不更新快取時間，讓下次請求能立即重試
            symbols.forEach(s => results[s] = { price: 0, prevClose: 0, high: 0, low: 0, currency: 'USD' });
        }
        return results;
    }
    async search(query) {
        if (!query) return { quotes: [] };

        // 判斷是否為「中文」或「純數字」(適合查台股)
        const isTwStockQuery = /[\u4e00-\u9fa5]/.test(query) || /^\d+$/.test(query);
        console.log(`[YahooService] 搜尋: "${query}" (台股模式: ${isTwStockQuery})`);

        // 策略 A: 臺灣證券交易所 (TWSE) 官方 API
        // 優點: 權威資料、支援中文、分辯上市(TW)/上櫃(TWO)、無 Yahoo 驗證問題
        const runTwseSearch = async () => {
            try {
                const url = `https://mis.twse.com.tw/stock/api/getStockNames.jsp?n=${encodeURIComponent(query)}&lang=zh_tw`;

                const { data } = await axios.get(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                });

                // TWSE 回傳結構: { "rtcode": "0000", "datas": [ { "c": "2881", "n": "富邦金", "t": "tse", ... } ] }
                if (data.datas && Array.isArray(data.datas)) {
                    console.log(`[YahooService] TWSE 官方 API 找到 ${data.datas.length} 筆`);

                    return {
                        quotes: data.datas.map(item => {
                            // t="tse" 為上市 (.TW), t="otc" 為上櫃 (.TWO)
                            const suffix = item.t === 'otc' ? '.TWO' : '.TW';
                            const symbol = `${item.c}${suffix}`;
                            return {
                                symbol: symbol,
                                shortname: item.n, // 中文名稱
                                longname: item.n,
                                exchange: item.t === 'otc' ? 'TWO' : 'TW',
                                isYahooFinance: true
                            };
                        })
                    };
                }
            } catch (e) {
                console.error('[YahooService] TWSE API 失敗:', e.message);
            }
            return null;
        };

        // 策略 B: Yahoo Finance 套件 (查美股用)
        const runYahooPackage = async () => {
            try {
                const result = await yahooFinance.search(query,
                    { quotesCount: 10, newsCount: 0 },
                    { fetchOptions: { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } } }
                );
                if (result.quotes && result.quotes.length > 0) return result;
            } catch (e) { /* 忽略 */ }
            return { quotes: [] };
        };

        // 決策路由
        if (isTwStockQuery) {
            // 如果是中文或數字，先問證交所 (最準)
            const twResult = await runTwseSearch();
            if (twResult && twResult.quotes.length > 0) return twResult;

            // 證交所沒找到 (例如輸入 0050 這種有時 TWSE 沒收錄)，再回頭問 Yahoo
            return await runYahooPackage();
        } else {
            // 如果是英文 (AAPL)，直接問 Yahoo
            return await runYahooPackage();
        }
    }
}

// ==========================================
// 💾 DataService: 資料存取層
// ==========================================
class DataService {
    constructor() {
        if (process.env.IS_ELECTRON) {
            this.dataFile = path.join(process.resourcesPath, 'watchlist.json');
        } else {
            this.dataFile = path.join(__dirname, 'watchlist.json');
        }

        this.defaultData = {
            stocks: [
                { symbol: 'QQQ', currency: 'USD', name: 'Invesco QQQ' },
                { symbol: '2330.TW', currency: 'TWD', name: '台積電' }
            ],
            currencies: ['USD', 'JPY'],
            inventory: []
        };
        console.log('[DataService] DB Path:', this.dataFile);
    }

    load() {
        try {
            if (fs.existsSync(this.dataFile)) {
                const raw = fs.readFileSync(this.dataFile, 'utf8');
                let json = JSON.parse(raw);
                if (Array.isArray(json)) json = { ...this.defaultData, stocks: json };

                let inventory = Array.isArray(json.inventory) ? json.inventory : [];
                // 資料遷移：確保有 shares 和 exchangeRate
                inventory = inventory.map(item => ({
                    ...item,
                    shares: item.shares ? parseFloat(item.shares) : 1,
                    exchangeRate: item.exchangeRate ? parseFloat(item.exchangeRate) : (item.symbol.includes('TW') ? 1 : 0) // 舊資料暫時補0或1
                }));

                return {
                    stocks: json.stocks || this.defaultData.stocks,
                    currencies: json.currencies || this.defaultData.currencies,
                    inventory
                };
            }
        } catch (e) { console.error('[DataService] Load Error:', e.message); }
        return JSON.parse(JSON.stringify(this.defaultData));
    }

    save(data) {
        try { fs.writeFileSync(this.dataFile, JSON.stringify(data, null, 2)); }
        catch (e) { console.error('[DataService] Save Error:', e.message); }
    }
}

// ==========================================
// 🚀 初始化與路由
// ==========================================
const db = new DataService();
const yahoo = new YahooService();
let USER_DATA = db.load();

async function fetchYahooName(symbol) {
    try {
        const url = `https://tw.stock.yahoo.com/quote/${symbol}`;
        const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const $ = cheerio.load(data);
        const title = $('meta[property="og:title"]').attr('content') || '';
        return title.split('(')[0].trim();
    } catch (e) { return null; }
}

// 1. 主數據 API
app.get('/api/data', async (req, res) => {
    try {
        const stocks = Array.isArray(USER_DATA.stocks) ? USER_DATA.stocks : [];
        const inventory = Array.isArray(USER_DATA.inventory) ? USER_DATA.inventory : [];
        const currencies = Array.isArray(USER_DATA.currencies) ? USER_DATA.currencies : ['USD'];

        const symbols = stocks.map(s => s.symbol);

        // 抓取資料
        const [ratesMap, gold, stockData] = await Promise.all([
            yahoo.fetchExchangeRates(currencies),
            yahoo.fetchGold(),
            yahoo.fetchQuotes(symbols)
        ]);

        // 計算庫存統計
        const stats = {};
        inventory.forEach(inv => {
            if (!inv.symbol) return;
            //  totalCostOriginal (原幣總成本)
            if (!stats[inv.symbol]) stats[inv.symbol] = { totalCostTWD: 0, totalCostOriginal: 0, totalShares: 0 };

            const p = parseFloat(inv.price) || 0;
            const s = parseFloat(inv.shares) || 0;

            let r = parseFloat(inv.exchangeRate);
            if (!r || r <= 0) {
                if (inv.symbol.includes('TW')) r = 1;
                else {
                    const rateObj = ratesMap['USD'];
                    r = rateObj ? rateObj.price : 32;
                }
            }

            if (p > 0 && s > 0) {
                stats[inv.symbol].totalCostTWD += (p * s * r); // 台幣總成本 (含匯率)
                stats[inv.symbol].totalCostOriginal += (p * s); //原幣總成本 (不含匯率)
                stats[inv.symbol].totalShares += s;
            }
        });

        // 組合 Portfolio
        const portfolio = stocks.map(s => {
            const mkt = stockData[s.symbol] || { price: 0, prevClose: 0, high: 0, low: 0 };
            const rateObj = ratesMap[s.currency];
            const ratePrice = rateObj ? rateObj.price : 1;

            const costTWD = Math.round(mkt.price * ratePrice);

            let avgCostTWD = 0; // 台幣均價
            let avgCost = 0;    // 原幣均價 (美股顯示 USD, 台股顯示 TWD)

            if (stats[s.symbol] && stats[s.symbol].totalShares > 0) {
                avgCostTWD = stats[s.symbol].totalCostTWD / stats[s.symbol].totalShares;
                //計算原幣均價 = 原幣總成本 / 總股數
                avgCost = stats[s.symbol].totalCostOriginal / stats[s.symbol].totalShares;
            }

            return {
                ...s,
                price: mkt.price,
                prevClose: mkt.prevClose,
                high: mkt.high,
                low: mkt.low,
                rate: ratePrice,
                costTWD,
                avgCostTWD, // 舊的 (台幣均價)
                avgCost,    // 新的 (原幣均價，前端顯示這個才準)
                link: s.symbol.includes('TW') ?
                    `https://tw.stock.yahoo.com/quote/${s.symbol}` :
                    `https://finance.yahoo.com/quote/${s.symbol}`
            };
        });

        res.json({
            updatedAt: new Date().toLocaleString('zh-TW', { hour12: false }),
            rates: ratesMap,
            gold,
            portfolio,
            inventory: inventory,
            currencyOrder: currencies
        });

    } catch (e) {
        console.error('[API Error] /api/data:', e);
        res.status(500).json({ error: e.message || '後端資料處理錯誤' });
    }
});

// 2. 庫存操作
app.post('/api/add-inventory', (req, res) => {
    const { symbol, price, shares, date, exchangeRate } = req.body;
    if (!USER_DATA.inventory) USER_DATA.inventory = [];

    USER_DATA.inventory.push({
        id: Date.now().toString(),
        symbol,
        price: parseFloat(price) || 0,
        shares: parseFloat(shares) || 0,
        exchangeRate: parseFloat(exchangeRate) || 1, // [NEW] 儲存匯率
        date: date || ''
    });
    db.save(USER_DATA);
    res.json({ success: true });
});

app.post('/api/remove-inventory', (req, res) => {
    USER_DATA.inventory = USER_DATA.inventory.filter(i => i.id !== req.body.id);
    db.save(USER_DATA);
    res.json({ success: true });
});

app.post('/api/remove-inventory-group', (req, res) => {
    USER_DATA.inventory = USER_DATA.inventory.filter(i => i.symbol !== req.body.symbol);
    db.save(USER_DATA);
    res.json({ success: true });
});

// 3. 股票操作
app.get('/api/search', async (req, res) => {
    const result = await yahoo.search(req.query.q);
    const data = result.quotes ? result.quotes
        .filter(q => q.isYahooFinance)
        .map(q => ({ symbol: q.symbol, name: q.shortname || q.symbol, exch: q.exchange }))
        : [];
    res.json({ results: data });
});

app.post('/api/add-stock', async (req, res) => {
    const { symbol } = req.body;
    if (USER_DATA.stocks.some(s => s.symbol === symbol)) return res.json({ success: false });

    let name = symbol, currency = 'USD';
    try {
        const quotes = await yahoo.fetchQuotes([symbol]);
        if (quotes[symbol]) currency = symbol.includes('TW') ? 'TWD' : 'USD';
    } catch (e) { }

    const chName = await fetchYahooName(symbol);
    if (chName) name = chName;

    USER_DATA.stocks.push({ symbol, name, currency });
    db.save(USER_DATA);
    res.json({ success: true });
});

app.post('/api/remove-stock', (req, res) => {
    USER_DATA.stocks = USER_DATA.stocks.filter(s => s.symbol !== req.body.symbol);
    db.save(USER_DATA);
    res.json({ success: true });
});

app.post('/api/rename-stock', (req, res) => {
    const s = USER_DATA.stocks.find(x => x.symbol === req.body.symbol);
    if (s) { s.name = req.body.newName; db.save(USER_DATA); }
    res.json({ success: true });
});

app.post('/api/reorder-stocks', (req, res) => {
    const { newOrder } = req.body;
    const next = [];
    newOrder.forEach(sym => {
        const found = USER_DATA.stocks.find(s => s.symbol === sym);
        if (found) next.push(found);
    });
    USER_DATA.stocks.forEach(s => { if (!next.find(x => x.symbol === s.symbol)) next.push(s); });
    USER_DATA.stocks = next;
    db.save(USER_DATA);
    res.json({ success: true });
});

// 4. 匯率操作
app.post('/api/add-currency', (req, res) => {
    const c = req.body.currency.toUpperCase();
    if (!USER_DATA.currencies.includes(c)) { USER_DATA.currencies.push(c); db.save(USER_DATA); }
    res.json({ success: true });
});
app.post('/api/remove-currency', (req, res) => {
    USER_DATA.currencies = USER_DATA.currencies.filter(c => c !== req.body.currency);
    db.save(USER_DATA);
    res.json({ success: true });
});
app.post('/api/reorder-currencies', (req, res) => {
    USER_DATA.currencies = req.body.newOrder;
    db.save(USER_DATA);
    res.json({ success: true });
});

app.listen(PORT, '0.0.0.0', () => console.log(`[Server] Running on ${PORT}`));