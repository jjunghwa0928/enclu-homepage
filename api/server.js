'use strict';

/**
 * ENCLU 홈페이지 문의 API
 *
 *   POST /api/contact  — 문의 폼 → SMTP 메일 발송
 *   GET  /api/health   — 상태 확인
 *
 * 보호 계층 (안쪽부터):
 *   helmet 기본 헤더 → JSON 16kb 제한 → CORS(허용 목록) → 전역 60req/min
 *   → /api/contact 5req/10min → 허니팟 → 필드 검증·CRLF 차단
 *   → Turnstile 검증(production 에서는 필수) → 중복 전송 가드(email+message 해시, 10분, 발송 성공 후 기록) → 메일 발송
 *
 * 테스트에서는 createApp({ config, sendMail, verifyTurnstile }) 로
 * 네트워크를 쓰지 않는 가짜 구현을 주입한다.
 */

const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const nodemailer = require('nodemailer');

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CRLF_RE = /[\r\n]/;

const LIMITS = {
  type: 50,
  company: 100,
  name: 100,
  email: 200,
  phone: 30,
  message: 3000,
  turnstileToken: 2048
};

const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// 설정
// ---------------------------------------------------------------------------

function loadConfig(env = process.env) {
  const bool = (v, d) => (v === undefined || v === '' ? d : String(v).toLowerCase() === 'true');
  const allowedOrigins = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    port: Number(env.PORT) || 3200,
    nodeEnv: env.NODE_ENV || 'development',
    smtp: {
      host: env.SMTP_HOST || '',
      port: Number(env.SMTP_PORT) || 587,
      secure: bool(env.SMTP_SECURE, false),
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || ''
    },
    mailFrom: env.MAIL_FROM || env.SMTP_USER || 'noreply@enclu.co.kr',
    mailTo: env.MAIL_TO || 'info@enclu.co.kr',
    turnstileSecret: env.TURNSTILE_SECRET || '',
    allowedOrigins
  };
}

// ---------------------------------------------------------------------------
// 로깅 — 본문·비밀값은 절대 기록하지 않는다
// ---------------------------------------------------------------------------

function log(level, msg, meta) {
  const line = `${new Date().toISOString()} [contact-api] ${level.toUpperCase()} ${msg}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  if (meta && Object.keys(meta).length) out(line, JSON.stringify(meta));
  else out(line);
}

// ---------------------------------------------------------------------------
// 외부 연동 (기본 구현 — 테스트에서는 교체)
// ---------------------------------------------------------------------------

async function verifyTurnstileRemote(secret, token, ip) {
  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set('remoteip', ip);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, { method: 'POST', body, signal: ctrl.signal });
    if (!res.ok) {
      log('warn', 'turnstile siteverify non-200', { status: res.status });
      return false;
    }
    const json = await res.json();
    if (json.success !== true) {
      log('warn', 'turnstile rejected', { codes: json['error-codes'] || [] });
    }
    return json.success === true;
  } catch (err) {
    log('warn', 'turnstile siteverify failed', { reason: err.name });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function createSmtpSender(config) {
  const { smtp } = config;
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined
  });
  return (mail) => transport.sendMail(mail);
}

// ---------------------------------------------------------------------------
// 검증
// ---------------------------------------------------------------------------

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 입력 검증. 통과하면 { ok:true, data }, 실패하면 { ok:false, reason }.
 * reason 은 서버 로그용이며 클라이언트에는 전달하지 않는다.
 */
function validateContact(body) {
  const data = {
    type: str(body.type),
    company: str(body.company),
    name: str(body.name),
    email: str(body.email),
    phone: str(body.phone),
    message: typeof body.message === 'string' ? body.message.replace(/\r\n?/g, '\n').trim() : ''
  };

  for (const field of ['type', 'company', 'name', 'email', 'message']) {
    if (!data[field]) return { ok: false, reason: `missing:${field}` };
  }
  for (const field of Object.keys(LIMITS)) {
    if (field === 'turnstileToken') continue;
    if (data[field] && data[field].length > LIMITS[field]) {
      return { ok: false, reason: `too_long:${field}` };
    }
  }
  // 메일 헤더(제목·Reply-To)에 들어가는 값은 개행이 있으면 거부 — 헤더 인젝션 방지
  for (const field of ['type', 'company', 'name', 'email', 'phone']) {
    if (CRLF_RE.test(data[field])) return { ok: false, reason: `crlf:${field}` };
  }
  if (!EMAIL_RE.test(data.email)) return { ok: false, reason: 'invalid:email' };
  if (body.consent !== true) return { ok: false, reason: 'consent' };

  return { ok: true, data };
}

/** 헤더에 들어가는 문자열에서 제어문자를 한 번 더 제거 (방어선 2중화) */
function headerSafe(s) {
  return String(s).replace(/[\u0000-\u001f\u007f]/g, ' ');
}

function buildMail(config, data, meta) {
  const subject = headerSafe(`[홈페이지 문의] ${data.type} - ${data.company}`);
  const text = [
    `문의 유형: ${data.type}`,
    `회사명: ${data.company}`,
    `성함: ${data.name}`,
    `이메일: ${data.email}`,
    `연락처: ${data.phone || '-'}`,
    `접수 시각: ${meta.receivedAt}`,
    `접수 IP: ${meta.ip || '-'}`,
    '',
    '문의 내용:',
    data.message,
    '',
    '— ENCLU 홈페이지 문의 폼에서 자동 발송된 메일입니다.'
  ].join('\n');

  return {
    from: config.mailFrom,
    to: config.mailTo,
    replyTo: headerSafe(data.email),
    subject,
    text
  };
}

// ---------------------------------------------------------------------------
// 중복 전송 가드 (메모리)
// ---------------------------------------------------------------------------

function createDuplicateGuard(windowMs = DUPLICATE_WINDOW_MS) {
  const seen = new Map(); // hash -> timestamp
  let lastPrune = 0;

  function prune(now) {
    if (now - lastPrune < 60 * 1000) return;
    lastPrune = now;
    for (const [k, t] of seen) if (now - t > windowMs) seen.delete(k);
  }

  function hashOf(email, message) {
    return crypto
      .createHash('sha256')
      .update(`${email.toLowerCase()}\n${message}`)
      .digest('hex');
  }

  return {
    /** 같은 email+message 가 창 안에 있으면 true (= 중복). 기록하지는 않는다. */
    isDuplicate(email, message, now = Date.now()) {
      prune(now);
      const prev = seen.get(hashOf(email, message));
      return prev !== undefined && now - prev < windowMs;
    },
    /** 발송이 성공한 뒤에만 호출 — 실패한 전송은 재시도를 막지 않는다 */
    remember(email, message, now = Date.now()) {
      seen.set(hashOf(email, message), now);
    },
    size() {
      return seen.size;
    }
  };
}

/**
 * 기동 전 설정 점검. 문제가 있으면 메시지를 돌려주고, 없으면 null.
 * production 에서 TURNSTILE_SECRET 이 없으면 봇 검증이 통째로 빠지므로 기동을 거부한다.
 */
function startupError(config) {
  if (config.nodeEnv === 'production' && !config.turnstileSecret) {
    return 'TURNSTILE_SECRET is required when NODE_ENV=production (bot verification would be disabled). Set it in api/.env, or run with NODE_ENV=development to skip verification.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// 미들웨어
// ---------------------------------------------------------------------------

function corsMiddleware(allowedOrigins) {
  const allow = new Set(allowedOrigins);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allow.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  };
}

function limiter(windowMs, limit) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler(req, res) {
      log('warn', 'rate limited', { path: req.path, ip: req.ip });
      res.status(429).json({ ok: false, error: 'rate_limited' });
    }
  });
}

// ---------------------------------------------------------------------------
// 앱
// ---------------------------------------------------------------------------

function createApp(options = {}) {
  const config = options.config || loadConfig();
  const sendMail = options.sendMail || createSmtpSender(config);
  const verifyTurnstile = options.verifyTurnstile || verifyTurnstileRemote;
  const duplicates = options.duplicateGuard || createDuplicateGuard();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // IIS ARR 뒤에서 X-Forwarded-For 첫 홉만 신뢰

  app.use(helmet());
  app.use(corsMiddleware(config.allowedOrigins));
  app.use(express.json({ limit: '16kb' }));
  app.use('/api', limiter(60 * 1000, 60));

  app.get('/api/health', (req, res) => {
    res.json({ ok: true });
  });

  app.post('/api/contact', limiter(10 * 60 * 1000, 5), async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const ip = req.ip;

    // 1) 허니팟 — 봇이 학습하지 못하도록 성공처럼 응답
    if (str(body.website)) {
      log('info', 'honeypot hit', { ip });
      return res.json({ ok: true });
    }

    // 2) 필드 검증 (CRLF 포함)
    const v = validateContact(body);
    if (!v.ok) {
      log('info', 'rejected', { ip, reason: v.reason });
      return res.status(400).json({ ok: false, error: 'invalid_input' });
    }
    const data = v.data;

    // 3) Turnstile
    if (config.turnstileSecret) {
      const token = str(body.turnstileToken);
      if (!token || token.length > LIMITS.turnstileToken) {
        log('info', 'rejected', { ip, reason: 'turnstile:missing' });
        return res.status(400).json({ ok: false, error: 'captcha_failed' });
      }
      const passed = await verifyTurnstile(config.turnstileSecret, token, ip);
      if (!passed) {
        log('info', 'rejected', { ip, reason: 'turnstile:failed' });
        return res.status(400).json({ ok: false, error: 'captcha_failed' });
      }
    }

    // 4) 중복 전송 (기록은 발송 성공 후에만)
    if (duplicates.isDuplicate(data.email, data.message)) {
      log('info', 'rejected', { ip, reason: 'duplicate' });
      return res.status(429).json({ ok: false, error: 'duplicate' });
    }

    // 5) 발송
    const mail = buildMail(config, data, { ip, receivedAt: new Date().toISOString() });
    try {
      await sendMail(mail);
      duplicates.remember(data.email, data.message);
      log('info', 'sent', { ip, type: data.type });
      return res.json({ ok: true });
    } catch (err) {
      log('error', 'send failed', { ip, reason: err && err.code ? err.code : 'unknown' });
      return res.status(502).json({ ok: false, error: 'send_failed' });
    }
  });

  app.use((req, res) => {
    res.status(404).json({ ok: false, error: 'not_found' });
  });

  // 바디 파서 오류 등 — 항상 JSON, 내부 정보 노출 없음
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) log('error', 'unhandled', { reason: err && err.name ? err.name : 'unknown' });
    res.status(status).json({ ok: false, error: status === 413 ? 'too_large' : status >= 500 ? 'server_error' : 'bad_request' });
  });

  return app;
}

// ---------------------------------------------------------------------------
// 기동
// ---------------------------------------------------------------------------

function start() {
  require('dotenv').config({ path: require('path').join(__dirname, '.env') });
  const config = loadConfig();

  const fatal = startupError(config);
  if (fatal) {
    log('error', `refusing to start: ${fatal}`);
    process.exit(1);
  }
  if (!config.turnstileSecret) {
    log('warn', `TURNSTILE_SECRET is not set — bot verification is DISABLED (NODE_ENV=${config.nodeEnv}, non-production only)`);
  }
  if (!config.smtp.host) {
    log('warn', 'SMTP_HOST is not set — mail sending will fail');
  }

  const app = createApp({ config });
  app.listen(config.port, () => {
    log('info', `listening on :${config.port}`, {
      env: config.nodeEnv,
      mailTo: config.mailTo,
      cors: config.allowedOrigins.length ? config.allowedOrigins : 'same-origin'
    });
  });
}

if (require.main === module) start();

module.exports = { createApp, loadConfig, startupError, validateContact, buildMail, createDuplicateGuard, LIMITS };
