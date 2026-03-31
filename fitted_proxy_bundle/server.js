
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 1000 * 60 * 60 * 6);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 12000);
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES || 8 * 1024 * 1024);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`);
const FALLBACK_PNG = fs.readFileSync(path.join(__dirname, 'fallback.png'));

const cache = new Map();

function now() {
  return Date.now();
}

function cleanup() {
  const t = now();
  for (const [key, value] of cache.entries()) {
    if (value.expiresAt <= t) cache.delete(key);
  }
}
setInterval(cleanup, 10 * 60 * 1000).unref();

function normalizeUrl(raw) {
  if (!raw) return '';
  const s = String(raw).trim().replace(/^['"]|['"]$/g, '');
  if (!/^https?:\/\//i.test(s)) return '';
  return s;
}

function extFrom(contentType, url) {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('gif')) return 'gif';
  if (ct.includes('bmp')) return 'bmp';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const m = pathname.match(/\.([a-z0-9]{3,4})$/);
    if (m) return m[1];
  } catch {}
  return 'jpg';
}

async function fetchImage(sourceUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(sourceUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    if (!ct.toLowerCase().startsWith('image/')) throw new Error(`Not image content-type: ${ct}`);
    const ab = await res.arrayBuffer();
    const buffer = Buffer.from(ab);
    if (!buffer.length) throw new Error('Empty body');
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error(`Too large: ${buffer.length}`);
    return { buffer, contentType: ct };
  } finally {
    clearTimeout(timer);
  }
}

function putInCache(buffer, contentType, originalUrl) {
  const id = crypto.randomBytes(12).toString('hex');
  const extension = extFrom(contentType, originalUrl);
  cache.set(id, {
    buffer,
    contentType,
    extension,
    expiresAt: now() + CACHE_TTL_MS,
    originalUrl
  });
  return `${PUBLIC_BASE_URL}/image/${id}.${extension}`;
}

function getCandidates(req) {
  const out = [];
  const fields = [];
  for (let i = 1; i <= 6; i++) {
    fields.push(`photo${i}`, `photo${i}b`);
  }
  for (const key of fields) {
    const val = normalizeUrl(req.query[key] || req.body?.[key]);
    if (val && !out.includes(val)) out.push(val);
  }
  if (Array.isArray(req.body?.candidates)) {
    for (const raw of req.body.candidates) {
      const val = normalizeUrl(raw);
      if (val && !out.includes(val)) out.push(val);
    }
  }
  return out;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'fitted-image-proxy', cacheItems: cache.size });
});

app.all('/select-images', async (req, res) => {
  try {
    const candidates = getCandidates(req);
    const selected = [];
    const errors = [];

    for (const candidate of candidates) {
      if (selected.length >= 3) break;
      try {
        const { buffer, contentType } = await fetchImage(candidate);
        selected.push(putInCache(buffer, contentType, candidate));
      } catch (err) {
        errors.push({ url: candidate, error: String(err.message || err) });
      }
    }

    let usedFallback = false;
    if (selected.length === 0) {
      const fallbackUrl = putInCache(FALLBACK_PNG, 'image/png', 'fallback');
      selected.push(fallbackUrl, fallbackUrl, fallbackUrl);
      usedFallback = true;
    } else {
      while (selected.length < 3) {
        selected.push(selected[selected.length - 1]);
      }
    }

    res.json({
      ok: true,
      count: selected.length,
      originalCandidateCount: candidates.length,
      usedFallback,
      image1: selected[0],
      image2: selected[1],
      image3: selected[2],
      debugErrors: errors.slice(0, 10)
    });
  } catch (err) {
    const fallbackUrl = putInCache(FALLBACK_PNG, 'image/png', 'fallback');
    res.json({
      ok: true,
      count: 3,
      originalCandidateCount: 0,
      usedFallback: true,
      image1: fallbackUrl,
      image2: fallbackUrl,
      image3: fallbackUrl,
      debugErrors: [{ error: String(err.message || err) }]
    });
  }
});

app.get('/image/:name', (req, res) => {
  cleanup();
  const id = String(req.params.name || '').split('.')[0];
  const item = cache.get(id);
  if (!item) {
    return res.status(404).send('Not found');
  }
  res.setHeader('content-type', item.contentType);
  res.setHeader('cache-control', 'public, max-age=21600, immutable');
  res.send(item.buffer);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Fitted image proxy listening on ${PORT}`);
});
