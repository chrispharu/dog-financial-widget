# 1. 選擇基底映像檔 (就像 Java 選擇 JDK 版本)
# 使用 alpine 版本，體積最小 (約 50MB)
FROM node:20-alpine

# 2. 設定容器內的工作目錄
WORKDIR /app

# 3. 先複製 package.json (為了利用 Docker Cache 機制加速)
COPY package*.json ./

# 4. 安裝依賴 (npm install)
RUN npm install --production

# 5. 複製所有的程式碼進去
COPY . .

# 6. 告訴 Docker 您的程式會用哪個 Port
EXPOSE 3000

# 7. 啟動指令 (跟您在本機打的一樣)
CMD ["node", "web.js"]