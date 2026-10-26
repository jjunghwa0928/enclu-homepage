'use strict';

// 실행: cd api && npm test   (node --test)
// 네트워크를 쓰지 않도록 가짜 메일 전송기·가짜 Turnstile 검증기를 주입한다.

process.env.NODE_ENV = 'test';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp, loadConfig, startupError, buildCustomerAckMail, INQUIRY_TYPES, ACK_TIMEOUT_MS } = require('../server');

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
    // 기본 테스트는 담당자 알림 1통만 검사한다. 고객 확인 메일은 아래 'customer ack mail' 블록에서 켜고 검사.
    customerAckEnabled: false,
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

describe('customer ack mail', () => {
  let server;
  let calls; // sendMail 에 들어온 모든 호출 (성공·실패·대기 포함)
  let sent; // 실제로 resolve 된 메일
  let waiters;

  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

  /** sendMail 이 n 번 호출될 때까지 기다린다 — 고객 확인 메일은 응답 뒤 비동기로 나가므로 이걸로 동기화 */
  function waitForCalls(n) {
    return new Promise((resolve) => {
      if (calls.length >= n) return resolve();
      waiters.push({ n, resolve });
    });
  }

  /**
   * behavior(mail, callNo) 는 n 번째 호출의 동작을 바꿀 때만 넘긴다:
   * throw → 실패, 영원히 pending 인 Promise 반환 → 멈춤, 그 외 → 성공.
   */
  async function boot(configOverrides = {}, behavior, appOptions = {}) {
    calls = [];
    sent = [];
    waiters = [];
    const app = createApp({
      config: baseConfig({ customerAckEnabled: true, ...configOverrides }),
      sendMail: async (mail) => {
        calls.push(mail);
        const n = calls.length;
        waiters = waiters.filter((w) => {
          if (n >= w.n) {
            w.resolve();
            return false;
          }
          return true;
        });
        if (behavior) await behavior(mail, n);
        sent.push(mail);
        return { messageId: 'fake' };
      },
      verifyTurnstile: async () => true,
      ...appOptions
    });
    server = await listen(app);
  }

  beforeEach(() => boot());
  afterEach(() => new Promise((r) => server.close(r)));

  test('loadConfig: CUSTOMER_ACK_ENABLED defaults to true, "false" disables', () => {
    assert.equal(loadConfig({}).customerAckEnabled, true);
    assert.equal(loadConfig({ CUSTOMER_ACK_ENABLED: '' }).customerAckEnabled, true);
    assert.equal(loadConfig({ CUSTOMER_ACK_ENABLED: 'true' }).customerAckEnabled, true);
    assert.equal(loadConfig({ CUSTOMER_ACK_ENABLED: 'false' }).customerAckEnabled, false);
    assert.equal(loadConfig({ CUSTOMER_ACK_ENABLED: 'FALSE' }).customerAckEnabled, false);
  });

  test('ack goes out as the second sendMail call, to the customer, after the staff mail', async () => {
    const res = await request(server, 'POST', '/api/contact', validPayload());
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });

    await waitForCalls(2);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].to, 'info@enclu.co.kr', 'staff notification first');
    const ack = calls[1];
    assert.equal(ack.to, 'hong@example.com');
    assert.equal(ack.from, 'noreply@enclu.co.kr');
    assert.equal(ack.replyTo, undefined, 'no Reply-To on the auto-reply');
    assert.equal(ack.subject, '[ENCLU] 문의가 정상 접수되었습니다');
    assert.equal(typeof ack.text, 'string');
    assert.equal(typeof ack.html, 'string');
  });

  test('ack content: brand name, fixed greeting, whitelisted type + time only, SLA, no-reply notice with MAIL_TO, auto-reply headers', async () => {
    await new Promise((r) => server.close(r));
    await boot({ mailTo: 'help@enclu.co.kr' });
    await request(server, 'POST', '/api/contact', validPayload());
    await waitForCalls(2);
    const ack = calls[1];

    for (const body of [ack.text, ack.html]) {
      assert.ok(body.includes('ENCLU'));
      assert.ok(body.includes('문의가 정상 접수되었습니다'));
      assert.ok(body.includes('고객님, ENCLU 에 문의해 주셔서 감사합니다'));
      assert.ok(body.includes('문의 유형'));
      assert.ok(body.includes('브랜드 입점 문의'), 'whitelisted type is shown');
      assert.ok(body.includes('접수 시각'));
      assert.ok(body.includes('담당자가 영업일 기준 1~2일 내 연락드립니다'));
      assert.ok(body.includes('발신 전용(no-reply)이므로 회신하지 마세요'));
      assert.ok(body.includes('홈페이지 문의 폼 또는 help@enclu.co.kr'));
      // 자유 입력은 어떤 형태로도 되돌려 보내지 않는다
      assert.ok(!body.includes('회사명'));
      assert.ok(!body.includes('성함'));
      assert.ok(!body.includes('(주)엔클루'));
      assert.ok(!body.includes('홍길동'));
      assert.ok(!body.includes('일본 진출을 고민 중입니다.'), 'customer message must not be echoed back');
    }

    assert.equal(ack.headers['Auto-Submitted'], 'auto-replied');
    assert.equal(ack.headers['X-Auto-Response-Suppress'], 'All');
  });

  test('ack never contains attacker-controlled free text (name, company, non-whitelisted type)', async () => {
    const name = 'ATTACKER-NAME-9f3a 긴급 안내 http://evil.example/login';
    const company = 'ATTACKER-CO-7b2c <a href="http://evil.example">click</a>';
    const type = '기타 — 계정 정지 예정 http://evil.example';
    const res = await request(server, 'POST', '/api/contact', validPayload({ name, company, type }));
    assert.equal(res.status, 200);
    await waitForCalls(2);
    const ack = calls[1];

    for (const body of [ack.text, ack.html]) {
      for (const needle of ['ATTACKER-NAME-9f3a', 'ATTACKER-CO-7b2c', 'evil.example', '계정 정지', '긴급 안내', '&lt;a href']) {
        assert.ok(!body.includes(needle), `must not contain ${needle}`);
      }
      assert.ok(!body.includes('문의 유형'), 'non-whitelisted type → row omitted entirely');
      assert.ok(body.includes('접수 시각'), 'time row is kept');
    }
  });

  test('type whitelist matches index.html options exactly', () => {
    assert.deepEqual(INQUIRY_TYPES, ['브랜드 입점 문의', '플랫폼 제휴 문의', 'Weedy 관련 문의', '수출바우처 문의', '기타']);
    const meta = { receivedAt: '2026-10-26T01:02:03.000Z' };
    for (const type of INQUIRY_TYPES) {
      const mail = buildCustomerAckMail(baseConfig(), { ...validPayload(), type }, meta);
      assert.ok(mail.text.includes(`문의 유형: ${type}`), type);
      assert.ok(mail.html.includes(type), type);
    }
    for (const type of ['기타 ', '브랜드 입점 문의!', 'etc', '']) {
      const mail = buildCustomerAckMail(baseConfig(), { ...validPayload(), type }, meta);
      assert.ok(!mail.text.includes('문의 유형'), JSON.stringify(type));
      assert.ok(!mail.html.includes('문의 유형'), JSON.stringify(type));
    }
  });

  test('ack HTML escapes every interpolated value (contact address), text stays raw', () => {
    const mail = buildCustomerAckMail(baseConfig({ mailTo: 'help&ops <x>@enclu.co.kr' }), validPayload(), {
      receivedAt: '2026-10-26T01:02:03.000Z'
    });
    assert.ok(mail.html.includes('help&amp;ops &lt;x&gt;@enclu.co.kr'));
    assert.ok(!mail.html.includes('help&ops <x>'));
    assert.ok(mail.text.includes('help&ops <x>@enclu.co.kr'));
  });

  test('ack HTML: Google-style card with hosted logo, blue CTA, grey footer with recipient; user data escaped', () => {
    const email = "o'neil+<tag>@example.com";
    const mail = buildCustomerAckMail(baseConfig(), validPayload({ email }), { receivedAt: '2026-10-26T01:02:03.000Z' });
    const { html, text } = mail;

    // 로고 (호스팅 이미지 + alt 텍스트 폴백)
    assert.ok(html.includes('src="https://jjunghwa0928.github.io/enclu-homepage/assets/logo-enclu.png"'));
    assert.ok(html.includes('alt="ENCLU"'));

    // 카드: 회색 배경 위 흰색 카드, #dadce0 테두리, 8px 라운드
    assert.ok(html.includes('background:#f8f9fa'));
    assert.ok(html.includes('background:#ffffff;border:1px solid #dadce0;border-radius:8px'));
    assert.ok(!html.includes('#fef3c7'), 'no amber warning box');
    assert.ok(!html.includes('background:#111827'), 'no dark brand bar');

    // 파란 CTA 버튼 → 홈페이지
    assert.ok(html.includes('background:#1a73e8'));
    assert.ok(html.includes('href="https://www.enclu.com/"'));
    assert.ok(html.includes('>ENCLU 홈페이지</a>'));
    assert.ok(text.includes('ENCLU 홈페이지: https://www.enclu.com/'));

    // 푸터
    for (const body of [html, text]) {
      assert.ok(body.includes('이 메일은 발신 전용입니다.'));
    }
    assert.ok(html.includes('이 메일은 o&#39;neil+&lt;tag&gt;@example.com 으로 발송되었습니다.'));
    assert.ok(!html.includes(email), 'raw recipient address must not appear unescaped in HTML');
    assert.ok(text.includes(`이 메일은 ${email} 으로 발송되었습니다.`));

    // 이메일 클라이언트 호환: 테이블 레이아웃·인라인 스타일만 사용
    assert.ok(!/<style[\s>]/i.test(html));
    assert.ok(!/<link[\s>]/i.test(html));
    assert.ok(!/display:\s*(flex|grid)/i.test(html));

    // 텍스트 버전과 HTML 버전의 정보 순서가 같다
    const order = ['문의가 정상 접수되었습니다', '고객님, ENCLU 에 문의해 주셔서 감사합니다', '문의 유형', '접수 시각', '담당자가 영업일 기준', 'https://www.enclu.com/', '발신 전용(no-reply)', '이 메일은 발신 전용입니다.', '으로 발송되었습니다.'];
    for (const body of [html, text]) {
      let last = -1;
      for (const needle of order) {
        const idx = body.indexOf(needle, last + 1);
        assert.ok(idx > last, `${needle} must come after the previous item`);
        last = idx;
      }
    }
  });

  test('ack failure is logged only: response stays 200 ok, duplicate guard still recorded', async () => {
    await new Promise((r) => server.close(r));
    await boot({}, async (mail, n) => {
      if (n === 2) {
        const e = new Error('550 mailbox unavailable');
        e.code = 'EENVELOPE';
        throw e;
      }
    });

    const res = await request(server, 'POST', '/api/contact', validPayload());
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });
    assert.ok(!res.raw.includes('mailbox unavailable'));

    await waitForCalls(2);
    await tick();
    assert.equal(calls.length, 2, 'ack was attempted');
    assert.equal(sent.length, 1, 'only the staff mail went through');

    const again = await request(server, 'POST', '/api/contact', validPayload());
    assert.equal(again.status, 429, 'staff mail succeeded, so the duplicate guard applies');
  });

  test('ack hanging forever does not block the response; times out with a warn log', async () => {
    await new Promise((r) => server.close(r));
    assert.equal(ACK_TIMEOUT_MS, 10000, 'production default');
    const ackTimeoutMs = 200;
    await boot({}, (mail, n) => (n === 2 ? new Promise(() => {}) : undefined), { ackTimeoutMs });

    const lines = [];
    console.error = (...a) => lines.push(a.map(String).join(' '));
    try {
      const started = Date.now();
      const res = await request(server, 'POST', '/api/contact', validPayload());
      const elapsed = Date.now() - started;
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, { ok: true });
      assert.ok(elapsed < ackTimeoutMs, `response must not wait for the ack (took ${elapsed}ms)`);
      assert.ok(!lines.some((l) => l.includes('ack send failed')), 'timeout has not fired yet at response time');

      await waitForCalls(2);
      assert.equal(sent.length, 1, 'ack is still pending');

      await tick(ackTimeoutMs + 50);
      const warn = lines.find((l) => l.includes('ack send failed'));
      assert.ok(warn, 'timeout logged');
      assert.ok(warn.includes('WARN'));
      assert.ok(warn.includes('ETIMEDOUT'));
    } finally {
      console.error = () => {};
    }
  });

  test('staff mail failure → 502 and no ack attempted', async () => {
    await new Promise((r) => server.close(r));
    await boot({}, async () => {
      const e = new Error('smtp down');
      e.code = 'ECONNECTION';
      throw e;
    });

    const res = await request(server, 'POST', '/api/contact', validPayload());
    assert.equal(res.status, 502);
    await tick();
    assert.equal(calls.length, 1, 'ack must not be sent when the staff mail failed');
  });

  test('CUSTOMER_ACK_ENABLED=false → only the staff mail is sent', async () => {
    await new Promise((r) => server.close(r));
    const envConfig = loadConfig({ CUSTOMER_ACK_ENABLED: 'false' });
    await boot({ customerAckEnabled: envConfig.customerAckEnabled });

    const res = await request(server, 'POST', '/api/contact', validPayload());
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });
    await tick();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].to, 'info@enclu.co.kr');
  });

  test('buildCustomerAckMail: header fields pass through headerSafe', () => {
    const mail = buildCustomerAckMail(baseConfig(), { ...validPayload(), email: 'a@example.com\u0000' }, { receivedAt: '2026-10-26T01:02:03.000Z' });
    assert.equal(mail.to, 'a@example.com ');
    assert.ok(!/[\r\n]/.test(mail.subject));
    assert.ok(mail.text.includes('접수 시각: 2026. 10. 26.'));
    assert.ok(mail.text.includes('(KST)'));
  });
});
