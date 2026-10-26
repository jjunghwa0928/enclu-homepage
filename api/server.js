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
 * 담당자(MAIL_TO) 알림 메일이 성공하면 고객(data.email)에게 접수 확인 메일을 추가로 보낸다
 * (CUSTOMER_ACK_ENABLED, 기본 켜짐). 확인 메일은 200 응답을 보낸 뒤 비동기로 발송하며
 * (ACK_TIMEOUT_MS 타임아웃), 실패·타임아웃은 경고 로그만 남긴다.
 * 확인 메일은 접수된 내용(이름·회사·연락처·문의 내용)을 이스케이프해서 그대로 돌려보내며,
 * 임의 주소로 임의 문구를 중계하는 악용은 수신 주소당 24시간 3통 상한(ACK_PER_EMAIL_LIMIT)으로 막는다.
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

/** 고객 확인 메일 발송 대기 상한. 넘기면 경고 로그만 남기고 잊는다. */
const ACK_TIMEOUT_MS = 10 * 1000;

/**
 * 수신 주소당 고객 확인 메일 상한. 확인 메일이 사용자 입력을 그대로 되돌려 보내므로,
 * 폼을 "임의 주소로 임의 문구를 보내는 중계기"로 쓰는 악용을 주소당 24시간 3통으로 묶는다.
 * 상한을 넘으면 담당자 알림은 그대로 보내고 확인 메일만 건너뛴다.
 */
const ACK_PER_EMAIL_LIMIT = 3;
const ACK_PER_EMAIL_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 고객 확인 메일의 CTA 링크·로고 (설정에 사이트 URL 항목이 없어 고정값) */
const ACK_SITE_URL = 'https://www.enclu.com/';
const ACK_LOGO_URL = 'https://jjunghwa0928.github.io/enclu-homepage/assets/logo-enclu.png';

/**
 * index.html <select name="type"> 의 option 값과 동일하게 유지한다.
 * 고객 확인 메일에는 이 목록과 정확히 일치하는 문의 유형만 표시한다.
 */
const INQUIRY_TYPES = Object.freeze([
  '브랜드 입점 문의',
  '플랫폼 제휴 문의',
  'Weedy 관련 문의',
  '수출바우처 문의',
  '기타'
]);

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
    allowedOrigins,
    // 고객 접수 확인 메일. "false" 로 명시했을 때만 끈다.
    customerAckEnabled: bool(env.CUSTOMER_ACK_ENABLED, true)
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

/** HTML 본문에 끼워 넣는 사용자 입력 이스케이프 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 접수 시각을 고객이 읽기 쉬운 한국 시간 문자열로 */
function formatReceivedAt(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false })} (KST)`;
}

/**
 * 고객 접수 확인 메일.
 * - 접수된 내용(이름·회사·연락처·문의 내용)을 그대로 돌려보낸다. HTML 에 들어가는 값은 전부 escapeHtml 을 거친다.
 *   문의 유형은 INQUIRY_TYPES 와 정확히 일치할 때만 표시한다.
 * - 임의 주소로 임의 문구를 중계하는 악용은 createAckLimiter(수신 주소당 24시간 3통)로 제한한다.
 * - Reply-To 를 설정하지 않고 자동응답 헤더를 붙여 메일 루프·부재중 자동회신을 막는다.
 */
function buildCustomerAckMail(config, data, meta) {
  const receivedAt = formatReceivedAt(meta.receivedAt);
  const contact = config.mailTo;
  const greeting = `${data.name}님, ENCLU 에 문의해 주셔서 감사합니다. 접수 내역은 아래와 같습니다.`;
  const noReplyNotice = `본 메일은 발신 전용(no-reply)이므로 회신하지 마세요. 추가 문의는 홈페이지 문의 폼 또는 ${contact} 로 보내주세요.`;
  const recipientLine = `이 메일은 ${data.email} 으로 발송되었습니다.`;

  const summary = [];
  if (INQUIRY_TYPES.includes(data.type)) summary.push(['문의 유형', data.type]);
  summary.push(['이름', data.name]);
  if (data.company) summary.push(['회사', data.company]);
  if (data.phone) summary.push(['연락처', data.phone]);
  summary.push(['접수 시각', receivedAt]);

  const text = [
    'ENCLU',
    '',
    '문의가 정상 접수되었습니다.',
    '',
    greeting,
    '',
    ...summary.map(([k, v]) => `${k}: ${v}`),
    '',
    '문의 내용:',
    data.message,
    '',
    '담당자가 영업일 기준 1~2일 내 연락드립니다.',
    '',
    `ENCLU 홈페이지: ${ACK_SITE_URL}`,
    '',
    noReplyNotice,
    '',
    '— ENCLU',
    '이 메일은 발신 전용입니다.',
    recipientLine
  ].join('\n');

  const font =
    "font-family:'Google Sans',Roboto,-apple-system,BlinkMacSystemFont,'Segoe UI','Apple SD Gothic Neo','Malgun Gothic',Arial,sans-serif;";

  const rows = summary
    .map(
      ([k, v]) =>
        `<tr><td style="padding:8px 16px 8px 0;${font}font-size:14px;line-height:1.6;color:#5f6368;white-space:nowrap;vertical-align:top;">${escapeHtml(k)}</td>` +
        `<td style="padding:8px 0;${font}font-size:14px;line-height:1.6;color:#3c4043;vertical-align:top;">${escapeHtml(v)}</td></tr>`
    )
    .join('');

  // 문의 내용: 줄바꿈 유지(<br>), 연한 회색 라운드 박스
  const messageHtml = escapeHtml(data.message).replace(/\n/g, '<br />');
  const messageRow =
    `<tr><td colspan="2" style="padding:12px 0 0;${font}font-size:14px;line-height:1.6;color:#5f6368;">문의 내용</td></tr>` +
    '<tr><td colspan="2" style="padding:8px 0 0;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' +
    `<tr><td style="padding:12px 16px;background:#f8f9fa;border-radius:8px;${font}font-size:14px;line-height:1.6;color:#3c4043;">${messageHtml}</td></tr>` +
    '</table></td></tr>';

  const html = [
    '<!DOCTYPE html>',
    '<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>문의 접수 확인</title></head>',
    `<body style="margin:0;padding:0;background:#f8f9fa;${font}color:#3c4043;">`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8f9fa;">',
    '<tr><td align="center" style="padding:40px 16px 24px;">',
    // 카드
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border:1px solid #dadce0;border-radius:8px;">',
    '<tr><td style="padding:40px 40px 32px;">',
    // 로고
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">',
    `<tr><td align="center" style="padding:0 0 24px;">` +
      `<a href="${ACK_SITE_URL}" style="text-decoration:none;">` +
      `<img src="${ACK_LOGO_URL}" alt="ENCLU" height="32" style="display:block;height:32px;border:0;outline:none;${font}font-size:20px;font-weight:700;letter-spacing:0.12em;color:#202124;" />` +
      '</a></td></tr>',
    // 제목·인사
    `<tr><td align="center" style="padding:0 0 12px;${font}font-size:24px;line-height:1.3;font-weight:700;color:#202124;">문의가 정상 접수되었습니다.</td></tr>`,
    `<tr><td align="center" style="padding:0 0 28px;${font}font-size:14px;line-height:1.6;color:#3c4043;">${escapeHtml(greeting)}</td></tr>`,
    // 접수 내역
    `<tr><td style="padding:0 0 24px;border-top:1px solid #dadce0;border-bottom:1px solid #dadce0;">` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:12px 0 0;">${rows}${messageRow}</table>` +
      '</td></tr>',
    `<tr><td align="center" style="padding:0 0 28px;${font}font-size:14px;line-height:1.6;color:#3c4043;">담당자가 영업일 기준 1~2일 내 연락드립니다.</td></tr>`,
    // CTA
    '<tr><td align="center" style="padding:0 0 32px;">' +
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0">' +
      '<tr><td align="center" style="background:#1a73e8;border-radius:4px;">' +
      `<a href="${ACK_SITE_URL}" style="display:inline-block;padding:10px 24px;${font}font-size:14px;line-height:20px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:4px;">ENCLU 홈페이지</a>` +
      '</td></tr></table></td></tr>',
    // 발신 전용 안내
    `<tr><td align="center" style="${font}font-size:12px;line-height:1.6;color:#5f6368;">${escapeHtml(noReplyNotice)}</td></tr>`,
    '</table>',
    '</td></tr>',
    '</table>',
    // 푸터 (카드 밖)
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">',
    `<tr><td align="center" style="padding:24px 16px 0;${font}font-size:12px;line-height:1.6;color:#5f6368;">` +
      'ENCLU<br />이 메일은 발신 전용입니다.<br />' +
      `${escapeHtml(recipientLine)}` +
      '</td></tr>',
    '</table>',
    '</td></tr>',
    '</table>',
    '</body></html>'
  ].join('');

  return {
    from: config.mailFrom,
    to: headerSafe(data.email),
    subject: headerSafe('[ENCLU] 문의가 정상 접수되었습니다'),
    text,
    html,
    headers: {
      'Auto-Submitted': 'auto-replied',
      'X-Auto-Response-Suppress': 'All'
    }
  };
}

/**
 * 고객 확인 메일을 응답과 무관하게 비동기로 보낸다 (fire-and-forget).
 * timeoutMs 안에 끝나지 않거나 실패하면 경고 로그만 남기며, 어떤 경우에도 reject 를 밖으로 내보내지 않는다.
 * 반환된 Promise 는 항상 resolve 되므로 테스트에서 기다리는 용도로만 쓴다.
 */
function sendCustomerAck(sendMail, mail, timeoutMs, ip) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error('customer ack timed out');
      e.code = 'ETIMEDOUT';
      reject(e);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });

  return Promise.race([Promise.resolve().then(() => sendMail(mail)), timeout])
    .then(() => {
      log('info', 'ack sent', { ip });
    })
    .catch((err) => {
      log('warn', 'ack send failed', { ip, reason: err && err.code ? err.code : 'unknown' });
    })
    .finally(() => clearTimeout(timer));
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

// ---------------------------------------------------------------------------
// 고객 확인 메일 수신 주소별 상한 (메모리)
// ---------------------------------------------------------------------------

function createAckLimiter(limit = ACK_PER_EMAIL_LIMIT, windowMs = ACK_PER_EMAIL_WINDOW_MS) {
  const sent = new Map(); // email(lowercase) -> [timestamp, ...] (창 안의 발송 시각만)
  let lastPrune = 0;

  function keyOf(email) {
    return String(email).trim().toLowerCase();
  }

  function recent(email, now) {
    const list = (sent.get(keyOf(email)) || []).filter((t) => now - t < windowMs);
    if (list.length) sent.set(keyOf(email), list);
    else sent.delete(keyOf(email));
    return list;
  }

  function prune(now) {
    if (now - lastPrune < 60 * 1000) return;
    lastPrune = now;
    for (const [k, list] of sent) {
      const kept = list.filter((t) => now - t < windowMs);
      if (kept.length) sent.set(k, kept);
      else sent.delete(k);
    }
  }

  return {
    /** 창 안에 이미 limit 통을 보냈으면 true (= 확인 메일 생략). 기록하지는 않는다. */
    isExceeded(email, now = Date.now()) {
      prune(now);
      return recent(email, now).length >= limit;
    },
    /** 확인 메일 발송을 시도할 때 호출 — 실패해도 횟수에 넣는다(실패를 이용한 우회 방지) */
    remember(email, now = Date.now()) {
      sent.set(keyOf(email), [...recent(email, now), now]);
    },
    size() {
      return sent.size;
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
  const ackLimiter = options.ackLimiter || createAckLimiter();
  const ackTimeoutMs = Number.isFinite(options.ackTimeoutMs) ? options.ackTimeoutMs : ACK_TIMEOUT_MS;

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

    // 5) 발송 — 담당자 알림이 핵심. 실패하면 502.
    const meta = { ip, receivedAt: new Date().toISOString() };
    const mail = buildMail(config, data, meta);
    try {
      await sendMail(mail);
      duplicates.remember(data.email, data.message);
      log('info', 'sent', { ip, type: data.type });
    } catch (err) {
      log('error', 'send failed', { ip, reason: err && err.code ? err.code : 'unknown' });
      return res.status(502).json({ ok: false, error: 'send_failed' });
    }

    res.json({ ok: true });

    // 6) 고객 접수 확인 — 응답을 보낸 뒤 비동기로. 실패·타임아웃은 로그만 남긴다 (접수 자체는 이미 완료).
    //    수신 주소당 24시간 상한을 넘기면 확인 메일만 건너뛴다 (담당자 알림은 이미 발송됨).
    if (config.customerAckEnabled) {
      if (ackLimiter.isExceeded(data.email)) {
        log('info', 'ack skipped', { ip, reason: 'per_email_limit' });
      } else {
        ackLimiter.remember(data.email);
        sendCustomerAck(sendMail, buildCustomerAckMail(config, data, meta), ackTimeoutMs, ip);
      }
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

module.exports = {
  createApp,
  loadConfig,
  startupError,
  validateContact,
  buildMail,
  buildCustomerAckMail,
  createDuplicateGuard,
  createAckLimiter,
  LIMITS,
  INQUIRY_TYPES,
  ACK_TIMEOUT_MS,
  ACK_PER_EMAIL_LIMIT,
  ACK_PER_EMAIL_WINDOW_MS
};
