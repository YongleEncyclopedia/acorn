package io.github.yongleencyclopedia.acorn

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.net.URLEncoder

class AddressTest {
    private fun candidates(input: String) = Address.parse(input)!!.candidates

    @Test
    fun bareAddressesGetHttpAndPort7700() {
        assertEquals(listOf("http://192.168.1.20:7700"), candidates("192.168.1.20"))
        assertEquals(listOf("http://nas.local:7700"), candidates("nas.local"))
        assertEquals(listOf("http://nas.local:7700"), candidates("NAS.Local"))
        assertEquals(listOf("http://nas:7700"), candidates(" nas "))
        assertEquals(listOf("http://100.101.102.103:7700"), candidates("100.101.102.103"))
    }

    @Test
    fun aPortIsKept() {
        assertEquals(listOf("http://nas.local:8080"), candidates("nas.local:8080"))
        assertEquals(listOf("http://192.168.1.20:7700"), candidates("192.168.1.20:7700"))
        assertEquals(listOf("https://acorn.example.com"), candidates("acorn.example.com:443"))
        assertEquals(listOf("http://nas.local"), candidates("nas.local:80"))
    }

    @Test
    fun fullUrlsKeepTheirScheme() {
        assertEquals(listOf("https://acorn.example.com"), candidates("https://acorn.example.com/"))
        assertEquals(listOf("http://192.168.1.20:7700"), candidates("HTTP://192.168.1.20:7700/s/today?x=1#top"))
        // http:// without a port: port 80 as written, then 松果's own
        assertEquals(listOf("http://192.168.1.20", "http://192.168.1.20:7700"), candidates("http://192.168.1.20"))
    }

    @Test
    fun aBareDomainAlsoTriesHttps() {
        assertEquals(listOf("http://acorn.example.com:7700", "https://acorn.example.com"), candidates("acorn.example.com"))
        assertEquals(listOf("http://nas.tail1234.ts.net:7700", "https://nas.tail1234.ts.net"), candidates("nas.tail1234.ts.net"))
    }

    @Test
    fun ipv6() {
        assertEquals(listOf("http://[fd7a:115c:a1e0::1]:7700"), candidates("[fd7a:115c:a1e0::1]:7700"))
        assertEquals(listOf("http://[fd7a:115c:a1e0::1]:7700"), candidates("fd7a:115c:a1e0::1"))
        assertEquals(listOf("http://[fd7a:115c:a1e0::1]:7700"), candidates("http://[FD7A:115C:A1E0::1]:7700/"))
    }

    @Test
    fun typedOnAChineseKeyboard() {
        assertEquals(listOf("http://192.168.1.20:7700"), candidates("192。168。1。20：7700"))
    }

    @Test
    fun pastedWithTextAround() {
        assertEquals(listOf("http://192.168.1.20:7700"), candidates("松果的地址 http://192.168.1.20:7700，记一下"))
    }

    @Test
    fun signInLinks() {
        val link = "http://192.168.1.20:7700/login/AbCdEfGhIjKlMnOpQrStUvWxYz012345"
        val target = Address.parse(link)!!
        assertEquals(listOf("http://192.168.1.20:7700"), target.candidates)
        assertEquals("/login/AbCdEfGhIjKlMnOpQrStUvWxYz012345", target.loginPath)
        assertNull(Address.parse("http://192.168.1.20:7700/s/today")!!.loginPath)
        assertNull(Address.parse("http://192.168.1.20:7700/login/")!!.loginPath)
        assertEquals(link, Address.loginLink("松果的登录链接：$link，10 分钟内有效"))
        assertNull(Address.loginLink("https://example.com/article"))
    }

    @Test
    fun notAddresses() {
        for (input in listOf("", "   ", "ftp://nas.local", "nas.local:99999", "nas.local:abc", "hello world", "http://", "a..b", "[::1")) {
            assertNull(input, Address.parse(input))
        }
    }

    @Test
    fun originsAreWrittenTheWayBrowsersDo() {
        assertEquals("http://nas.local", Address.origin("HTTP", "NAS.local", 80))
        assertEquals("http://nas.local:7700", Address.origin("http", "nas.local", 7700))
        assertEquals("https://example.com", Address.origin("https", "example.com", -1))
        assertEquals("http://[::1]:7700", Address.origin("http", "::1", 7700))
        assertEquals("http://[::1]:7700", Address.origin("http", "[::1]", 7700))
        assertNull(Address.origin(null, "example.com", 80))
    }
}

class CaptureTest {
    private fun capture(vararg params: Pair<String, String>) =
        "/capture?" + params.joinToString("&") { (k, v) -> "$k=" + URLEncoder.encode(v, "UTF-8") }

    @Test
    fun aBrowserSharesTheLinkAndTheTitle() {
        assertEquals(capture("url" to "https://example.com/a?b=1", "title" to "An article"), Capture.path("https://example.com/a?b=1", "An article"))
    }

    @Test
    fun aLinkInsideText() {
        assertEquals(
            capture("url" to "https://zhuanlan.zhihu.com/p/123", "title" to "标题"),
            Capture.path("【标题】https://zhuanlan.zhihu.com/p/123（分享自知乎）", null),
        )
        assertEquals(
            capture("url" to "http://xhslink.com/a/AbC", "title" to "看看这个"),
            Capture.path("看看这个 http://xhslink.com/a/AbC，复制本条信息，打开【小红书】App查看精彩内容！", null),
        )
        assertEquals(capture("url" to "https://example.com/a"), Capture.path("https://example.com/a.", ""))
    }

    @Test
    fun noLinkLeavesTheTextToThePage() {
        assertEquals(capture("text" to "just words"), Capture.path("just words", null))
        assertEquals("/capture", Capture.path(null, null))
    }
}

class DownloadsTest {
    @Test
    fun namesFromContentDisposition() {
        assertEquals("acorn-2026-11-12.zip", Downloads.nameFromDisposition("attachment; filename=\"acorn-2026-11-12.zip\""))
        assertEquals("acorn.opml", Downloads.nameFromDisposition("attachment; filename=acorn.opml"))
        assertEquals("松果 a+b.pdf", Downloads.nameFromDisposition("attachment; filename*=UTF-8''%E6%9D%BE%E6%9E%9C%20a+b.pdf"))
        assertEquals("a_b.txt", Downloads.nameFromDisposition("attachment; filename=\"a/b.txt\""))
        assertNull(Downloads.nameFromDisposition(null))
        assertNull(Downloads.nameFromDisposition("inline"))
    }

    @Test
    fun dataUrls() {
        val (mime, bytes) = Downloads.decodeDataUrl("data:text/markdown;charset=utf-8;base64,IyDmnb7mnpwK")!!
        assertEquals("text/markdown", mime)
        assertArrayEquals("# 松果\n".toByteArray(), bytes)
        val (plainMime, plain) = Downloads.decodeDataUrl("data:,Hello%2C%20World")!!
        assertEquals("", plainMime)
        assertArrayEquals("Hello, World".toByteArray(), plain)
        assertNull(Downloads.decodeDataUrl("blob:http://x/1"))
        assertNull(Downloads.decodeDataUrl("data:text/plain;base64,***"))
    }
}
