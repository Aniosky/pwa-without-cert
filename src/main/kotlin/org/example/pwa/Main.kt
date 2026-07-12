package org.example.pwa

import com.sun.net.httpserver.Headers
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

private const val PUBLIC_ROOT = "public"
private const val RESPONSE_STATUS_ATTRIBUTE = "responseStatus"

fun main() {
    val port = System.getenv("PORT")?.toIntOrNull() ?: 8080
    val startedAt = Instant.now()
    val liveRequests = AtomicInteger()
    val server = HttpServer.create(InetSocketAddress("0.0.0.0", port), 0)

    server.createContext("/") { exchange ->
        val requestStartedNanos = System.nanoTime()
        var failure: Throwable? = null
        try {
            route(exchange, startedAt, liveRequests)
        } catch (error: Throwable) {
            failure = error
            val body = """{"ok":false,"error":"${jsonEscape(error.message ?: "internal error")}"}"""
            sendBytes(
                exchange = exchange,
                status = 500,
                bytes = body.toByteArray(StandardCharsets.UTF_8),
                contentType = "application/json; charset=utf-8",
                extraHeaders = mapOf("Cache-Control" to "no-store")
            )
        } finally {
            logAccess(exchange, requestStartedNanos, failure)
            exchange.close()
        }
    }

    server.executor = Executors.newCachedThreadPool()
    server.start()
    println("PWA certificate/cache demo is running on http://localhost:$port")
}

private fun route(exchange: HttpExchange, startedAt: Instant, liveRequests: AtomicInteger) {
    val method = exchange.requestMethod.uppercase(Locale.ROOT)
    if (method != "GET" && method != "HEAD") {
        sendText(exchange, 405, "Method Not Allowed", "text/plain; charset=utf-8")
        return
    }

    when (exchange.requestURI.path) {
        "/api/domain-state" -> sendDomainState(exchange, startedAt, liveRequests.incrementAndGet())
        "/api/bootstrap" -> sendBootstrapState(exchange, startedAt)
        else -> serveStatic(exchange)
    }
}

private fun sendDomainState(exchange: HttpExchange, startedAt: Instant, requestId: Int) {
    val now = Instant.now()
    val origin = publicOrigin(exchange)
    val json = """
        {
          "ok": true,
          "source": "domain",
          "mode": "valid-certificate",
          "requestId": $requestId,
          "origin": "${jsonEscape(origin)}",
          "host": "${jsonEscape(exchange.requestHeaders.first("Host") ?: "unknown")}",
          "servedAt": "${jsonEscape(now.toString())}",
          "serverStartedAt": "${jsonEscape(startedAt.toString())}",
          "message": "Запрос выполнен к домену. Этот ответ можно сохранить в кэше."
        }
    """.trimIndent()

    sendBytes(
        exchange = exchange,
        status = 200,
        bytes = json.toByteArray(StandardCharsets.UTF_8),
        contentType = "application/json; charset=utf-8",
        extraHeaders = mapOf(
            "Cache-Control" to "no-store, max-age=0",
            "Pragma" to "no-cache",
            "X-PWA-Source" to "domain"
        )
    )
}

private fun sendBootstrapState(exchange: HttpExchange, startedAt: Instant) {
    val now = Instant.now()
    val json = """
        {
          "ok": true,
          "source": "bootstrap-cache",
          "mode": "precache",
          "requestId": 0,
          "origin": "precache",
          "host": "precache",
          "servedAt": "${jsonEscape(now.toString())}",
          "serverStartedAt": "${jsonEscape(startedAt.toString())}",
          "message": "Начальный кэш создан во время установки service worker."
        }
    """.trimIndent()

    sendBytes(
        exchange = exchange,
        status = 200,
        bytes = json.toByteArray(StandardCharsets.UTF_8),
        contentType = "application/json; charset=utf-8",
        extraHeaders = mapOf("Cache-Control" to "no-store")
    )
}

private fun serveStatic(exchange: HttpExchange) {
    val decodedPath = URLDecoder.decode(exchange.requestURI.path, StandardCharsets.UTF_8)
    val requestedPath = when {
        decodedPath == "/" || decodedPath == "/index.html" -> "/login.html"
        decodedPath.contains("..") || decodedPath.contains('\\') -> {
            sendText(exchange, 400, "Bad Request", "text/plain; charset=utf-8")
            return
        }
        else -> decodedPath
    }

    val resourcePath = PUBLIC_ROOT + requestedPath
    val resourceWithPath = resourceStream(resourcePath)?.let { it to requestedPath }
        ?: if (!requestedPath.substringAfterLast('/').contains('.')) {
            resourceStream("$PUBLIC_ROOT/login.html")?.let { it to "/login.html" }
        } else {
            null
        }

    if (resourceWithPath == null) {
        sendText(exchange, 404, "Not Found", "text/plain; charset=utf-8")
        return
    }

    val (resource, responsePath) = resourceWithPath
    val bytes = resource.use(InputStream::readBytes)
    val cacheControl = when {
        requestedPath == "/sw.js" -> "public, max-age=86400"
        responsePath == "/login.html" || responsePath == "/business-error.html" -> "no-store, max-age=0"
        requestedPath == "/index.html" -> "no-cache"
        else -> "public, max-age=3600"
    }

    val headers = mutableMapOf("Cache-Control" to cacheControl)
    if (requestedPath == "/sw.js") {
        headers["Service-Worker-Allowed"] = "/"
    }
    if (responsePath == "/login.html") {
        headers["Access-Control-Allow-Origin"] = "*"
        headers["Access-Control-Expose-Headers"] = "Content-Type, X-PWA-Login-Source"
        headers["X-PWA-Login-Source"] = "primary"
    }

    sendBytes(
        exchange = exchange,
        status = 200,
        bytes = bytes,
        contentType = contentType(responsePath),
        extraHeaders = headers
    )
}

private fun sendText(exchange: HttpExchange, status: Int, text: String, contentType: String) {
    sendBytes(
        exchange = exchange,
        status = status,
        bytes = text.toByteArray(StandardCharsets.UTF_8),
        contentType = contentType,
        extraHeaders = emptyMap()
    )
}

private fun sendBytes(
    exchange: HttpExchange,
    status: Int,
    bytes: ByteArray,
    contentType: String,
    extraHeaders: Map<String, String>
) {
    exchange.setAttribute(RESPONSE_STATUS_ATTRIBUTE, status)
    val headers = exchange.responseHeaders
    headers["Content-Type"] = contentType
    headers["X-Content-Type-Options"] = "nosniff"
    headers["Referrer-Policy"] = "same-origin"
    headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
    extraHeaders.forEach { (name, value) -> headers[name] = value }

    if (exchange.requestMethod.equals("HEAD", ignoreCase = true)) {
        exchange.sendResponseHeaders(status, -1)
        return
    }

    exchange.sendResponseHeaders(status, bytes.size.toLong())
    exchange.responseBody.use { output -> output.write(bytes) }
}

private fun logAccess(exchange: HttpExchange, requestStartedNanos: Long, failure: Throwable?) {
    val durationMs = (System.nanoTime() - requestStartedNanos) / 1_000_000
    val status = exchange.getAttribute(RESPONSE_STATUS_ATTRIBUTE)?.toString()
        ?: if (failure == null) "-" else "500"
    val rawPath = exchange.requestURI.rawPath ?: exchange.requestURI.path ?: "-"
    val query = exchange.requestURI.rawQuery
    val target = if (query.isNullOrBlank()) rawPath else "$rawPath?$query"
    val remote = exchange.remoteAddress?.let { address ->
        "${address.address?.hostAddress ?: address.hostString}:${address.port}"
    } ?: "-"
    val failurePart = failure?.let { " error=${logValue(it.javaClass.simpleName)}" } ?: ""

    println(
        "access method=${logValue(exchange.requestMethod)}" +
            " target=${logValue(target)}" +
            " status=$status" +
            " durationMs=$durationMs" +
            " host=${logValue(exchange.requestHeaders.first("Host"))}" +
            " remote=${logValue(remote)}" +
            " forwardedFor=${logValue(exchange.requestHeaders.first("X-Forwarded-For"))}" +
            " pwaClient=${logValue(exchange.requestHeaders.first("X-PWA-Client"))}" +
            " pwaRequest=${logValue(exchange.requestHeaders.first("X-PWA-Request"))}" +
            " pwaVersion=${logValue(exchange.requestHeaders.first("X-PWA-Version"))}" +
            " pwaMode=${logValue(exchange.requestHeaders.first("X-PWA-Mode"))}" +
            " pwaSW=${logValue(exchange.requestHeaders.first("X-PWA-Service-Worker"))}" +
            " pwaTrace=${logValue(exchange.requestHeaders.first("X-PWA-Trace"))}" +
            failurePart
    )
}

private fun publicOrigin(exchange: HttpExchange): String {
    val proto = exchange.requestHeaders.first("X-Forwarded-Proto") ?: "http"
    val host = exchange.requestHeaders.first("X-Forwarded-Host")
        ?: exchange.requestHeaders.first("Host")
        ?: "localhost"
    return "$proto://$host"
}

private fun resourceStream(path: String): InputStream? =
    Thread.currentThread().contextClassLoader.getResourceAsStream(path)

private fun contentType(path: String): String =
    when (path.substringAfterLast('.', "").lowercase(Locale.ROOT)) {
        "html" -> "text/html; charset=utf-8"
        "css" -> "text/css; charset=utf-8"
        "js" -> "text/javascript; charset=utf-8"
        "json" -> "application/json; charset=utf-8"
        "webmanifest" -> "application/manifest+json; charset=utf-8"
        "png" -> "image/png"
        "svg" -> "image/svg+xml"
        else -> "application/octet-stream"
    }

private fun jsonEscape(value: String): String =
    buildString(value.length) {
        value.forEach { char ->
            when (char) {
                '\\' -> append("\\\\")
                '"' -> append("\\\"")
                '\b' -> append("\\b")
                '\u000C' -> append("\\f")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> {
                    if (char.code < 0x20) {
                        append("\\u")
                        append(char.code.toString(16).padStart(4, '0'))
                    } else {
                        append(char)
                    }
                }
            }
        }
    }

private fun logValue(value: String?): String {
    val safe = value?.takeIf { it.isNotBlank() } ?: "-"
    return "\"" + safe
        .replace("\\", "\\\\")
        .replace("\"", "\\\"")
        .replace("\r", "\\r")
        .replace("\n", "\\n") + "\""
}

private operator fun Headers.set(name: String, value: String) {
    set(name, listOf(value))
}

private fun Headers.first(name: String): String? = getFirst(name)
