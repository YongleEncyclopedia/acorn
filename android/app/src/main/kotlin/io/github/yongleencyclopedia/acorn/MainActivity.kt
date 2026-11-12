package io.github.yongleencyclopedia.acorn

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.CookieManager
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.isVisible
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.zxing.client.android.Intents
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import org.json.JSONObject
import kotlin.concurrent.thread

/**
 * 松果 on Android: the web app, full screen, from the 松果 server on the user's computer or NAS. The first time
 * it asks for that address (typed, or read from a sign-in QR code); after that it is a WebView that keeps the
 * session cookie, walks the page's history on Back, sends other sites to the browser, downloads and picks files,
 * and turns links shared from other apps into the web app's /capture page.
 */
class MainActivity : ComponentActivity() {
    private val prefs by lazy { getSharedPreferences("acorn", MODE_PRIVATE) }

    private lateinit var root: View
    private lateinit var web: WebView
    private lateinit var setup: View
    private lateinit var address: EditText
    private lateinit var status: TextView
    private lateinit var connectButton: Button
    private lateinit var scanButton: Button
    private lateinit var cancelButton: Button
    private lateinit var offline: View
    private lateinit var offlineMessage: TextView
    private lateinit var offlineAddress: TextView

    /** The server as an origin, such as http://192.168.1.20:7700; null until the first connection. */
    private var origin: String? = null
    /** Where to go once connected: a link shared from another app before any address was set. */
    private var pending: String? = null
    private var pageColor = 0
    private var listening = false
    private var busy = false
    private var loadFailed = false
    private var failedUrl: String? = null
    private var forgetHistory = false
    private var webGone = false
    private var fileChooser: ValueCallback<Array<Uri>>? = null
    private var toSave: Pair<String, ByteArray>? = null
    private var fullscreen: View? = null
    private var fullscreenDone: WebChromeClient.CustomViewCallback? = null

    private val back = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() {
            when {
                fullscreen != null -> leaveFullscreen()
                setup.isVisible && origin != null -> hidePanels()
                web.canGoBack() -> web.goBack()
            }
        }
    }

    private val pickFiles = registerForActivityResult(StartActivityForResult()) { result ->
        val data = result.data
        val uris = if (result.resultCode != RESULT_OK || data == null) null
        else data.clipData?.let { clip -> Array(clip.itemCount) { clip.getItemAt(it).uri } } ?: data.data?.let { arrayOf(it) }
        fileChooser?.onReceiveValue(uris)
        fileChooser = null
    }

    private val saveAs = registerForActivityResult(StartActivityForResult()) { result ->
        val (name, bytes) = toSave ?: return@registerForActivityResult
        toSave = null
        val uri = result.data?.data
        if (result.resultCode != RESULT_OK || uri == null) return@registerForActivityResult
        val saved = try {
            contentResolver.openOutputStream(uri)?.use { it.write(bytes) } != null
        } catch (e: Exception) {
            false
        }
        toast(if (saved) getString(R.string.saved, name) else getString(R.string.save_failed))
    }

    private val scanner = registerForActivityResult(ScanContract()) { result ->
        val text = result.contents
        when {
            text != null -> {
                showSetup()
                val target = Address.parse(text)
                if (target == null) {
                    say(getString(R.string.scan_not_address), error = true)
                } else {
                    fill(target.candidates.first())
                    connect(target)
                }
            }
            result.originalIntent?.hasExtra(Intents.Scan.MISSING_CAMERA_PERMISSION) == true -> {
                showSetup()
                say(getString(R.string.scan_no_camera), error = true)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        root = findViewById(R.id.root)
        web = findViewById(R.id.web)
        setup = findViewById(R.id.setup)
        address = findViewById(R.id.address)
        status = findViewById(R.id.status)
        connectButton = findViewById(R.id.connect)
        scanButton = findViewById(R.id.scan)
        cancelButton = findViewById(R.id.cancel)
        offline = findViewById(R.id.offline)
        offlineMessage = findViewById(R.id.offline_message)
        offlineAddress = findViewById(R.id.offline_address)

        // Edge to edge: the bars and the keyboard pad the content, and the page's colour shows behind the bars.
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
            WindowInsetsCompat.CONSUMED
        }
        onBackPressedDispatcher.addCallback(this, back)

        origin = prefs.getString(KEY_ORIGIN, null)
        pageColor = prefs.getInt(KEY_COLOR, getColor(R.color.bg))
        setUpPanels()
        setUpWebView()
        paint()

        val restored = savedInstanceState != null && web.restoreState(savedInstanceState) != null
        when {
            restored -> Unit
            savedInstanceState != null -> start() // recreated without the page's state (its renderer had stopped)
            else -> handle(intent, launch = true)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handle(intent, launch = false)
    }

    override fun onResume() {
        super.onResume()
        if (!webGone) web.onResume()
    }

    override fun onPause() {
        if (!webGone) web.onPause()
        CookieManager.getInstance().flush() // the session cookie survives the app being killed
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (!webGone) web.saveState(outState)
    }

    override fun onDestroy() {
        if (!webGone) {
            (web.parent as? ViewGroup)?.removeView(web)
            web.destroy()
        }
        super.onDestroy()
    }

    // ---- what the app was opened for ----

    private fun handle(intent: Intent?, launch: Boolean) {
        // reopened from the recents screen: the intent is the old one again, so do not share the same link twice
        val fromRecents = intent != null && (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0
        when (if (fromRecents) null else intent?.action) {
            Intent.ACTION_SEND -> {
                val text = intent!!.getStringExtra(Intent.EXTRA_TEXT)
                val link = text?.let(Address::loginLink)
                if (link != null) {
                    signIn(link)
                } else {
                    val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT) ?: intent.getStringExtra(Intent.EXTRA_TITLE)
                    open(Capture.path(text, subject))
                }
            }
            Intent.ACTION_VIEW -> {
                val link = intent!!.dataString
                if (link != null) signIn(link) else if (launch) start()
            }
            ACTION_ADDRESS -> {
                if (launch) start()
                showSetup()
            }
            ACTION_SCAN -> {
                if (launch) start()
                startScan()
            }
            else -> if (launch) start()
        }
    }

    /** The start page, or the setup panel while there is no address yet. */
    private fun start() {
        val server = origin ?: return showSetup()
        web.loadUrl(server)
    }

    /** A page of the web app, such as /capture?url=…; after the setup panel if there is no address yet. */
    private fun open(path: String) {
        val server = origin
        if (server == null) {
            pending = path
            return showSetup()
        }
        hidePanels()
        web.loadUrl(server + path)
    }

    /** A one-time sign-in link from outside: open it, after asking if it is for another server than this one. */
    private fun signIn(link: String) {
        val target = Address.parse(link)
        val path = target?.loginPath
        if (target == null || path == null) {
            if (origin == null) showSetup()
            return
        }
        val there = target.candidates.first()
        val here = origin
        when (here) {
            there -> {
                hidePanels()
                web.loadUrl(there + path)
            }
            null -> {
                showSetup()
                fill(there)
                connect(target)
            }
            else -> AlertDialog.Builder(this)
                .setTitle(R.string.switch_title)
                .setMessage(getString(R.string.switch_message, there, here))
                .setPositiveButton(R.string.switch_confirm) { _, _ ->
                    showSetup()
                    fill(there)
                    connect(target)
                }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
        }
    }

    // ---- the setup panel: the address, checked with GET /api/health before it is saved ----

    private fun setUpPanels() {
        address.setOnEditorActionListener { _, action, event ->
            if (action == EditorInfo.IME_ACTION_GO || event?.keyCode == KeyEvent.KEYCODE_ENTER) {
                if (event == null || event.action == KeyEvent.ACTION_DOWN) submit()
                true
            } else {
                false
            }
        }
        connectButton.setOnClickListener { submit() }
        scanButton.setOnClickListener { startScan() }
        cancelButton.setOnClickListener { hidePanels() }
        findViewById<View>(R.id.retry).setOnClickListener { retry() }
        findViewById<View>(R.id.change).setOnClickListener { showSetup() }
    }

    private fun submit() {
        if (busy) return
        val target = Address.parse(address.text.toString()) ?: return say(getString(R.string.error_not_address), error = true)
        hideKeyboard()
        connect(target)
    }

    private fun startScan() {
        if (origin == null) showSetup()
        scanner.launch(
            ScanOptions().apply {
                setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                setPrompt(getString(R.string.scan_prompt))
                setBeepEnabled(false)
                setOrientationLocked(false)
            },
        )
    }

    private fun connect(target: Target) {
        showBusy(true)
        say(getString(R.string.connecting, target.candidates.first()))
        thread(name = "acorn-health") {
            val result = Address.probe(target.candidates)
            runOnUiThread {
                if (isDestroyed) return@runOnUiThread
                showBusy(false)
                result.fold(
                    onSuccess = { server -> connected(server, target.loginPath ?: pending.also { pending = null }) },
                    onFailure = { say(describe(it), error = true) },
                )
            }
        }
    }

    private fun connected(server: String, path: String?) {
        if (server != origin) {
            origin = server
            prefs.edit().putString(KEY_ORIGIN, server).apply()
            listen(server)
            forgetHistory = true // Back should not lead to the pages of the old address
        }
        say(null)
        hidePanels()
        web.loadUrl(server + (path ?: "/"))
    }

    private fun describe(e: Throwable): String = when (e) {
        is Failure.NotFound -> getString(R.string.error_not_found, e.host)
        is Failure.Untrusted -> getString(R.string.error_untrusted, e.origin)
        is Failure.NotAcorn -> getString(R.string.error_not_acorn, e.origin)
        is Failure -> getString(R.string.error_unreachable, e.origin)
        else -> e.toString()
    }

    private fun showSetup() {
        offline.isVisible = false
        setup.isVisible = true
        cancelButton.isVisible = origin != null
        if (!busy) {
            fill(origin.orEmpty())
            say(null)
        }
        paint()
        updateBack()
    }

    private fun showOffline(url: String, message: String) {
        failedUrl = url
        offlineMessage.text = message
        offlineAddress.text = origin
        setup.isVisible = false
        offline.isVisible = true
        paint()
        updateBack()
    }

    private fun hidePanels() {
        setup.isVisible = false
        offline.isVisible = false
        hideKeyboard()
        paint()
        updateBack()
    }

    private fun retry() {
        val url = failedUrl ?: origin ?: return
        offlineMessage.text = getString(R.string.connecting, origin)
        web.loadUrl(url)
    }

    private fun say(text: String?, error: Boolean = false) {
        status.text = text
        status.isVisible = text != null
        status.setTextColor(getColor(if (error) R.color.danger else R.color.ink_2))
    }

    private fun showBusy(on: Boolean) {
        busy = on
        for (v in listOf(connectButton, scanButton, address)) v.isEnabled = !on
        connectButton.alpha = if (on) 0.6f else 1f
    }

    private fun fill(text: String) {
        address.setText(text)
        address.setSelection(text.length)
    }

    private fun hideKeyboard() {
        getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(address.windowToken, 0)
    }

    private fun updateBack() {
        back.isEnabled = fullscreen != null || (setup.isVisible && origin != null) ||
            (!setup.isVisible && !offline.isVisible && web.canGoBack())
    }

    /** The colour behind the status and navigation bars (the page's, or the panel's), with icons that show on it. */
    private fun paint() {
        val panel = setup.isVisible || offline.isVisible
        val color = if (panel) getColor(R.color.bg) else pageColor
        root.setBackgroundColor(color)
        val light = Color.luminance(color) > 0.5f
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = light
            isAppearanceLightNavigationBars = light
        }
        web.importantForAccessibility =
            if (panel) View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS else View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
    }

    private fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_SHORT).show()

    // ---- the WebView ----

    @SuppressLint("SetJavaScriptEnabled")
    private fun setUpWebView() {
        web.setBackgroundColor(pageColor) // no white flash before the page paints
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            // an https 松果 may still play a podcast's http audio
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            userAgentString = "$userAgentString AcornAndroid/${BuildConfig.VERSION_NAME}"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        web.webViewClient = Client()
        web.webChromeClient = Chrome()
        web.setDownloadListener { url, userAgent, disposition, mimeType, _ -> download(url, userAgent, disposition, mimeType) }
        origin?.let(::listen)
    }

    /** The page script's channel (see PageScript.kt), open to the server's origin only. */
    private fun listen(server: String) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        if (listening) WebViewCompat.removeWebMessageListener(web, BRIDGE)
        listening = try {
            WebViewCompat.addWebMessageListener(web, BRIDGE, setOf(server)) { _, message, _, isMainFrame, _ ->
                if (isMainFrame) message.data?.let(::onPageMessage)
            }
            true
        } catch (e: IllegalArgumentException) {
            false // an origin the rules cannot express: the page goes without colours, saving and sharing
        }
    }

    private fun inject(view: WebView, url: String?) {
        if (listening && url != null && isApp(Uri.parse(url))) view.evaluateJavascript(PAGE_SCRIPT, null)
    }

    private fun onPageMessage(json: String) {
        val message = try {
            JSONObject(json)
        } catch (e: Exception) {
            return
        }
        when (message.optString("type")) {
            "theme" -> runCatching { Color.parseColor(message.optString("color")) }.getOrNull()?.let(::setPageColor)
            "save" -> save(message.optString("name"), message.optString("data"))
            "copy" -> getSystemService(ClipboardManager::class.java)
                .setPrimaryClip(ClipData.newPlainText(getString(R.string.app_name), message.optString("text")))
            "share" -> share(message.optString("title"), message.optString("text"), message.optString("url"))
        }
    }

    private fun setPageColor(color: Int) {
        if (color == pageColor) return
        pageColor = color
        prefs.edit().putInt(KEY_COLOR, color).apply() // the next start begins in this colour
        web.setBackgroundColor(color)
        paint()
    }

    private fun isApp(uri: Uri): Boolean = origin != null && Address.origin(uri.scheme, uri.host, uri.port) == origin

    /** Another site, or another app's link (mailto:, tel:, intent:…): not for this WebView. */
    private fun openOutside(uri: Uri): Boolean {
        val intent = if (uri.scheme == "intent") {
            try {
                Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME).apply {
                    // only what a browser would open from a link: no explicit components
                    addCategory(Intent.CATEGORY_BROWSABLE)
                    component = null
                    selector = null
                }
            } catch (e: Exception) {
                return true
            }
        } else {
            Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)
        }
        try {
            startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            val fallback = intent.getStringExtra("browser_fallback_url")?.let(Uri::parse)
            if (fallback != null && (fallback.scheme == "http" || fallback.scheme == "https")) openOutside(fallback)
            else toast(getString(R.string.no_app))
        }
        return true
    }

    /** Downloads from the server (the library export, archived attachments) go to Downloads, with its cookie. */
    private fun download(url: String, userAgent: String?, disposition: String?, mimeType: String?) {
        val name = Downloads.nameFromDisposition(disposition)
            ?: Downloads.safeName(URLUtil.guessFileName(url, disposition, mimeType)) ?: "download"
        val uri = Uri.parse(url)
        when (uri.scheme) {
            "blob", "data" -> {
                // made in the page: the page script kept it (see PageScript.kt)
                val call = "window.__acornSave ? window.__acornSave(${JSONObject.quote(url)}, ${JSONObject.quote(name)}) : false"
                web.evaluateJavascript(call) { handled -> if (handled != "true") toast(getString(R.string.save_failed)) }
                return
            }
            "http", "https" -> Unit
            else -> return
        }
        val request = DownloadManager.Request(uri)
            .setTitle(name)
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        if (!mimeType.isNullOrBlank()) request.setMimeType(mimeType)
        if (!userAgent.isNullOrBlank()) request.addRequestHeader("User-Agent", userAgent)
        CookieManager.getInstance().getCookie(url)?.let { request.addRequestHeader("Cookie", it) }
        // Android 10+ lets any app download into the shared Downloads folder; older versions would want a
        // storage permission, so there the file goes to the app's own folder (the notification still opens it)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
        } else {
            request.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, name)
        }
        try {
            getSystemService(DownloadManager::class.java).enqueue(request)
            toast(getString(R.string.download_started, name))
        } catch (e: Exception) {
            toast(getString(R.string.download_failed, e.message ?: e.javaClass.simpleName))
        }
    }

    /** A file the page made itself (a data: URL from the page script): ask where to save it. */
    private fun save(name: String, dataUrl: String) {
        val (mime, bytes) = Downloads.decodeDataUrl(dataUrl) ?: return toast(getString(R.string.save_failed))
        val fileName = Downloads.safeName(name) ?: "download"
        toSave = fileName to bytes
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(mime.ifBlank { "application/octet-stream" })
            .putExtra(Intent.EXTRA_TITLE, fileName)
        try {
            saveAs.launch(intent)
        } catch (e: ActivityNotFoundException) {
            toSave = null
            toast(getString(R.string.save_failed))
        }
    }

    /** The reader's 分享…: the system share sheet, without 松果 itself in it. */
    private fun share(title: String, text: String, url: String) {
        val body = listOf(text, url).filter { it.isNotBlank() }.joinToString("\n")
        if (body.isEmpty()) return
        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, body)
        if (title.isNotBlank()) send.putExtra(Intent.EXTRA_SUBJECT, title).putExtra(Intent.EXTRA_TITLE, title)
        val chooser = Intent.createChooser(send, null)
            .putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS, arrayOf(ComponentName(this, MainActivity::class.java)))
        startActivity(chooser)
    }

    private fun leaveFullscreen() {
        val view = fullscreen ?: return
        (window.decorView as ViewGroup).removeView(view)
        fullscreen = null
        WindowCompat.getInsetsController(window, window.decorView).show(WindowInsetsCompat.Type.systemBars())
        fullscreenDone?.onCustomViewHidden()
        fullscreenDone = null
        updateBack()
    }

    /** alert() and confirm() as plain dialogs, without the "the page at http://… says" title. */
    private fun ask(message: String?, result: JsResult, withCancel: Boolean): Boolean {
        if (isFinishing) {
            result.cancel()
            return true
        }
        val dialog = AlertDialog.Builder(this)
            .setMessage(message)
            .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
            .setOnCancelListener { if (withCancel) result.cancel() else result.confirm() }
        if (withCancel) dialog.setNegativeButton(android.R.string.cancel) { _, _ -> result.cancel() }
        dialog.show()
        return true
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (!request.isForMainFrame) return false // embedded players stay in their frames
            val uri = request.url
            return when (uri.scheme?.lowercase()) {
                "http", "https" -> !isApp(uri) && openOutside(uri)
                "about", "blob", "data", "javascript" -> false
                else -> openOutside(uri)
            }
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            loadFailed = false
        }

        override fun onPageCommitVisible(view: WebView, url: String?) = inject(view, url)

        override fun onPageFinished(view: WebView, url: String?) {
            inject(view, url)
            if (!loadFailed) {
                if (offline.isVisible) hidePanels()
                if (forgetHistory) {
                    forgetHistory = false
                    view.clearHistory()
                }
            }
            updateBack()
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) = updateBack()

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            loadFailed = true
            val message = when (error.errorCode) {
                WebViewClient.ERROR_HOST_LOOKUP -> getString(R.string.error_not_found, request.url.host)
                WebViewClient.ERROR_FAILED_SSL_HANDSHAKE -> getString(R.string.error_untrusted, origin)
                else -> getString(R.string.error_unreachable, origin)
            }
            showOffline(request.url.toString(), message)
        }

        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            handler.cancel()
            if (isApp(Uri.parse(error.url))) {
                loadFailed = true
                showOffline(error.url, getString(R.string.error_untrusted, origin))
            }
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            // The page's renderer crashed or was stopped to free memory, and took this WebView with it. Start over.
            webGone = true
            (view.parent as? ViewGroup)?.removeView(view)
            view.destroy()
            recreate()
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            fileChooser?.onReceiveValue(null)
            fileChooser = callback
            // any file: Android's guess of a MIME type for .opml, .mhtml or a bookmarks export is often wrong,
            // and 松果 tells the formats apart by their content
            val intent = Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
            if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            return try {
                pickFiles.launch(intent)
                true
            } catch (e: ActivityNotFoundException) {
                fileChooser = null
                false
            }
        }

        override fun onJsAlert(view: WebView, url: String?, message: String?, result: JsResult) =
            ask(message, result, withCancel = false)

        override fun onJsConfirm(view: WebView, url: String?, message: String?, result: JsResult) =
            ask(message, result, withCancel = true)

        override fun onJsPrompt(view: WebView, url: String?, message: String?, defaultValue: String?, result: JsPromptResult): Boolean {
            if (isFinishing) {
                result.cancel()
                return true
            }
            val field = EditText(this@MainActivity).apply {
                setText(defaultValue)
                setSingleLine()
                selectAll()
            }
            val side = (20 * resources.displayMetrics.density).toInt()
            val box = FrameLayout(this@MainActivity).apply {
                setPadding(side, side / 2, side, 0)
                addView(field)
            }
            AlertDialog.Builder(this@MainActivity)
                .setMessage(message)
                .setView(box)
                .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm(field.text.toString()) }
                .setNegativeButton(android.R.string.cancel) { _, _ -> result.cancel() }
                .setOnCancelListener { result.cancel() }
                .show()
                .window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE)
            field.requestFocus()
            return true
        }

        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
            if (fullscreen != null) return callback.onCustomViewHidden()
            fullscreen = view
            fullscreenDone = callback
            view.setBackgroundColor(Color.BLACK)
            (window.decorView as ViewGroup).addView(
                view,
                ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
            )
            WindowCompat.getInsetsController(window, window.decorView).apply {
                systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                hide(WindowInsetsCompat.Type.systemBars())
            }
            updateBack()
        }

        override fun onHideCustomView() = leaveFullscreen()
    }

    companion object {
        private const val KEY_ORIGIN = "origin"
        private const val KEY_COLOR = "pageColor"
        private const val BRIDGE = "AcornAndroid"
        // the launcher shortcuts (res/xml/shortcuts.xml)
        private const val ACTION_ADDRESS = "io.github.yongleencyclopedia.acorn.ADDRESS"
        private const val ACTION_SCAN = "io.github.yongleencyclopedia.acorn.SCAN"
    }
}
