# 문의 폼 메일 발송 API 운영 가이드

홈페이지 `문의하기` 폼은 `mailto:` 대신 서버의 `POST /api/contact` 로 JSON 을 보내고, 서버가 SMTP 로 `info@enclu.co.kr` 에 메일을 발송합니다.
API 가 없는 환경(GitHub Pages 등)에서는 자동으로 기존 `mailto:` 동작으로 폴백합니다.

```
브라우저 ──POST /api/contact──▶ IIS (web.config 리라이트) ──▶ Node(PM2, :3200) ──SMTP──▶ info@enclu.co.kr
```

| 경로 | 역할 |
|---|---|
| `api/server.js` | Express 서비스 본체 |
| `api/ecosystem.config.js` | PM2 앱 정의 (`enclu-contact-api`) |
| `api/.env.example` | 환경 변수 예시 → 복사해서 `.env` 작성 |
| `web.config` | IIS 정적 서빙 + `/api/*` 프록시 + 보안 헤더 |
| `deploy.bat` | 서버에서 pull → install → pm2 재기동 |

---

## 1. 서버 `.env` 설정

서버의 `D:\WWW_ROOT\ENCLU_EC_RENEWAL\enclu-homepage\api\` 에서 `.env.example` 을 `.env` 로 복사한 뒤 값을 채웁니다. `.env` 는 git 에 올라가지 않습니다.

```
PORT=3200
NODE_ENV=production

SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=noreply@enclu.co.kr
SMTP_PASS=********
MAIL_FROM="ENCLU 홈페이지 <noreply@enclu.co.kr>"
MAIL_TO=info@enclu.co.kr
CUSTOMER_ACK_ENABLED=true

TURNSTILE_SECRET=0x4AAAAAAA...
ALLOWED_ORIGINS=
```

| 변수 | 설명 |
|---|---|
| `SMTP_HOST` / `SMTP_PORT` | 메일 서버 주소·포트. 보통 587(STARTTLS) 또는 465(SMTPS) |
| `SMTP_SECURE` | 465 포트면 `true`, 587 포트면 `false` |
| `SMTP_USER` / `SMTP_PASS` | SMTP 로그인 계정. Gmail/Workspace 는 앱 비밀번호 사용 |
| `MAIL_FROM` | 발신자 표시. SMTP 계정과 같은 도메인이어야 스팸 처리되지 않음 |
| `MAIL_TO` | 수신자. 기본값 `info@enclu.co.kr`. 고객 확인 메일의 "추가 문의" 연락처로도 표시됨 |
| `CUSTOMER_ACK_ENABLED` | 고객 접수 확인 메일 발송 여부. 기본 `true`. `false` 로 두면 담당자 알림만 발송 |
| `NODE_ENV` | PM2 가 `production` 으로 고정. production 에서는 `TURNSTILE_SECRET` 이 없으면 **기동을 거부(exit 1)** 하므로 봇 검증이 빠진 채 운영될 수 없음. 로컬에서만 `development` 사용 |
| `TURNSTILE_SECRET` | Cloudflare Turnstile **Secret key**. production 에서 필수. development/test 에서만 비울 수 있고 그때는 검증을 건너뛰며 기동 로그에 경고만 남김 |
| `ALLOWED_ORIGINS` | 다른 도메인에서 호출할 때만 콤마로 나열. 비우면 CORS 헤더를 내보내지 않음(same-origin 전용) |

> 제목은 `[홈페이지 문의] {문의 유형} - {회사명}`, 본문은 평문이며 `Reply-To` 가 문의자 이메일로 설정되어 메일 앱에서 바로 답장할 수 있습니다.

### 고객 접수 확인 메일

담당자 알림 메일이 **성공한 뒤** 문의자 이메일로 `[ENCLU] 문의가 정상 접수되었습니다` 확인 메일을 한 통 더 보냅니다(`CUSTOMER_ACK_ENABLED=true`, 기본).

- 내용: ENCLU 로고, "{이름}님, ENCLU 에 문의해 주셔서 감사합니다" 인사말, 접수 내역(문의 유형·이름·회사·연락처·접수 시각·문의 내용), "담당자가 영업일 기준 1~2일 내 연락드립니다", 홈페이지 버튼, 발신 전용 안내, 수신 주소 표기. HTML + 평문 두 버전이며 HTML 에 끼워 넣는 값은 모두 이스케이프됩니다(문의 내용의 줄바꿈은 `<br>` 로 유지).
- **제출한 내용을 그대로 되돌려 보냅니다.** 이름·회사·연락처·문의 본문이 확인 메일에 포함되므로, 폼을 "임의 주소로 임의 문구를 보내는 중계기"로 쓰는 악용은 아래의 **수신 주소당 확인 메일 상한**(24시간 3통, `ACK_PER_EMAIL_LIMIT` / `ACK_PER_EMAIL_WINDOW_MS`)으로 막습니다. 상한을 넘으면 담당자 알림은 그대로 보내고 확인 메일만 건너뛰며 로그에 `ack skipped` (`reason: per_email_limit`) 를 남깁니다. 문의 유형은 `index.html` 의 `<select name="type">` option 값(`server.js` 의 `INQUIRY_TYPES`)과 정확히 일치할 때만 표시하며 아니면 행 자체를 생략합니다. select 항목을 바꾸면 `INQUIRY_TYPES` 도 함께 수정합니다.
- `From` 은 `MAIL_FROM`, `Reply-To` 는 설정하지 않으며 `Auto-Submitted: auto-replied`, `X-Auto-Response-Suppress: All` 헤더를 붙여 부재중 자동회신과의 메일 루프를 막습니다.
- 본문의 "추가 문의는 홈페이지 문의 폼 또는 {MAIL_TO} 로" 안내에는 `MAIL_TO` 값이 들어갑니다.
- 확인 메일은 **`{"ok":true}` 응답을 보낸 뒤 비동기로** 발송하므로 SMTP 가 느려도 폼 응답이 지연되지 않습니다. 10초(`ACK_TIMEOUT_MS`) 안에 끝나지 않거나 실패하면(수신 주소 오류 등) 로그에 `ack send failed` 경고(`reason: ETIMEDOUT` 등)만 남고 응답에는 영향이 없습니다. 담당자에게는 이미 전달된 상태입니다.

### Cloudflare Turnstile 키 발급

1. Cloudflare 대시보드 → **Turnstile** → **Add widget**
2. Hostname 에 `www.enclu.co.kr`, `enclu.co.kr` 등록 (로컬 테스트용으로 `localhost` 추가 가능)
3. Widget Mode 는 **Managed** 권장
4. 발급된 **Site key** → `index.html` 의 meta 태그에, **Secret key** → 서버 `.env` 의 `TURNSTILE_SECRET` 에 입력

## 2. `index.html` 사이트 키 설정

`<head>` 안의 아래 한 줄만 수정합니다. 폼의 Turnstile 위젯과 스크립트는 이 값을 읽어 동작합니다.

```html
<meta name="turnstile-sitekey" content="0x4AAAAAAA_site_key">
```

- 비워 두면(`content=""`) Turnstile 스크립트를 아예 불러오지 않고, 위젯 없이 토큰 없이 전송합니다. 서버에 `TURNSTILE_SECRET` 이 설정되어 있으면 이 경우 모든 전송이 `captcha_failed` 로 거부되므로 **양쪽을 함께 설정**해야 합니다.
- 운영 서버는 `NODE_ENV=production` 이라 `TURNSTILE_SECRET` 없이는 기동되지 않습니다. 따라서 운영 배포 전에 meta 사이트 키도 반드시 채웁니다.
- GitHub Pages 에 올라가는 사본은 API 가 없으므로 비워 두어도 무방합니다.

## 3. IIS ARR 사전 조건

이미 설치된 환경 기준으로 확인만 하면 됩니다.

1. **URL Rewrite** 모듈 설치 확인 (IIS 관리자 → 사이트 → "URL 재작성" 아이콘이 보이면 OK)
2. **Application Request Routing(ARR)** 설치 확인
3. IIS 관리자 → **서버 노드** → "Application Request Routing Cache" → 오른쪽 **Server Proxy Settings** → **Enable proxy** 체크 → 적용
   - 이 설정이 없으면 `/api/*` 요청이 502 또는 404 로 떨어집니다.
4. 사이트 물리 경로가 `D:\WWW_ROOT\ENCLU_EC_RENEWAL\enclu-homepage` (web.config 가 있는 폴더) 인지 확인
5. 방화벽: 3200 포트는 **외부에 열지 않습니다**. IIS 가 localhost 로만 접근합니다.

`web.config` 의 리라이트 규칙은 `^api/(.*)$` → `http://localhost:3200/api/{R:1}` 입니다. 포트를 바꾸면 `.env` 의 `PORT` 와 web.config 를 함께 수정합니다.

ARR 는 기본적으로 `X-Forwarded-For` 헤더에 실제 클라이언트 IP 를 넣어 전달하며, 서버는 `trust proxy = 1` 로 그 값을 신뢰합니다(IP 기준 속도 제한에 사용).

## 4. 배포 / 기동

```bat
cd /d D:\WWW_ROOT\ENCLU_EC_RENEWAL\enclu-homepage
deploy.bat
```

`deploy.bat` 은 `git pull origin main` → `api` 에서 `npm install --omit=dev` → `pm2 delete` 후 `pm2 start ecosystem.config.js` → `pm2 save` 를 순서대로 실행합니다.

서버 재부팅 후 자동 기동이 필요하면 최초 1회 `pm2-windows-startup` 또는 작업 스케줄러에 `pm2 resurrect` 를 등록합니다.

로그 확인:

```bat
pm2 logs enclu-contact-api
```

로그에는 접수 IP·문의 유형·거부 사유만 남고 **문의 내용·이메일·비밀값은 기록하지 않습니다.**

## 5. 검증 절차

### 5-1. 서비스 직접 확인 (서버 안에서)

```bat
curl http://localhost:3200/api/health
```

기대 응답: `{"ok":true}`

### 5-2. IIS 프록시 경유 확인

```bat
curl https://www.enclu.co.kr/api/health
```

같은 `{"ok":true}` 가 와야 합니다. 404/502 면 3번(ARR Enable proxy) 또는 PM2 상태(`pm2 status`)를 확인합니다.

### 5-3. 실제 메일 발송 테스트

Turnstile 이 켜져 있으면 curl 로는 토큰을 만들 수 없습니다. production 에서는 `TURNSTILE_SECRET` 을 비우면 기동 자체가 거부되므로, 대신 Cloudflare 가 제공하는 **테스트용 Secret key** `1x0000000000000000000000000000000AA`(항상 성공) 를 `.env` 에 넣고 `pm2 restart enclu-contact-api` 한 뒤 아래를 실행합니다. 이때 `turnstileToken` 은 아무 문자열이나 넣습니다. 확인 후 실제 키로 되돌리고 재기동합니다.

```bat
curl -X POST https://www.enclu.co.kr/api/contact ^
  -H "Content-Type: application/json" ^
  -d "{\"type\":\"기타\",\"company\":\"테스트\",\"name\":\"담당자\",\"email\":\"test@example.com\",\"phone\":\"010-0000-0000\",\"message\":\"발송 테스트\",\"consent\":true,\"website\":\"\",\"turnstileToken\":\"test\"}"
```

기대 응답: `{"ok":true}` 이고 `info@enclu.co.kr` 에 `[홈페이지 문의] 기타 - 테스트` 메일 도착. `CUSTOMER_ACK_ENABLED` 가 켜져 있으면 `test@example.com` 에도 `[ENCLU] 문의가 정상 접수되었습니다` 확인 메일이 갑니다(실제 수신 가능한 주소로 바꿔 확인).

| 응답 | 의미 |
|---|---|
| `{"ok":false,"error":"invalid_input"}` 400 | 필수값 누락·길이 초과·이메일 형식·동의 미체크·줄바꿈 포함 |
| `{"ok":false,"error":"captcha_failed"}` 400 | Turnstile 토큰 없음 또는 검증 실패 |
| `{"ok":false,"error":"rate_limited"}` 429 | IP 당 10분 5회 또는 전역 1분 60회 초과 |
| `{"ok":false,"error":"duplicate"}` 429 | 같은 이메일+내용 10분 내 재전송 |
| `{"ok":false,"error":"send_failed"}` 502 | SMTP 발송 실패 → `.env` SMTP 값과 `pm2 logs` 확인 |
| `{"ok":false,"error":"too_large"}` 413 | 본문 16KB 초과 |

### 5-4. 브라우저 확인

홈페이지 문의 폼에서 실제로 전송해 보고 버튼 아래에 "문의가 접수되었어요" 가 뜨는지, 30초 동안 버튼이 비활성화되는지 확인합니다.

### 5-5. 로컬 개발 확인

```bash
cd api
npm install
npm test          # node:test 기반, 네트워크 없이 실행
npm start         # http://localhost:3200
```

## 6. 보호 계층별 역할

요청은 아래 순서로 걸러집니다. 각 층이 무엇을 막는지:

| 층 | 위치 | 막는 것 |
|---|---|---|
| CSP / Referrer-Policy meta | `index.html` | 허용하지 않은 외부 스크립트·프레임 주입, 리퍼러 유출 |
| 보안 응답 헤더 | `web.config`, helmet | MIME 스니핑, 클릭재킹(iframe 삽입), 불필요한 브라우저 권한 |
| 요청 본문 64KB / 16KB | `web.config` `/api`, Express | 대용량 본문으로 메모리 소진 |
| 클라이언트 가드 | `index.html` | 페이지 로드 3초 내 전송(스크립트 봇), 중복 클릭, 30초 내 재전송, 길이 초과 |
| 허니팟 `website` | 서버 | 숨은 필드를 채우는 단순 봇 — 200 으로 응답해 봇이 차단 여부를 학습하지 못하게 함 |
| 필드 검증 + CRLF 거부 | 서버 | 필수값 누락, 길이 초과, 잘못된 이메일, **메일 헤더 인젝션**(제목/Reply-To 에 줄바꿈으로 Bcc 등 삽입) |
| Cloudflare Turnstile | 서버 ↔ Cloudflare | 헤드리스 브라우저·자동화 도구 등 사람 아닌 트래픽. production 에서는 Secret 없이 기동 불가(fail-closed) |
| 속도 제한 (IP) | 서버 | 한 IP 의 대량 전송: `/api/contact` 10분 5회, `/api/*` 전체 1분 60회 |
| 중복 가드 | 서버 (메모리) | 같은 이메일+내용 10분 내 반복 전송 (더블클릭·스팸 반복). 발송 **성공 후에만** 기록하므로 SMTP 실패 뒤 재시도는 막지 않음 |
| 확인 메일 수신 주소별 상한 | 서버 (메모리) | 확인 메일이 제출 내용(이름·회사·연락처·문의 내용)을 그대로 되돌려 보내므로, 폼을 제3자 주소로 임의 문구를 보내는 중계기로 쓰는 백스캐터·스팸. 수신 주소(소문자 기준)당 **24시간 3통**(`ACK_PER_EMAIL_LIMIT`). 넘으면 담당자 알림은 보내고 확인 메일만 생략, 로그 `ack skipped` / `per_email_limit`. 발송 시도 시점에 세므로 SMTP 실패로 우회할 수 없음 |
| CORS 제한 | 서버 | 다른 사이트에서 브라우저로 API 호출 (기본 same-origin 만) |
| 로그 최소화 | 서버 | 문의 내용·개인정보·비밀값이 로그 파일로 유출되는 것 |

주의: 속도 제한·중복 가드·확인 메일 상한은 프로세스 메모리에 있으므로 PM2 재기동 시 초기화되며, 인스턴스를 여러 개로 늘리면 인스턴스별로 따로 셉니다(현재 1개 고정).
