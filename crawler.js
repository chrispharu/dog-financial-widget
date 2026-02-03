const axios = require('axios');
const cheerio = require('cheerio');

// 🔥 關鍵改變：改用「無障礙網頁」，這裡是純 HTML 表格，不再依賴 JS 動態載入
const TARGET_URL = 'https://accessibility.cathaybk.com.tw/exchange-rate-search.aspx';

async function fetchCathayRate() {
    try {
        console.log('🚀 開始連線至國泰世華 (無障礙專區)...');

        const response = await axios.get(TARGET_URL);
        const $ = cheerio.load(response.data);

        let targetRate = null;

        // 🕵️ 針對無障礙網頁的簡單 HTML Table 解析
        // 它的結構通常是標準的 <table> -> <tbody> -> <tr> -> <td>
        // 我們直接遍歷所有的 tr (列)
        $('table tbody tr').each((index, element) => {
            
            // 抓取這一列的所有欄位 (td)
            const tds = $(element).find('td');
            
            // 確保欄位數量足夠 (避免抓到標題列)
            if (tds.length >= 3) {
                // 第一欄通常是幣別名稱
                const currencyName = $(tds[0]).text().trim();
                
                // 🎯 我們要找的是 "美元(USD)"，注意不要抓到 "美元現鈔"
                // 無障礙網頁上通常顯示為 "美元(USD)"
                if (currencyName === '美元(USD)') {
                    
                    // 根據網頁顯示：
                    // 第 1 欄: 幣別
                    // 第 2 欄: 銀行買進
                    // 第 3 欄: 銀行賣出 <--- 我們要這個 (即期賣出)
                    
                    const sellRate = $(tds[2]).text().trim();
                    targetRate = sellRate;
                    return false; // 找到就跳出迴圈
                }
            }
        });

        if (targetRate) {
            console.log(`✅ 抓取成功！`);
            console.log(`🇺🇸 美金 (即期賣出): ${targetRate}`);
            return targetRate;
        } else {
            console.log('⚠️ 找不到資料，請確認網頁結構是否變更。');
            return null;
        }

    } catch (error) {
        console.error('❌ 發生錯誤:', error.message);
        return null; // 回傳 null 讓呼叫端知道失敗
    }
}

// 執行測試
fetchCathayRate();