/**
 * 實價登錄主表的「標準欄位順序」：與 plvr 本期 XLS／115 年以後的 CSV 相同，
 * 前端 mapTransactionRow 依位置讀欄，所以歷史資料一律轉成這個順序。
 *
 * 舊年度差異（依欄位名稱對應，缺的欄位留空）：
 * - 買賣：早期欄名寫成「車位移轉總面積(平方公尺)」
 * - 預售屋：108 年以前沒有建案名稱、棟及號；113 年以前沒有解約情形
 * - 租賃：113 年以前沒有出租型態～租賃住宅服務 6 欄
 */

export type TxCode = "a" | "b" | "c";

const SALE_BASE = [
  "鄉鎮市區", "交易標的", "土地位置建物門牌", "土地移轉總面積平方公尺",
  "都市土地使用分區", "非都市土地使用分區", "非都市土地使用編定", "交易年月日",
  "交易筆棟數", "移轉層次", "總樓層數", "建物型態", "主要用途", "主要建材",
  "建築完成年月", "建物移轉總面積平方公尺", "建物現況格局-房", "建物現況格局-廳",
  "建物現況格局-衛", "建物現況格局-隔間", "有無管理組織", "總價元",
  "單價元平方公尺", "車位類別", "車位移轉總面積平方公尺", "車位總價元", "備註", "編號",
];

export const LAYOUT: Record<TxCode, string[]> = {
  a: [...SALE_BASE, "主建物面積", "附屬建物面積", "陽台面積", "電梯", "移轉編號"],
  b: [...SALE_BASE, "建案名稱", "棟及號", "解約情形"],
  c: [
    "鄉鎮市區", "交易標的", "土地位置建物門牌", "土地面積平方公尺",
    "都市土地使用分區", "非都市土地使用分區", "非都市土地使用編定", "租賃年月日",
    "租賃筆棟數", "租賃層次", "總樓層數", "建物型態", "主要用途", "主要建材",
    "建築完成年月", "建物總面積平方公尺", "建物現況格局-房", "建物現況格局-廳",
    "建物現況格局-衛", "建物現況格局-隔間", "有無管理組織", "有無附傢俱", "總額元",
    "單價元平方公尺", "車位類別", "車位面積平方公尺", "車位總額元", "備註", "編號",
    "出租型態", "有無管理員", "租賃期間", "有無電梯", "附屬設備", "租賃住宅服務",
  ],
};

export const DATE_COL: Record<TxCode, number> = { a: 7, b: 7, c: 7 };
export const ID_COL: Record<TxCode, number> = {
  a: LAYOUT.a.indexOf("編號"),
  b: LAYOUT.b.indexOf("編號"),
  c: LAYOUT.c.indexOf("編號"),
};

/** 欄名正規化：去掉全形／半形括號與空白，讓舊寫法對得上。 */
export const normalizeHeader = (h: string) =>
  h.replace(/^﻿/, "").replace(/[()（）\s]/g, "");

/**
 * 依來源檔頭建立「標準欄位 → 來源欄位」對照。
 * 回傳 unknown 是來源有、標準沒有的欄名，供建置時記錄。
 */
export function buildColumnMap(tx: TxCode, sourceHeader: string[]) {
  const index = new Map(sourceHeader.map((h, i) => [normalizeHeader(h), i]));
  const map = LAYOUT[tx].map((name) => index.get(normalizeHeader(name)) ?? -1);
  const known = new Set(LAYOUT[tx].map(normalizeHeader));
  const unknown = sourceHeader.map(normalizeHeader).filter((h) => h && !known.has(h));
  return { map, unknown };
}

/** 依對照轉成標準順序，並去掉尾端空字串（前端以 row[i] || "" 讀取）。 */
export function toLayoutRow(source: string[], map: number[]): string[] {
  const out = map.map((i) => (i >= 0 ? (source[i] ?? "").trim() : ""));
  let end = out.length;
  while (end > 0 && out[end - 1] === "") end--;
  return out.slice(0, end);
}

/**
 * 民國日期字串 → 交易年月（如 "1150921" → "11509"，"990105" → "9901"）。
 * 無法解析時回傳 null。
 */
export function tradeYearMonth(date: string): string | null {
  const d = (date || "").trim();
  if (!/^\d{6,7}$/.test(d)) return null;
  const y = parseInt(d.slice(0, -4), 10);
  const m = parseInt(d.slice(-4, -2), 10);
  if (!(y >= 1 && y <= 200) || !(m >= 1 && m <= 12)) return null;
  return `${y}${String(m).padStart(2, "0")}`;
}
