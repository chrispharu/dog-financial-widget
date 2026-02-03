require('dotenv').config(); // 載入環境變數
const line = require('@line/bot-sdk');
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const yahooFinance = require('yahoo-finance2').default;

// --- [Config] 設定檔 ---
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

// 初始化 LINE Client 和 Express App
const client = new line.Client(config);
const app = express();

// --- [Service Layer] 業務邏輯區 ---

/**
 * 服務 1: 抓取國泰世華即期賣出匯率 (無障礙網頁版)
 */
async function fetchCathayRate() {
  const TARGET_URL = 'https://accessibility.cathaybk.com.tw/exchange-rate-search.aspx';
  try {
    const response = await axios.get(TARGET_URL);
    const $ = cheerio.load(response.data);
    let targetRate = null;

    $('table tbody tr').each((index, element) => {
      const tds = $(element).find('td');
      if (tds.length >= 3) {
        const currencyName = $(tds[0]).text().trim();
        if (currencyName === '美元(USD)') {
          targetRate = $(tds[2]).text().trim(); // 即期賣出
          return false;
        }
      }
    });
    return targetRate;
  } catch (error) {
    console.error('匯率抓取失敗:', error.message);
    return null;
  }
}

/**
 * 服務 2: 抓取 QQQ 股價
 */
async function fetchQQQPrice() {
  try {
    const quote = await yahooFinance.quote('QQQ');
    return quote.regularMarketPrice;
  } catch (error) {
    console.error('股價抓取失敗:', error.message);
    return null;
  }
}

// --- [Controller Layer] 路由區 ---

// LINE Webhook 入口 (類似 Java 的 @PostMapping("/callback"))
app.post('/callback', line.middleware(config), (req, res) => {
  // 處理所有事件 (Promise.all 類似 Java CompletableFuture 的並行處理)
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// 事件處理器
async function handleEvent(event) {
  // 只處理文字訊息
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userText = event.message.text.trim();

  // 簡單的關鍵字判斷
  // 如果使用者輸入 "查詢"、"股價" 或 "QQQ"，就觸發查詢
  if (userText.includes('查詢') || userText.toUpperCase().includes('QQQ')) {
    
    // 平行執行兩個查詢任務，加快速度
    const [rate, stockPrice] = await Promise.all([
      fetchCathayRate(),
      fetchQQQPrice()
    ]);

    let replyText = '📊 您的查詢結果：\n';

    if (rate) {
      replyText += `\n🇹🇼 國泰美金賣出：${rate}`;
    } else {
      replyText += `\n🇹🇼 國泰匯率：暫時無法取得`;
    }

    if (stockPrice) {
      replyText += `\n🇺🇸 QQQ 股價：$${stockPrice}`;
    } else {
      replyText += `\n🇺🇸 QQQ 股價：暫時無法取得`;
    }

    // 如果兩個都抓到了，貼心幫算台幣成本
    if (rate && stockPrice) {
      const rateNum = parseFloat(rate);
      const costTWD = (stockPrice * rateNum).toLocaleString('zh-TW', { maximumFractionDigits: 0 });
      replyText += `\n----------------`;
      replyText += `\n💰 買一股約需台幣：$${costTWD}`;
    }

    // 回覆訊息
    return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
  }

  // 如果不是關鍵字，可以選擇已讀不回 (return null) 或回傳預設訊息
  return Promise.resolve(null);
}

// --- [Server Start] ---
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`listening on ${port}`);
});

