# tw-realestate-history

內政部實價登錄開放資料的歷史分片，供 [實價登錄查詢](https://tw-realestate-price.vercel.app) 前端直接讀取。

## 資料來源與授權

資料取自內政部[不動產交易實價查詢服務網](https://plvr.land.moi.gov.tw/DownloadOpenData)開放資料（季檔與本期檔），依[政府資料開放授權條款－第 1 版](https://data.gov.tw/license)使用。本 repo 只做格式轉換與分片，不修改資料內容。

## 結構

發布在 `gh-pages` 分支（GitHub Pages）：

```
manifest.json                  已處理的季檔與本期、各型態涵蓋的登記期間
{city}/{tx}/index.json         { "months": { "11509": 筆數, ... } }
{city}/{tx}/{yyymm}.json.gz    該月成交列（gzip 壓縮的 JSON 陣列）
```

- `city`：縣市代碼小寫（a 臺北市、f 新北市……，同內政部檔名）
- `tx`：`a` 買賣、`b` 預售屋、`c` 租賃
- `yyymm`：民國交易年月（租賃為租賃年月、預售屋為交易年月）
- 每列是字串陣列，欄位順序與內政部本期 XLS 相同（見 `manifest.json` 的 `layout`）。舊年度沒有的欄位留空，尾端空欄位會省略
- 同一筆成交以「編號」去重

## 更新

GitHub Actions 每月 2 日執行（`.github/workflows/build.yml`）：

1. **檢查**：比對已發布的 `manifest.json`，用 HEAD 判斷是否有新季檔，並讀本期的 `build_time.xml`（幾百位元組）。沒有新資料就結束，不複製分片也不重建
2. 有新資料時，下載尚未處理的季檔與本期檔（內政部每月 1、11、21 日各發布一次，涵蓋約 10 天）
3. 合併進既有分片後強制推送到 `gh-pages`

每月只抓一次本期檔，所以 11 日與 21 日發布的資料要等下一個季檔發布才會補齊。`manifest.json` 的 `coverage` 會列出實際已涵蓋的期間。

手動重建：Actions → Build history shards → Run workflow。

## 本機執行

```bash
npm ci
npx tsx scripts/build-history.ts --out site --cache .cache --seasons 115S2,115S3 --current
```
