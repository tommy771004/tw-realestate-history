/**
 * 實價登錄歷史資料建置：下載 plvr 季檔／本期檔，轉成「縣市 × 交易型態 × 交易年月」的
 * gzip JSON 分片，供前端直接從靜態主機讀取（不經 Vercel Function，沒有 4.5 MB 上限）。
 *
 * 用法：
 *   tsx scripts/build-history.ts --out <輸出資料夾> [--cache <zip 快取>] \
 *     [--seasons all | 101S2-115S3 | 115S2,115S3] [--current] [--cities a,f] [--force]
 *
 *   tsx scripts/build-history.ts --check <已發布 manifest.json 的網址> [--current]
 *     只判斷有沒有新資料（不下載季檔、不寫分片），結果寫入 $GITHUB_OUTPUT 的 changed=true|false
 *
 * 輸出：
 *   manifest.json                       已處理的季檔／本期、各型態登記期間涵蓋範圍
 *   {city}/{tx}/index.json              { months: { "11509": 筆數, ... } }
 *   {city}/{tx}/{yyymm}.json.gz         該月成交列（標準欄位順序，見 layout.ts）
 *
 * 同一筆成交以「編號」去重，重跑同一季是冪等的（manifest 有紀錄時略過，--force 可重跑）。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import Papa from "papaparse";
import {
  DATE_COL,
  ID_COL,
  LAYOUT,
  buildColumnMap,
  toLayoutRow,
  tradeYearMonth,
  type TxCode,
} from "./layout";

const BASE = "https://plvr.land.moi.gov.tw";
const TX_CODES: TxCode[] = ["a", "b", "c"];
const TX_LABEL: Record<TxCode, string> = { a: "買賣", b: "預售屋", c: "租賃" };

type Window = { from: string; to: string }; // 西元 YYYY-MM-DD

type SourceRecord = {
  lvrTime: string;
  rows: Record<TxCode, number>;
  skippedNoDate: number;
  processedAt: string;
};

type Manifest = {
  schema: 1;
  updatedAt: string;
  layout: Record<TxCode, string[]>;
  /** 季檔，如 "115S3" */
  seasons: Record<string, SourceRecord>;
  /** 本期（每 10 日發布），以 lvr_time 文字為 key */
  releases: Record<string, SourceRecord>;
  /** 各型態已涵蓋的登記（或訂約／交易）期間，已合併相鄰區段 */
  coverage: Record<TxCode, Window[]>;
};

// ---------------------------------------------------------------- CLI

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const OUT = path.resolve(opt("out") || "site");
const CACHE = path.resolve(opt("cache") || path.join(tmpdir(), "plvr-cache"));
const FORCE = flag("force");
const CITY_FILTER = opt("cities")?.split(",").map((c) => c.trim().toLowerCase());

// ---------------------------------------------------------------- 季別

const seasonId = (y: number, s: number) => `${y}S${s}`;

function currentRocYear() {
  return new Date().getFullYear() - 1911;
}

function expandSeasons(spec: string | undefined): string[] {
  if (!spec) return [];
  if (spec === "all") {
    const out: string[] = [];
    for (let y = 101; y <= currentRocYear(); y++) for (let s = 1; s <= 4; s++) out.push(seasonId(y, s));
    return out;
  }
  if (spec.includes("-")) {
    const [a, b] = spec.split("-");
    const [ay, as] = a.split("S").map(Number);
    const [by, bs] = b.split("S").map(Number);
    const out: string[] = [];
    for (let y = ay; y <= by; y++)
      for (let s = 1; s <= 4; s++) {
        if (y === ay && s < as) continue;
        if (y === by && s > bs) continue;
        out.push(seasonId(y, s));
      }
    return out;
  }
  return spec.split(",").map((s) => s.trim().toUpperCase());
}

// ---------------------------------------------------------------- 下載

async function download(url: string, dest: string): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // 不存在的期別會回 200 + HTML 錯誤頁，用 zip 檔頭 PK 判斷
      if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) return false;
      writeFileSync(dest, buf);
      return true;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  return false;
}

async function fetchZip(kind: "season" | "current", id: string): Promise<string | null> {
  mkdirSync(CACHE, { recursive: true });
  const dest = path.join(CACHE, kind === "season" ? `season_${id}.zip` : `current_${Date.now()}.zip`);
  if (kind === "season" && existsSync(dest)) return dest;
  const url =
    kind === "season"
      ? `${BASE}/DownloadSeason?season=${id}&type=zip&fileName=lvr_landcsv.zip`
      : `${BASE}/Download?type=zip&fileName=lvr_landcsv.zip`;
  const ok = await download(url, dest);
  return ok ? dest : null;
}

// ---------------------------------------------------------------- 讀取

function readLvrTime(dir: string): string {
  for (const name of ["build_time.xml", "build.ttt"]) {
    const p = path.join(dir, name);
    if (!existsSync(p)) continue;
    // 107 年以前的 build.ttt 是 Big5 編碼
    const text = new TextDecoder(name.endsWith(".ttt") ? "big5" : "utf-8").decode(readFileSync(p));
    const m = text.match(/<lvr_time>([\s\S]*?)<\/lvr_time>/);
    return (m ? m[1] : text).trim();
  }
  return "";
}

type Grouped = Map<string, string[][]>; // key: city/tx/yyymm

function parseExtracted(dir: string) {
  const grouped: Grouped = new Map();
  const rows: Record<TxCode, number> = { a: 0, b: 0, c: 0 };
  let skippedNoDate = 0;
  const unknownHeaders = new Set<string>();

  for (const file of readdirSync(dir)) {
    const m = file.match(/^([a-z])_lvr_land_([abc])\.csv$/);
    if (!m) continue;
    const [, city, tx] = m as unknown as [string, string, TxCode];
    if (CITY_FILTER && !CITY_FILTER.includes(city)) continue;

    const text = readFileSync(path.join(dir, file), "utf8");
    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true });
    const [header, , ...body] = parsed.data; // 第 0 列中文欄名、第 1 列英文欄名
    if (!header) continue;
    const { map, unknown } = buildColumnMap(tx, header);
    unknown.forEach((h) => unknownHeaders.add(`${tx}:${h}`));

    for (const src of body) {
      if (!src[0]) continue;
      const row = toLayoutRow(src, map);
      const ym = tradeYearMonth(row[DATE_COL[tx]] || "");
      if (!ym) {
        skippedNoDate++;
        continue;
      }
      const key = `${city}/${tx}/${ym}`;
      let list = grouped.get(key);
      if (!list) grouped.set(key, (list = []));
      list.push(row);
      rows[tx]++;
    }
  }
  return { grouped, rows, skippedNoDate, unknownHeaders };
}

// ---------------------------------------------------------------- 寫出

const readJson = <T>(p: string, fallback: T): T =>
  existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : fallback;

function readMonth(p: string): string[][] {
  return existsSync(p) ? (JSON.parse(gunzipSync(readFileSync(p)).toString("utf8")) as string[][]) : [];
}

function mergeGroups(grouped: Grouped) {
  const indexCache = new Map<string, { months: Record<string, number> }>();

  for (const [key, incoming] of grouped) {
    const [city, tx, ym] = key.split("/") as [string, TxCode, string];
    const dir = path.join(OUT, city, tx);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${ym}.json.gz`);

    const idCol = ID_COL[tx];
    const byId = new Map<string, string[]>();
    let anon = 0;
    const put = (r: string[]) => byId.set(r[idCol] || `__noid_${anon++}_${r.join("|")}`, r);
    readMonth(file).forEach(put);
    incoming.forEach(put); // 新資料覆蓋舊資料（同編號以較新期別為準）

    const merged = [...byId.values()].sort((x, y) =>
      (y[DATE_COL[tx]] || "").localeCompare(x[DATE_COL[tx]] || "", "en", { numeric: true })
    );
    writeFileSync(file, gzipSync(JSON.stringify(merged), { level: 9 }));

    const indexPath = path.join(dir, "index.json");
    let index = indexCache.get(indexPath);
    if (!index) indexCache.set(indexPath, (index = readJson(indexPath, { months: {} })));
    index.months[ym] = merged.length;
  }

  for (const [p, index] of indexCache) {
    const sorted = Object.fromEntries(
      Object.entries(index.months).sort(([a], [b]) => Number(a) - Number(b))
    );
    writeFileSync(p, JSON.stringify({ months: sorted }));
  }
}

// ---------------------------------------------------------------- 涵蓋期間

const rocToIso = (y: string, m: string, d: string) =>
  `${Number(y) + 1911}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;

/** 從 lvr_time 文字取出各型態的期間（買賣看登記日期；租賃、預售屋看訂約／交易日期）。 */
function parseWindows(lvrTime: string): Partial<Record<TxCode, Window>> {
  const out: Partial<Record<TxCode, Window>> = {};
  const re =
    /(\d+)年(\d+)月(\d+)日?\s*至\s*(\d+)年(\d+)月(\d+)日?\s*之(買賣|租賃、預售屋|租賃|預售屋)/g;
  for (const m of lvrTime.matchAll(re)) {
    const w = { from: rocToIso(m[1], m[2], m[3]), to: rocToIso(m[4], m[5], m[6]) };
    // 早期格式把租賃與預售屋寫在同一段：「之租賃、預售屋交易案件」
    const txs: TxCode[] =
      m[7] === "買賣" ? ["a"] : m[7] === "預售屋" ? ["b"] : m[7] === "租賃" ? ["c"] : ["b", "c"];
    txs.forEach((tx) => (out[tx] = w));
  }
  return out;
}

function mergeWindows(list: Window[]): Window[] {
  const sorted = [...list].sort((a, b) => a.from.localeCompare(b.from));
  const out: Window[] = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last) {
      const next = new Date(`${last.to}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      if (w.from <= next.toISOString().slice(0, 10)) {
        if (w.to > last.to) last.to = w.to;
        continue;
      }
    }
    out.push({ ...w });
  }
  return out;
}

function recomputeCoverage(manifest: Manifest) {
  const all: Record<TxCode, Window[]> = { a: [], b: [], c: [] };
  for (const rec of [...Object.values(manifest.seasons), ...Object.values(manifest.releases)]) {
    const w = parseWindows(rec.lvrTime);
    for (const tx of TX_CODES) if (w[tx]) all[tx].push(w[tx]!);
  }
  manifest.coverage = { a: mergeWindows(all.a), b: mergeWindows(all.b), c: mergeWindows(all.c) };
}

// ---------------------------------------------------------------- 主流程

async function processZip(zip: string, label: string): Promise<SourceRecord | null> {
  const dir = mkdtempSync(path.join(tmpdir(), "plvr-x-"));
  try {
    execFileSync("unzip", ["-o", "-q", zip, "-d", dir]);
    const lvrTime = readLvrTime(dir);
    const { grouped, rows, skippedNoDate, unknownHeaders } = parseExtracted(dir);
    mergeGroups(grouped);
    if (unknownHeaders.size) console.warn(`  ⚠️ ${label} 未對應欄位：${[...unknownHeaders].join("、")}`);
    console.log(
      `  ✓ ${label}：買賣 ${rows.a}、預售屋 ${rows.b}、租賃 ${rows.c}，無日期略過 ${skippedNoDate}，${grouped.size} 個月份檔`
    );
    return { lvrTime, rows, skippedNoDate, processedAt: new Date().toISOString() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const manifestPath = path.join(OUT, "manifest.json");
  const manifest: Manifest = readJson(manifestPath, {
    schema: 1,
    updatedAt: "",
    layout: LAYOUT,
    seasons: {},
    releases: {},
    coverage: { a: [], b: [], c: [] },
  });
  const save = () => {
    manifest.updatedAt = new Date().toISOString();
    manifest.layout = LAYOUT;
    recomputeCoverage(manifest);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
  };

  const seasons = expandSeasons(opt("seasons"));
  for (const id of seasons) {
    if (manifest.seasons[id] && !FORCE) {
      console.log(`- ${id} 已處理，略過`);
      continue;
    }
    const zip = await fetchZip("season", id);
    if (!zip) {
      console.log(`- ${id} 尚未發布或不存在`);
      continue;
    }
    console.log(`- ${id}`);
    const rec = await processZip(zip, id);
    if (rec) {
      manifest.seasons[id] = rec;
      save(); // 每季存一次，中斷後可從下一季接續
    }
  }

  if (flag("current")) {
    const zip = await fetchZip("current", "current");
    if (!zip) throw new Error("本期檔下載失敗");
    const dir = mkdtempSync(path.join(tmpdir(), "plvr-t-"));
    execFileSync("unzip", ["-o", "-q", zip, "build_time.xml", "-d", dir]);
    const lvrTime = readLvrTime(dir);
    rmSync(dir, { recursive: true, force: true });
    if (manifest.releases[lvrTime] && !FORCE) {
      console.log(`- 本期（${lvrTime.slice(0, 40)}…）已處理，略過`);
    } else {
      console.log(`- 本期：${lvrTime}`);
      const rec = await processZip(zip, "本期");
      if (rec) manifest.releases[lvrTime] = rec;
    }
    rmSync(zip, { force: true });
  }

  save();
  for (const tx of TX_CODES) {
    const w = manifest.coverage[tx];
    console.log(
      `涵蓋 ${TX_LABEL[tx]}：${w.map((x) => `${x.from}~${x.to}`).join("、") || "（無）"}`
    );
  }
}

// ---------------------------------------------------------------- 檢查模式

/** 季檔是否已發布：只看 HEAD 的 Content-Type（未發布時回 200 + text/html） */
async function isSeasonPublished(id: string): Promise<boolean> {
  const res = await fetch(`${BASE}/DownloadSeason?season=${id}&type=zip&fileName=lvr_landcsv.zip`, {
    method: "HEAD",
    redirect: "follow",
  });
  return res.ok && !(res.headers.get("content-type") || "").includes("text/html");
}

/** 本期的期間說明：直接讀 build_time.xml（幾百位元組），不必下載本期 zip */
async function currentLvrTime(): Promise<string> {
  const res = await fetch(`${BASE}/Download?fileName=build_time.xml`);
  if (!res.ok) throw new Error(`本期期間說明下載失敗（HTTP ${res.status}）`);
  const text = await res.text();
  const m = text.match(/<lvr_time>([\s\S]*?)<\/lvr_time>/);
  if (!m) throw new Error("本期期間說明格式不符");
  return m[1].trim();
}

async function check(manifestUrl: string) {
  const reasons: string[] = [];
  const res = await fetch(manifestUrl);
  if (res.status === 404) {
    reasons.push("尚未發布過任何分片");
  } else if (!res.ok) {
    throw new Error(`讀取已發布的 manifest 失敗（HTTP ${res.status}）`);
  } else {
    const published = (await res.json()) as Manifest;
    const pending = expandSeasons("all").filter((id) => !published.seasons[id]);
    for (const id of pending) {
      if (await isSeasonPublished(id)) reasons.push(`新季檔 ${id}`);
    }
    if (flag("current")) {
      const lvrTime = await currentLvrTime();
      if (!published.releases[lvrTime]) reasons.push(`新本期：${lvrTime}`);
    }
  }

  const changed = reasons.length > 0;
  console.log(changed ? `有新資料：\n- ${reasons.join("\n- ")}` : "沒有新資料，略過建置");
  const out = process.env.GITHUB_OUTPUT;
  if (out) writeFileSync(out, `changed=${changed}\n`, { flag: "a" });
}

const checkUrl = opt("check");
(checkUrl ? check(checkUrl) : main()).catch((err) => {
  console.error(err);
  process.exit(1);
});
