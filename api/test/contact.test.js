'use strict';

// 실행: cd api && npm test   (node --test)
// 네트워크를 쓰지 않도록 가짜 메일 전송기·가짜 Turnstile 검증기를 주입한다.

process.env.NODE_ENV = 'test';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp, loadConfig, startupError } = require('../server');

// 테스트 중 서버 로그는 숨긴다
const origLog = console.log;
const origErr = console.error;
console.log = () => {};
console.error = () => {};
process.on('exit', () => {
  console.log = origLog;
  console.error = origErr;
});

function baseConfig(overrides = {}) {
  return {
    ...loadConfig({}),
    mailTo: 'info@enclu.co.kr',
    mailFrom: 'noreply@enclu.co.kr',
    turnstileSecret: '',
    allowedOrigins: [],
    ...overrides
  };
}

function validPayload(overrides = {}) {
  return {
    type: '브랜드 입점 문의',
    company: '(주)엔클루',
    name: '홍길동',
    email: 'hong@example.com',
    phone: '010-0000-0000',
    message: '일본 진출을 고민 중입니다.',
    consent: true,
    website: '',
    ...overrides
  };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(server, method, path, body, headers = {}) {
  const { port } = server.address();
  const payload = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          ...(payload !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers
        }
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch (_) {
            /* non-JSON */
          }
          resolve({ status: res.statusCode, headers: res.headers, json, raw });
        });
      }
    );
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

describe('contact api', () => {
  let server;
  let sent;
  let turnstileCalls;
  let turnstileResult;

  async function boot(configOverrides = {}) {
    sent = [];
    turnstileCalls = [];
    turnstileResult = true;
    const app = createApp({
      config: baseConfig(configOverrides),
      sendMail: async (mail) => {
        sent.push(mail);
        return { messageId: 'fake' };
      },
      verifyTurnstile: async (secret, token, ip) => {
        turnstileCalls.push({ secret, token, ip });
        return turnstileResult;
      }
    });
    server = await listen(app);
  }

  beforeEach(() => boot());
  afterEach(() => new Promise((r) => server.close(r)));

  test('GET /api/health → {ok:true}', async () => {
    const res = await request(server, 'GET', '/api/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });
  });

  test('success: sends mail with subject, replyTo and plain-text body', async () => {
    const res = await request(server, 'POST', '/api/contact', validPayload());
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });
    assert.equal(sent.length, 1);

    const mail = sent[0];
    assert.equal(mail.to, 'info@enclu.co.kr');
    assert.equal(mail.from, 'noreply@enclu.co.kr');
    assert.equal(mail.replyTo, 'hong@example.com');
    assert.equal(mail.subject, '[홈페이지 문의] 브랜드 입점 문의 - (주)엔클루');
    assert.ok(mail.text.includes('회사명: (주)엔클루'));
    assert.ok(mail.text.includes('성함: 홍길동'));
    assert.ok(mail.text.includes('연락처: 010-0000-0000'));
    assert.ok(mail.text.includes('일본 진출을 고민 중입니다.'));
    assert.equal(mail.html, undefined, 'plain text only');
    assert.equal(turnstileCalls.length, 0, 'turnstile skipped when secret unset');
  });

  test('missing required field → 400, nothing sent', async () => {
    for (const field of ['company', 'name', 'email', 'message']) {
      const res = await request(server, 'POST', '/api/contact', validPayload({ [field]: '' }));
      assert.equal(res.status, 400, `field ${field}`);
      assert.equal(res.json.ok, false);
      assert.equal(res.json.error, 'invalid_input');
    }
    assert.equal(sent.length, 0);
  });

  test('consent must be true', async () => {
    const res = await request(server, 'POST', '/api/contact', validPayload({ consent: false }));
    assert.equal(res.status, 400);
    assert.equal(sent.length, 0);
  });

  test('invalid email / over-length fields → 400', async () => {
    let res = await request(server, 'POST', '/api/contact', validPayload({ email: 'not-an-email' }));
    assert.equal(res.status, 400);
    res = await request(server, 'POST', '/api/contact', validPayload({ message: 'x'.repeat(3001) }));
    assert.equal(res.status, 400);
    res = await request(server, 'POST', '/api/contact', validPayload({ company: 'x'.repeat(101) }));
    assert.equal(res.status, 400);
    assert.equal(sent.length, 0);
  });

  test('honeypot filled → 200 silently, nothing sent', async () => {
    const res = await request(server, 'POST', '/api/contact', validPayload({ website: 'http://spam.example' }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });
    assert.equal(sent.length, 0);
  });

  test('CRLF in header-bound fields → 400 (header injection)', async () => {
    const cases = [
      { company: '엔클루\r\nBcc: victim@example.com' },
      { name: '홍길동\nX-Evil: 1' },
      { type: '기타\r\nSubject: hacked' },
      { email: 'hong@example.com\r\nCc: x@example.com' },
      { phone: '010\n0000' }
    ];
    for (const c of cases) {
      const res = await request(server, 'POST', '/api/contact', validPayload(c));
      assert.equal(res.status, 400, JSON.stringify(c));
    }
    assert.equal(sent.length, 0);
  });

  test('newlines inside message body are allowed', async () => {
    const res = await request(server, 'POST', '/api/contact', validPayload({ message: '첫 줄\r\n둘째 줄\n셋째 줄' }));
    assert.equal(res.status, 200);
    assert.ok(sent[0].text.includes('첫 줄\n둘째 줄\n셋째 줄'));
  });

  test('rate limit: 6th request within 10 min → 429', async () => {
    for (let i = 1; i <= 5; i++) {
      const res = await request(server, 'POST', '/api/contact', validPayload({ message: `문의 ${i}` }));
      assert.equal(res.status, 200, `request ${i}`);
    }
    const res = await request(server, 'POST', '/api/contact', validPayload({ message: '문의 6' }));
    assert.equal(res.status, 429);
    assert.equal(res.json.error, 'rate_limited');
    assert.equal(sent.length, 5);
  });

  test('duplicate guard: same email+message twice → 429', async () => {
    const first = await request(server, 'POST', '/api/contact', validPayload());
    assert.equal(first.status, 200);
    const second = await request(server, 'POST', '/api/contact', validPayload());
    assert.equal(second.status, 429);
    assert.equal(second.json.error, 'duplicate');
    assert.equal(sent.length, 1);
  });

  test('duplicate guard: failed send does NOT block an identical retry', async () => {
    await new Promise((r) => server.close(r));
    let failNext = true;
    sent = [];
    const app = createApp({
      config: baseConfig(),
      sendMail: async (mail) => {
        if (failNext) {
          failNext = false;
          const e = new Error('smtp down');
          e.code = 'ECONNECTION';
          throw e;
        }
        sent.push(mail);
        return { messageId: 'fake' };
      },
      verifyTurnstile: async () => true
    });
    server = await listen(app);

    const first = await request(server, 'POST', '/api/contact', validPayload());
    assert.equal(first.status, 502, 'first attempt fails at SMTP');
    assert.equal(sent.length, 0);

    const retry = await request(server, 'POST', '/api/contact', validPayload());
    assert.equal(retry.status, 200, 'identical retry must succeed, not 429');
    assert.equal(sent.length, 1);

    const third = await request(server, 'POST', '/api/contact', validPayload());
    assert.equal(third.status, 429, 'after a successful send the duplicate guard applies');
    assert.equal(third.json.error, 'duplicate');
    assert.equal(sent.length, 1);
  });

  test('startup: production without TURNSTILE_SECRET is refused, others allowed', () => {
    assert.match(startupError(baseConfig({ nodeEnv: 'production', turnstileSecret: '' })), /TURNSTILE_SECRET/);
    assert.equal(startupError(baseConfig({ nodeEnv: 'production', turnstileSecret: 'x' })), null);
    assert.equal(startupError(baseConfig({ nodeEnv: 'development', turnstileSecret: '' })), null);
    assert.equal(startupError(baseConfig({ nodeEnv: 'test', turnstileSecret: '' })), null);
  });

  test('turnstile: verified when secret set, rejected when verifier fails', async () => {
    await new Promise((r) => server.close(r));
    await boot({ turnstileSecret: 'secret-123' });

    let res = await request(server, 'POST', '/api/contact', validPayload());
    assert.equal(res.status, 400, 'token missing');
    assert.equal(res.json.error, 'captcha_failed');

    turnstileResult = false;
    res = await request(server, 'POST', '/api/contact', validPayload({ turnstileToken: 'tok-bad' }));
    assert.equal(res.status, 400, 'verifier false');
    assert.equal(sent.length, 0);

    turnstileResult = true;
    res = await request(server, 'POST', '/api/contact', validPayload({ turnstileToken: 'tok-good', message: '다른 내용' }));
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(turnstileCalls.at(-1).secret, 'secret-123');
    assert.equal(turnstileCalls.at(-1).token, 'tok-good');
  });

  test('smtp failure → 502 generic error', async () => {
    await new Promise((r) => server.close(r));
    const app = createApp({
      config: baseConfig(),
      sendMail: async () => {
        const e = new Error('ECONNREFUSED secret-host');
        e.code = 'ECONNREFUSED';
        throw e;
      },
      verifyTurnstile: async () => true
    });
    server = await listen(app);
    const res = await request(server, 'POST', '/api/contact', validPayload());
    assert.equal(res.status, 502);
    assert.deepEqual(res.json, { ok: false, error: 'send_failed' });
    assert.ok(!res.raw.includes('secret-host'));
  });

  test('malformed / oversized JSON → JSON error, not HTML', async () => {
    let res = await request(server, 'POST', '/api/contact', '{not json');
    assert.equal(res.status, 400);
    assert.equal(res.json.ok, false);

    res = await request(server, 'POST', '/api/contact', validPayload({ message: 'x'.repeat(20000) }));
    assert.equal(res.status, 413);
    assert.equal(res.json.error, 'too_large');
  });

  test('CORS: no header by default, header only for allowed origin', async () => {
    let res = await request(server, 'GET', '/api/health', undefined, { Origin: 'https://evil.example' });
    assert.equal(res.headers['access-control-allow-origin'], undefined);

    await new Promise((r) => server.close(r));
    await boot({ allowedOrigins: ['https://www.enclu.co.kr'] });
    res = await request(server, 'GET', '/api/health', undefined, { Origin: 'https://www.enclu.co.kr' });
    assert.equal(res.headers['access-control-allow-origin'], 'https://www.enclu.co.kr');
    res = await request(server, 'GET', '/api/health', undefined, { Origin: 'https://evil.example' });
    assert.equal(res.headers['access-control-allow-origin'], undefined);
    res = await request(server, 'OPTIONS', '/api/contact', undefined, { Origin: 'https://www.enclu.co.kr' });
    assert.equal(res.status, 204);
  });

  test('security headers from helmet are present', async () => {
    const res = await request(server, 'GET', '/api/health');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-powered-by'], undefined);
  });

  test('unknown route → 404 JSON', async () => {
    const res = await request(server, 'GET', '/api/nope');
    assert.equal(res.status, 404);
    assert.equal(res.json.error, 'not_found');
  });
});
