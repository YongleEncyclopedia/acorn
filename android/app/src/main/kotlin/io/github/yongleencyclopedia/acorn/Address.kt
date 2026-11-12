package io.github.yongleencyclopedia.acorn

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.IDN
import java.net.URL
import java.net.URLEncoder
import java.net.UnknownHostException
import java.util.Base64
import javax.net.ssl.SSLException

// These helpers use no Android classes, so app/src/test runs them on a plain JVM.

/** A link inside a piece of text. It ends at white space or Chinese punctuation: "看看 https://example.com/a，很好". */
private val LINK_IN_TEXT = Regex("https?://[^\\s<>\"'，。、；：！？（）【】「」《》“”‘’]+", RegexOption.IGNORE_CASE)

private fun firstLink(text: String): String? =
    LINK_IN_TEXT.find(text)?.value?.trimEnd('.', ',', ';', ':', '!', '?', ')', ']', '}', '\'', '"')

/** A server address the user typed or scanned: the origins worth trying, best guess first. */
data class Target(
    val candidates: List<String>,
    /** `/login/<token>` when it was a one-time sign-in link: opening it signs this phone in. */
    val loginPath: String? = null,
)

/** Why an address did not answer as 松果. */
sealed class Failure(val origin: String) : Exception(origin) {
    class NotFound(origin: String, val host: String) : Failure(origin)
    class Unreachable(origin: String) : Failure(origin)
    class Untrusted(origin: String) : Failure(origin)
    class NotAcorn(origin: String) : Failure(origin)
}

object Address {
    const val DEFAULT_PORT = 7700

    private val SCHEME = Regex("^([a-zA-Z][a-zA-Z0-9+.-]*)://")
    private val HOST = Regex("^[\\p{L}\\p{N}_-]+(\\.[\\p{L}\\p{N}_-]+)*\\.?$")
    private val IPV4 = Regex("^\\d{1,3}(\\.\\d{1,3}){3}$")
    private val IPV6 = Regex("^[0-9a-fA-F:.]+$")
    private val LOGIN_PATH = Regex("^/login/[A-Za-z0-9_-]{16,}$")
    private val HEALTHY = Regex("\"ok\"\\s*:\\s*true")

    /**
     * Reads `192.168.1.20`, `nas.local`, `host:port`, `[fd7a:115c::1]:7700` or a full URL, a one-time sign-in link
     * (…/login/<token>) included. Without a scheme it is http://, without a port 7700. Null if it is no address.
     */
    fun parse(input: String): Target? {
        // typed on a Chinese keyboard: full-width full stop, colon, slash
        var s = input.trim().replace('。', '.').replace('．', '.').replace('：', ':').replace('／', '/')
        if (s.any { it.isWhitespace() }) s = firstLink(s) ?: return null // pasted with some text around it
        if (s.isEmpty()) return null
        val scheme = SCHEME.find(s)?.groupValues?.get(1)?.lowercase()
        if (scheme != null && scheme != "http" && scheme != "https") return null
        val rest = if (scheme != null) s.substring(scheme.length + 3) else s
        val authority = rest.takeWhile { it != '/' && it != '?' && it != '#' }
        val path = rest.substring(authority.length).substringBefore('?').substringBefore('#')
        val (host, port) = hostAndPort(authority.substringAfterLast('@')) ?: return null
        val candidates = when {
            port != null -> listOf(build(scheme ?: if (port == 443) "https" else "http", host, port))
            scheme == "https" -> listOf(build("https", host, null))
            // an explicit http:// without a port: port 80 as written, then 松果's own port
            scheme == "http" -> listOf(build("http", host, null), build("http", host, DEFAULT_PORT))
            // a bare domain may be a 松果 behind an HTTPS proxy (or `tailscale serve`); a .local name never is
            host.contains('.') && !IPV4.matches(host) && !host.startsWith("[") && !host.endsWith(".local") ->
                listOf(build("http", host, DEFAULT_PORT), build("https", host, null))
            else -> listOf(build("http", host, DEFAULT_PORT))
        }
        return Target(candidates, path.takeIf { LOGIN_PATH.matches(it) })
    }

    /** The sign-in link in a piece of text: a QR scanner app may share the code's content as text. */
    fun loginLink(text: String): String? = firstLink(text)?.takeIf { parse(it)?.loginPath != null }

    /** `scheme://host[:port]`, the way a browser writes an origin: lower case, no default port. */
    fun origin(scheme: String?, host: String?, port: Int?): String? {
        if (scheme.isNullOrEmpty() || host.isNullOrEmpty()) return null
        val s = scheme.lowercase()
        val h = host.lowercase().trimEnd('.').let { if (it.contains(':') && !it.startsWith("[")) "[$it]" else it }
        val p = port?.takeIf { it > 0 && it != defaultPort(s) }
        return if (p == null) "$s://$h" else "$s://$h:$p"
    }

    private fun build(scheme: String, host: String, port: Int?): String = origin(scheme, host, port)!!

    private fun defaultPort(scheme: String) = when (scheme) {
        "http" -> 80
        "https" -> 443
        else -> -1
    }

    private fun hostAndPort(s: String): Pair<String, Int?>? {
        if (s.isEmpty()) return null
        if (s.startsWith("[")) { // [IPv6] or [IPv6]:port
            val end = s.indexOf(']')
            if (end < 0 || !IPV6.matches(s.substring(1, end))) return null
            val host = s.substring(0, end + 1)
            val after = s.substring(end + 1)
            if (after.isEmpty() || after == ":") return host to null
            if (!after.startsWith(":")) return null
            return port(after.substring(1))?.let { host to it }
        }
        if (s.count { it == ':' } > 1) return if (IPV6.matches(s)) "[$s]" to null else null // a bare IPv6 address
        val name = s.substringBefore(':')
        if (!HOST.matches(name)) return null
        val host = (if (name.all { it.code < 128 }) name else runCatching { IDN.toASCII(name) }.getOrNull() ?: return null).lowercase()
        val portText = s.substringAfter(':', "")
        if (portText.isEmpty()) return host to null
        return port(portText)?.let { host to it }
    }

    private fun port(s: String): Int? = s.toIntOrNull()?.takeIf { it in 1..65535 }

    /**
     * Tries each candidate with `GET /api/health` and returns the origin of the first that answers {"ok":true},
     * after any redirects (an http address behind a proxy that moves to https). If none does, the failure that
     * says the most: a server that is there but is not 松果 says more than a refused connection.
     */
    fun probe(candidates: List<String>): Result<String> {
        val failures = mutableListOf<Failure>()
        for (origin in candidates) {
            try {
                return Result.success(health(origin))
            } catch (f: Failure) {
                failures += f
            }
        }
        val rank = listOf(Failure.Untrusted::class, Failure.NotAcorn::class, Failure.Unreachable::class, Failure.NotFound::class)
        val best = failures.minByOrNull { rank.indexOf(it::class) } ?: Failure.Unreachable(candidates.firstOrNull().orEmpty())
        return Result.failure(best)
    }

    private fun health(origin: String): String {
        var url = URL("$origin/api/health")
        for (hop in 0 until 5) {
            val c = url.openConnection() as HttpURLConnection
            c.instanceFollowRedirects = false // it would not follow http → https anyway
            c.connectTimeout = 5_000
            c.readTimeout = 8_000
            c.setRequestProperty("Accept", "application/json")
            try {
                val code = c.responseCode
                if (code in 300..399) {
                    url = URL(url, c.getHeaderField("Location") ?: throw Failure.NotAcorn(origin))
                    if (url.protocol != "http" && url.protocol != "https") throw Failure.NotAcorn(origin)
                    continue
                }
                if (code != 200 || !HEALTHY.containsMatchIn(head(c))) throw Failure.NotAcorn(origin)
                return origin(url.protocol, url.host, url.port)!!
            } catch (f: Failure) {
                throw f
            } catch (e: UnknownHostException) {
                throw Failure.NotFound(origin, url.host)
            } catch (e: SSLException) {
                throw Failure.Untrusted(origin(url.protocol, url.host, url.port)!!)
            } catch (e: IOException) {
                throw Failure.Unreachable(origin)
            } finally {
                c.disconnect()
            }
        }
        throw Failure.NotAcorn(origin) // redirects in a circle
    }

    /** The first 4 KB of the body: enough for {"ok":true}, and a big page from some other server is not read. */
    private fun head(c: HttpURLConnection): String = c.inputStream.bufferedReader().use { r ->
        val buf = CharArray(4096)
        var n = 0
        while (n < buf.size) {
            val k = r.read(buf, n, buf.size - n)
            if (k < 0) break
            n += k
        }
        String(buf, 0, n)
    }
}

/** A link shared from another app, the way the web app's capture page takes it: /capture?url=…&title=… */
object Capture {
    /**
     * Chrome and Firefox share the address as the text and the page's title as the subject; Zhihu, Xiaohongshu or
     * Bilibili put a title, the link and some chatter into one text.
     */
    fun path(text: String?, subject: String?): String {
        val t = text.orEmpty().trim()
        val url = firstLink(t)
        val title = subject?.trim()?.takeIf { it.isNotEmpty() }
            ?: url?.let { t.replace(it, "\n") }?.lines()
                ?.map { line -> line.trim { it.isWhitespace() || it in "-|:：—【】" } }
                ?.firstOrNull { line -> line.any { it.isLetterOrDigit() } }
                ?.take(200)
        val params = buildList {
            if (url != null) add("url" to url) else if (t.isNotEmpty()) add("text" to t.take(2000))
            if (title != null) add("title" to title)
        }
        if (params.isEmpty()) return "/capture"
        return "/capture?" + params.joinToString("&") { (k, v) -> "$k=" + URLEncoder.encode(v, "UTF-8") }
    }
}

/** What the WebView hands over for saving. */
object Downloads {
    /** The file name in a Content-Disposition header (`filename*=UTF-8''…` first, RFC 6266), else null. */
    fun nameFromDisposition(disposition: String?): String? {
        if (disposition.isNullOrBlank()) return null
        Regex("filename\\*\\s*=\\s*([\\w-]+)'[^']*'([^;]+)", RegexOption.IGNORE_CASE).find(disposition)?.let { m ->
            percentDecode(m.groupValues[2].trim(), m.groupValues[1])?.let(::safeName)?.let { return it }
        }
        Regex("filename\\s*=\\s*\"([^\"]*)\"", RegexOption.IGNORE_CASE).find(disposition)?.let { return safeName(it.groupValues[1]) }
        Regex("filename\\s*=\\s*([^;\\s]+)", RegexOption.IGNORE_CASE).find(disposition)?.let { return safeName(it.groupValues[1]) }
        return null
    }

    /** `data:[mime][;base64],payload` → the MIME type (without parameters) and the bytes. */
    fun decodeDataUrl(url: String): Pair<String, ByteArray>? {
        if (!url.startsWith("data:")) return null
        val comma = url.indexOf(',')
        if (comma < 0) return null
        val meta = url.substring(5, comma)
        val payload = url.substring(comma + 1)
        val base64 = meta.split(';').drop(1).any { it.trim().equals("base64", ignoreCase = true) }
        val bytes = try {
            if (base64) Base64.getDecoder().decode(payload) else percentDecode(payload, "UTF-8")?.toByteArray() ?: return null
        } catch (e: IllegalArgumentException) {
            return null
        }
        return meta.substringBefore(';').trim() to bytes
    }

    /** A name that is safe as a single file name in Downloads. */
    fun safeName(name: String): String? =
        name.replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_").trim().trim('.').takeIf { it.isNotEmpty() }

    /** Percent-decoding without URLDecoder's "+ is a space". */
    private fun percentDecode(s: String, charsetName: String): String? = try {
        val charset = charset(charsetName)
        val out = StringBuilder()
        val bytes = ByteArrayOutputStream()
        fun flush() {
            if (bytes.size() > 0) out.append(String(bytes.toByteArray(), charset)).also { bytes.reset() }
        }
        var i = 0
        while (i < s.length) {
            if (s[i] == '%' && i + 2 < s.length) {
                bytes.write(s.substring(i + 1, i + 3).toInt(16))
                i += 3
            } else {
                flush()
                out.append(s[i])
                i++
            }
        }
        flush()
        out.toString()
    } catch (e: Exception) {
        null
    }
}
