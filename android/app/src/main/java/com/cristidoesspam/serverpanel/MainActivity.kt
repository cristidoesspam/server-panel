package com.cristidoesspam.serverpanel

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL
import kotlin.concurrent.thread

class MainActivity : Activity() {
    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private lateinit var overlay: LinearLayout
    private lateinit var message: TextView
    private lateinit var spinner: ProgressBar
    private lateinit var retry: Button
    private lateinit var servers: Button
    private var panel: Uri? = null
    private var failed = false
    private var chooser: ValueCallback<Array<Uri>>? = null
    private val prefs by lazy { getSharedPreferences("panel", MODE_PRIVATE) }

    private class Saved(val name: String, val addresses: List<String>)

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        root = FrameLayout(this)
        root.setBackgroundColor(Color.BLACK)
        web = WebView(this)
        web.setBackgroundColor(Color.BLACK)
        root.addView(web, FrameLayout.LayoutParams(-1, -1))
        buildOverlay()
        root.addView(overlay, FrameLayout.LayoutParams(-1, -1))
        setContentView(root)
        handleInsets()

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
            userAgentString = "$userAgentString ServerPanelApp/2"
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                if (req.url.scheme == "serverpanel") {
                    if (req.url.host == "servers") runOnUiThread { showServers() }
                    return true
                }
                val p = panel
                if (p != null && req.url.host == p.host && req.url.port == p.port) return false
                if (req.url.scheme == "http" || req.url.scheme == "https") {
                    try { startActivity(Intent(Intent.ACTION_VIEW, req.url)) } catch (_: ActivityNotFoundException) { }
                }
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (!failed && panel != null && Uri.parse(url).host == panel?.host) overlay.visibility = View.GONE
            }

            override fun onReceivedError(view: WebView, req: WebResourceRequest, error: WebResourceError) {
                if (req.isForMainFrame) showError("The panel did not answer (${error.description}).")
            }

            override fun onReceivedHttpError(view: WebView, req: WebResourceRequest, resp: WebResourceResponse) {
                if (req.isForMainFrame && resp.statusCode >= 400) {
                    showError("The panel answered with error ${resp.statusCode}. It only talks to devices on your home network or Tailscale.")
                }
            }

            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                recreate()
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                chooser?.onReceiveValue(null)
                chooser = cb
                try {
                    @Suppress("DEPRECATION")
                    startActivityForResult(params.createIntent(), REQ_FILE)
                } catch (_: ActivityNotFoundException) {
                    chooser = null
                    cb.onReceiveValue(null)
                }
                return true
            }
        }
        web.setDownloadListener { url, userAgent, disposition, mime, _ ->
            val name = URLUtil.guessFileName(url, disposition, mime)
            try {
                val request = DownloadManager.Request(Uri.parse(url))
                    .addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url) ?: "")
                    .addRequestHeader("User-Agent", userAgent)
                    .setTitle(name)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
                (getSystemService(DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
                Toast.makeText(this, "Downloading $name to your Downloads folder", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Toast.makeText(this, "Download failed: ${e.message}", Toast.LENGTH_LONG).show()
            }
        }
        if (!handleInvite(intent, true)) connect()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleInvite(intent, false)
    }

    private fun handleInvite(intent: Intent?, cold: Boolean): Boolean {
        val u = intent?.data ?: return false
        if (u.scheme != "serverpanel" || u.host != "add") return false
        val addrs = cleanAddresses(u.getQueryParameters("a").take(4).joinToString("\n"))
        if (addrs.isEmpty()) {
            Toast.makeText(this, "That invite link has no valid address", Toast.LENGTH_LONG).show()
            return false
        }
        val name = (u.getQueryParameter("n") ?: "").trim().take(40).ifEmpty { "Server (${addrs[0].substringBefore(':')})" }
        val join = u.getQueryParameter("join")?.takeIf { CODE.matches(it) }
        val asName = u.getQueryParameter("as")?.trim()?.take(30)?.takeIf { it.isNotEmpty() }
        val key = u.getQueryParameter("k")?.takeIf { CODE.matches(it) }
        val hash = when {
            join != null -> "#join=$join"
            asName != null -> "#as=${Uri.encode(asName)}" + (key?.let { "&k=$it" } ?: "")
            else -> ""
        }
        AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle("Add \"$name\"?")
            .setMessage("You were invited to this Server Panel:\n\n${addrs.joinToString("\n")}\n\nIt is added to your servers (use the Servers button to switch to it). Only add it if you trust whoever sent the link.")
            .setPositiveButton("Add and open") { _, _ ->
                val list = loadServers()
                val at = list.indexOfFirst { s -> s.addresses.any { it in addrs } }
                val index = if (at >= 0) at else { list.add(Saved(name, addrs)); saveServers(list); list.size - 1 }
                connect(index, hash)
            }
            .setNegativeButton("Cancel") { _, _ -> if (cold) connect() }
            .setOnCancelListener { if (cold) connect() }
            .show()
        return true
    }

    private fun loadServers(): MutableList<Saved> {
        val list = mutableListOf<Saved>()
        val raw = prefs.getString("servers", null)
        if (raw != null) {
            try {
                val arr = JSONArray(raw)
                for (i in 0 until arr.length()) {
                    val o = arr.getJSONObject(i)
                    val a = o.getJSONArray("addresses")
                    list.add(Saved(o.getString("name"), (0 until a.length()).map { a.getString(it) }))
                }
            } catch (_: Exception) { }
            return list
        }
        val old = prefs.getString("addresses", null)?.lines()?.map { it.trim() }?.filter { it.isNotEmpty() }
        if (!old.isNullOrEmpty()) list.add(Saved("My server", old))
        else for (part in BuildConfig.DEFAULT_SERVERS.split(';').filter { it.contains('=') }) {
            list.add(Saved(part.substringBefore('='), part.substringAfter('=').split(',').map { it.trim() }.filter { it.isNotEmpty() }))
        }
        saveServers(list)
        return list
    }

    private fun saveServers(list: List<Saved>) {
        val arr = JSONArray()
        for (s in list) arr.put(JSONObject().put("name", s.name).put("addresses", JSONArray(s.addresses)))
        prefs.edit().putString("servers", arr.toString()).apply()
    }

    private fun cleanAddresses(text: String): List<String> =
        text.lines().map { it.trim().removePrefix("http://").trimEnd('/') }
            .filter { it.isNotEmpty() }
            .map { if (it.contains(':')) it else "$it:8790" }
            .filter { ADDRESS.matches(it) }

    private fun reachable(addr: String): Boolean = try {
        Socket().use { it.connect(InetSocketAddress(addr.substringBefore(':'), addr.substringAfter(':').toInt()), 2000) }
        true
    } catch (_: Exception) {
        false
    }

    private fun isPanel(addr: String): Boolean = try {
        val c = URL("http://$addr/api/hello").openConnection() as HttpURLConnection
        c.connectTimeout = 2500
        c.readTimeout = 2500
        try {
            if (c.responseCode == 200) c.inputStream.bufferedReader().use { it.readText() }.contains("server-panel") else true
        } finally { c.disconnect() }
    } catch (_: Exception) {
        false
    }

    private fun connect(index: Int = prefs.getInt("last", 0), hash: String = "") {
        failed = false
        val list = loadServers()
        if (list.isEmpty()) {
            showError("No server yet.\n\nAdd the address of the computer that runs your Server Panel.")
            editServer(null)
            return
        }
        val i = index.coerceIn(0, list.size - 1)
        prefs.edit().putInt("last", i).apply()
        val server = list[i]
        showBusy("Looking for ${server.name}…")
        thread {
            val found = server.addresses.firstOrNull { reachable(it) && isPanel(it) }
            runOnUiThread {
                if (isDestroyed) return@runOnUiThread
                if (found == null) {
                    showError("Can't reach \"${server.name}\".\n\nIs the computer on? You need to be on the same Wi-Fi, or have Tailscale turned on.")
                } else {
                    panel = Uri.parse("http://$found")
                    web.loadUrl("http://$found/$hash")
                }
            }
        }
    }

    private fun showServers() {
        val list = loadServers()
        val labels = list.map { "${it.name}\n${it.addresses.joinToString("  ·  ")}" } + "+  Add a server"
        val b = AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle("Your servers")
            .setItems(labels.toTypedArray()) { _, which -> if (which == list.size) editServer(null) else connect(which) }
            .setNegativeButton("Close", null)
        if (list.isNotEmpty()) b.setNeutralButton("Edit") { _, _ -> pickToEdit() }
        b.show()
    }

    private fun pickToEdit() {
        val list = loadServers()
        AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle("Edit which server?")
            .setItems(list.map { it.name }.toTypedArray()) { _, which -> editServer(which) }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun editServer(index: Int?) {
        val list = loadServers()
        val cur = index?.let { list[it] }
        val name = EditText(this).apply {
            hint = "Name, for example Home server"
            setText(cur?.name ?: "")
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_WORDS
            setSingleLine()
        }
        val addr = EditText(this).apply {
            hint = "192.168.1.20\n100.64.0.5"
            setText(cur?.addresses?.joinToString("\n") ?: "")
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_VARIATION_URI
            minLines = 3
            setHorizontallyScrolling(false)
        }
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; addView(name); addView(addr) }
        val b = AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle(if (cur == null) "Add a server" else "Edit server")
            .setMessage("The address of the computer that runs your Server Panel: its home network address, and its Tailscale address for when you are away (one per line, tried in order). Port 8790 is added for you.")
            .setPositiveButton("Save") { _, _ ->
                val a = cleanAddresses(addr.text.toString())
                if (a.isEmpty()) {
                    Toast.makeText(this, "No valid address, nothing saved", Toast.LENGTH_SHORT).show()
                    return@setPositiveButton
                }
                val s = Saved(name.text.toString().trim().ifEmpty { "My server" }, a)
                if (index == null) list.add(s) else list[index] = s
                saveServers(list)
                connect(index ?: (list.size - 1))
            }
            .setNegativeButton("Cancel", null)
        if (cur != null) b.setNeutralButton("Remove") { _, _ ->
            list.removeAt(index!!)
            saveServers(list)
            connect(0)
        }
        val dialog = b.create()
        dialog.setView(box, dp(20), dp(8), dp(20), 0)
        dialog.show()
    }

    private fun buildOverlay() {
        spinner = ProgressBar(this).apply { isIndeterminate = true }
        message = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 16f
            gravity = Gravity.CENTER
            setPadding(0, dp(16), 0, dp(24))
        }
        retry = Button(this).apply { text = "Try again"; setOnClickListener { connect() } }
        servers = Button(this).apply { text = "Servers"; setOnClickListener { showServers() } }
        overlay = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.BLACK)
            setPadding(dp(32), dp(32), dp(32), dp(32))
            isClickable = true
            addView(spinner)
            addView(message)
            addView(retry)
            addView(servers)
        }
    }

    private fun showBusy(text: String) {
        message.text = text
        spinner.visibility = View.VISIBLE
        retry.visibility = View.GONE
        servers.visibility = View.GONE
        overlay.visibility = View.VISIBLE
    }

    private fun showError(text: String) {
        failed = true
        message.text = text
        spinner.visibility = View.GONE
        retry.visibility = View.VISIBLE
        servers.visibility = View.VISIBLE
        overlay.visibility = View.VISIBLE
    }

    private fun handleInsets() {
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false)
            root.setOnApplyWindowInsetsListener { v, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                val ime = insets.getInsets(WindowInsets.Type.ime())
                v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
                WindowInsets.CONSUMED
            }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == REQ_FILE) {
            chooser?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
            chooser = null
        } else {
            @Suppress("DEPRECATION")
            super.onActivityResult(requestCode, resultCode, data)
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (overlay.visibility == View.VISIBLE) return finish()
        web.evaluateJavascript(
            "(function(){var t=location.hash.slice(1);if(t&&t!=='overview'&&typeof setTab==='function'){setTab('overview');return 1}return 0})()"
        ) { if (it != "1") finish() }
    }

    override fun onPause() {
        CookieManager.getInstance().flush()
        super.onPause()
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    private fun dp(n: Int) = (n * resources.displayMetrics.density).toInt()

    companion object {
        const val REQ_FILE = 1
        val ADDRESS = Regex("^[A-Za-z0-9.-]+:\\d{1,5}$")
        val CODE = Regex("^[A-Za-z0-9-]{4,40}$")
    }
}
