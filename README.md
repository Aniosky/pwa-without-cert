# PWA Certificate Cache Demo

Демо показывает поведение установленной PWA, когда основной HTTPS-домен перестает проходить TLS-проверку.

Целевой сценарий:

1. Пользователь открывает установленную PWA.
2. Service worker всегда пытается скачать свежую страницу логина `/login.html` с основного домена.
3. Если TLS и сеть в порядке, показывается обычная страница логина.
4. Если сетевой запрос падает, в том числе из-за TLS-ошибки, показывается заранее закэшированная бизнес-страница `/business-error.html`.
5. На бизнес-странице есть действия: установить сертификаты Минцифры/НУЦ или открыть сервис в Яндекс Браузере.

Важно: JavaScript и service worker не получают точную причину TLS-ошибки. Истекший сертификат, отозванный сертификат, недоверенная цепочка, DNS-сбой и offline-режим для кода выглядят как обычный failed `fetch`.

## Состав проекта

- `src/main/kotlin/org/example/pwa/Main.kt` - небольшой Kotlin HTTP-сервер на `HttpServer`.
- `src/main/resources/public/login.html` - основная страница логина.
- `src/main/resources/public/business-error.html` - бизнес-страница fallback из кэша.
- `src/main/resources/public/sw.js` - service worker с precache и навигационным fallback.
- `src/main/resources/public/manifest.webmanifest` и `icons/` - установка PWA на домашний экран.
- `Caddyfile.sslip` - пример reverse proxy для публичного HTTPS-домена `5.165.202.228.sslip.io`.

Локальные ACME-ключи, сертификаты, бинарники Caddy/lego/cloudflared и build-артефакты не должны попадать в git. Они исключены через `.gitignore`.

## Как работает fallback

При установке service worker заранее сохраняет в Cache Storage:

- `/`
- `/login.html`
- `/business-error.html`
- `/manifest.webmanifest`
- иконки
- `/api/bootstrap`

Для precache используется cache-busting query `__pwa_precache_version` и `__pwa_precache_ts`, чтобы iOS не положил в Cache Storage старую HTML-страницу из HTTP-кэша.

При каждой навигации PWA выполняет сетевой запрос:

```js
fetch("/login.html", { cache: "no-store" })
```

Запрос ограничен таймаутом `1500ms`. Если ответ успешный, service worker возвращает свежий HTML логина. Если запрос упал или истек таймаут, service worker возвращает `/business-error.html` из Cache Storage.

Сервер дополнительно отдает `/login.html` и `/business-error.html` с:

```http
Cache-Control: no-store, max-age=0
```

Это нужно, чтобы обновление версии PWA не застревало на старых HTML-файлах.

## Версия PWA

Текущая версия активного login/fallback flow хранится в трех местах:

- `sw.js` в константе `VERSION`
- `login.html` в `data-login-version` и pill `v...`
- `business-error.html` в `data-error-version` и pill `v...`

В старом диагностическом экране `app.js` есть отдельная константа `APP_VERSION`; ее тоже нужно держать синхронной, чтобы заголовки `X-PWA-Version` и экранная версия не расходились при прямом использовании этого файла.

При изменении поведения PWA нужно синхронно поднять версию в активных файлах flow и в `app.js`, если используется диагностический экран. На экране логина и fallback-экране версия видна в верхнем блоке, чтобы на iPhone было понятно, обновился ли service worker и HTML.

## Заголовки для логов

Все внутренние запросы service worker маркируются заголовками:

- `X-PWA-Client: service-worker`
- `X-PWA-Request: precache | login-page | domain-state | cache-miss`
- `X-PWA-Version: <version>`
- `X-PWA-Mode: install | network`
- `X-PWA-Service-Worker: true`
- `X-PWA-Trace: <version>-<timestamp>-<random>`

Kotlin-сервер пишет эти поля в access log. По ним можно отличать системные запросы браузера к `/sw.js` от прикладных запросов PWA.

## Локальный запуск

```powershell
.\gradlew.bat run
```

Локально приложение откроется на:

```text
http://localhost:8080
```

Для проверки PWA на iPhone нужен публичный HTTPS-домен с валидным сертификатом. `localhost` и обычный HTTP для установки на домашний экран не подходят.

## Сборка для публичного теста

```powershell
.\gradlew.bat build installDist
```

Запуск JVM-сервера на порту `18080`:

```powershell
$env:PORT = "18080"
.\build\install\pwa_without_cert\bin\pwa_without_cert.bat
```

В рабочем тестовом окружении Kotlin-сервер слушает `127.0.0.1:18080`, а Caddy принимает публичный HTTPS на `443` и проксирует запросы в JVM-сервер.

## Caddy и сертификаты

Файл `Caddyfile.sslip` использует домен:

```text
5.165.202.228.sslip.io
```

Для валидного сертификата Caddy должен ссылаться на production-сертификат:

```caddy
tls .lego-prod/certificates/5.165.202.228.sslip.io.crt .lego-prod/certificates/5.165.202.228.sslip.io.key
```

Для имитации сломанного TLS Caddy переключается на staging-сертификат Let's Encrypt:

```caddy
tls .lego-staging/certificates/5.165.202.228.sslip.io.crt .lego-staging/certificates/5.165.202.228.sslip.io.key
```

Staging-сертификат криптографически корректный, но цепочка недоверенная для обычных браузеров. Для клиента это выглядит как TLS trust error.

Перезапуск Caddy:

```powershell
Get-Process caddy -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
.\.tools\caddy\caddy.exe run --config Caddyfile.sslip
```

Если Caddy запускается через `Start-Process`, stdout/stderr удобно писать в `build/caddy-sslip.log` и `build/caddy-sslip.err`.

## Процесс проверки на iPhone

1. Вернуть валидный production-сертификат в `Caddyfile.sslip`.
2. Перезапустить Caddy.
3. Открыть `https://5.165.202.228.sslip.io/` в Safari на iPhone.
4. Убедиться, что на странице логина видна актуальная версия.
5. Установить PWA через Share -> Add to Home Screen.
6. Открыть PWA с домашнего экрана и дождаться, что service worker закэшировал `/business-error.html`.
7. Переключить Caddy на staging-сертификат.
8. Перезапустить Caddy.
9. Открыть PWA снова.

Ожидаемый результат при сломанном TLS: вместо белого/черного экрана открывается закэшированная бизнес-страница с кнопками установки сертификатов и открытия Яндекс Браузера.

## Проверка TLS с компьютера

Валидный сертификат:

```powershell
Invoke-WebRequest -UseBasicParsing https://5.165.202.228.sslip.io/ -TimeoutSec 10
```

Сломанный сертификат должен падать с ошибкой доверия TLS:

```powershell
try {
  Invoke-WebRequest -UseBasicParsing https://5.165.202.228.sslip.io/ -TimeoutSec 10
} catch {
  $_.Exception.Message
}
```

Проверить, что сервер при этом живой за сломанным TLS:

```powershell
curl.exe -k -I https://5.165.202.228.sslip.io/business-error.html
```

Ожидаемо будет `HTTP/1.1 200 OK`, потому что `-k` отключает проверку сертификата только для диагностического curl-запроса.

## Логи

Логи JVM-сервера:

```powershell
Get-Content -Wait .\build\public-server-18080.log
```

Логи Caddy access:

```powershell
Get-Content -Wait .\build\caddy-sslip-access.log
```

В серверных логах важны поля:

```text
pwaClient="service-worker"
pwaRequest="precache"
pwaVersion="2026-07-13.12"
pwaMode="install"
pwaTrace="..."
```

Если браузер сам проверяет обновление service worker и запрашивает `/sw.js`, у такого запроса не будет `X-PWA-*` заголовков. Это системный запрос браузера, а не прикладной запрос PWA.

## Ограничения платформы

- Установка PWA и service worker на iOS требуют secure context, поэтому первый успешный запуск и precache должны пройти через валидный HTTPS.
- Если TLS уже сломан до первой установки, service worker не установится и кэша не будет.
- При сломанном TLS нельзя скачать обновленный `sw.js`, `login.html` или `business-error.html` с основного домена. Будет работать только то, что уже лежит в Cache Storage.
- Service worker может обработать навигацию только после того, как он был установлен и активирован в валидном HTTPS-сеансе.
- Браузер может делать собственный запрос к `/sw.js` при открытии PWA. Полностью запретить этот системный запрос из service worker нельзя.

## Возврат к нормальному состоянию

1. Переключить `Caddyfile.sslip` обратно на `.lego-prod`.
2. Перезапустить Caddy.
3. Проверить обычный HTTPS-запрос через `Invoke-WebRequest`.
4. Открыть PWA на iPhone и убедиться, что снова отображается обычная страница логина.
