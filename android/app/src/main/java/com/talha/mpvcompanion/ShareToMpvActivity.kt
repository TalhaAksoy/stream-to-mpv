package com.talha.mpvcompanion

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * Android Companion Activity (ShareToMpvActivity)
 *
 * Hedef:
 * - Package: is.xyz.mpv
 * - Action: android.intent.action.VIEW
 * - MIME: video/*
 * - Data: Güncel medya URL'si
 *
 * Önemli Doğrulama Notu:
 * mpv-android'in resmi kaynak kodunda (MPVActivity.kt -> parseIntentExtras) HTTP Referer ve User-Agent
 * başlıklarının Intent extra olarak aktarımı desteklenmemektedir (kaynak kodda `TODO: headers would be good`
 * olarak bırakılmıştır). Bu uygulama desteklenmeyen bir özelliği çalışıyormuş gibi taklit etmez ve
 * kullanıcıyı bu teknik sınır hakkında açıkça bilgilendirir.
 */
class ShareToMpvActivity : Activity() {

    companion object {
        private const val MPV_PACKAGE = "is.xyz.mpv"
        private const val MPV_MIME_TYPE = "video/*"
    }

    private lateinit var urlInput: EditText
    private lateinit var statusBox: TextView
    private lateinit var launchBtn: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setupMinimalUi()
        handleIncomingIntent(intent)
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        if (intent != null) {
            setIntent(intent)
            handleIncomingIntent(intent)
        }
    }

    /**
     * Harici kütüphane (AppCompat/Material) gerektirmeyen sade, modern programatik arayüz.
     */
    private fun setupMinimalUi() {
        val density = resources.displayMetrics.density
        fun dp(value: Int): Int = (value * density).toInt()

        val scrollView = ScrollView(this).apply {
            setBackgroundColor(Color.parseColor("#0F1117"))
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(32), dp(20), dp(24))
        }

        val titleView = TextView(this).apply {
            text = "Stream to mpv (Android Companion)"
            textSize = 19f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#F0F3F8"))
        }

        val subtitleView = TextView(this).apply {
            text = "Target: is.xyz.mpv · ACTION_VIEW · MIME: video/*"
            textSize = 12f
            setTextColor(Color.parseColor("#9BA3B5"))
            setPadding(0, dp(4), 0, dp(18))
        }

        val inputLabel = TextView(this).apply {
            text = "Direct Media Stream URL (.m3u8 / .mp4 / .webm):"
            textSize = 13f
            setTextColor(Color.parseColor("#D0D6E2"))
            setPadding(0, 0, 0, dp(6))
        }

        urlInput = EditText(this).apply {
            hint = "https://example.com/master.m3u8"
            setHintTextColor(Color.parseColor("#5E6678"))
            setTextColor(Color.parseColor("#F0F3F8"))
            textSize = 14f
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setPadding(dp(12), dp(12), dp(12), dp(12))
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#1F2430"))
                setStroke(dp(1), Color.parseColor("#2E3446"))
                cornerRadius = dp(8).toFloat()
            }
        }

        launchBtn = Button(this).apply {
            text = "Open in mpv-android"
            isAllCaps = false
            textSize = 15f
            setTextColor(Color.WHITE)
            setTypeface(typeface, Typeface.BOLD)
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#8E44AD"))
                cornerRadius = dp(8).toFloat()
            }
            val params = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(48)
            ).apply {
                topMargin = dp(14)
            }
            layoutParams = params
            setOnClickListener {
                validateAndLaunch(urlInput.text?.toString(), autoFinishOnSuccess = false)
            }
        }

        statusBox = TextView(this).apply {
            textSize = 13f
            setTextColor(Color.parseColor("#D0D6E2"))
            setPadding(dp(14), dp(14), dp(14), dp(14))
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#181B24"))
                setStroke(dp(1), Color.parseColor("#2E3446"))
                cornerRadius = dp(8).toFloat()
            }
            val params = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = dp(16)
            }
            layoutParams = params
            text = "Share a direct .m3u8 or .mp4 link from your browser, or paste a stream URL above."
        }

        val noteView = TextView(this).apply {
            textSize = 12f
            setTextColor(Color.parseColor("#858E9E"))
            setPadding(0, dp(20), 0, 0)
            gravity = Gravity.START
            text = "Platform Limitations:\n" +
                "• Standard Chrome for Android does not support desktop extensions or allow other apps to inspect tab network requests.\n" +
                "• Official mpv-android (is.xyz.mpv) supports ACTION_VIEW with video/any, but does NOT parse custom HTTP Referer or User-Agent headers from Intent extras."
        }

        root.addView(titleView)
        root.addView(subtitleView)
        root.addView(inputLabel)
        root.addView(urlInput)
        root.addView(launchBtn)
        root.addView(statusBox)
        root.addView(noteView)

        scrollView.addView(root)
        setContentView(scrollView)
    }

    /**
     * Gelen ACTION_SEND (Share) veya ACTION_VIEW Intent'ini işler.
     */
    private fun handleIncomingIntent(incoming: Intent?) {
        if (incoming == null) return

        when (incoming.action) {
            Intent.ACTION_SEND -> {
                val sharedText = incoming.getStringExtra(Intent.EXTRA_TEXT)
                if (!sharedText.isNullOrBlank()) {
                    val extracted = StreamValidator.extractFirstHttpUrl(sharedText) ?: sharedText
                    urlInput.setText(extracted)
                    validateAndLaunch(sharedText, autoFinishOnSuccess = false)
                } else {
                    updateStatus("Shared content did not contain any text or URL.", isError = true)
                }
            }
            Intent.ACTION_VIEW -> {
                val dataUrl = incoming.dataString
                if (!dataUrl.isNullOrBlank()) {
                    urlInput.setText(dataUrl)
                    validateAndLaunch(dataUrl, autoFinishOnSuccess = false)
                }
            }
        }
    }

    /**
     * URL'yi doğrular; geçerli bir medya akışıysa mpv-android'i başlatır,
     * normal bir web sayfasıysa veya DRM içeriyorsa anlamlı hata gösterir.
     */
    private fun validateAndLaunch(rawInput: String?, autoFinishOnSuccess: Boolean) {
        val result = StreamValidator.validateMediaCandidate(rawInput)

        when (result.category) {
            StreamValidator.ValidationCategory.DIRECT_MEDIA_STREAM -> {
                val streamUrl = result.normalizedUrl!!
                launchMpvIntent(streamUrl, result.formatLabel ?: "Stream", autoFinishOnSuccess)
            }
            StreamValidator.ValidationCategory.NORMAL_WEBPAGE_NOT_STREAM -> {
                updateStatus(
                    "Not a direct media stream:\n${result.message}",
                    isError = true
                )
            }
            StreamValidator.ValidationCategory.UNSUPPORTED_DRM_OR_DASH -> {
                updateStatus(
                    "Unsupported stream:\n${result.message}",
                    isError = true
                )
            }
            StreamValidator.ValidationCategory.INVALID_URL -> {
                updateStatus(
                    "Invalid URL:\n${result.message}",
                    isError = true
                )
            }
        }
    }

    /**
     * mpv-android (is.xyz.mpv) paketinin cihazda yüklü olup olmadığını kontrol eder.
     */
    private fun isMpvInstalled(): Boolean {
        return try {
            packageManager.getPackageInfo(MPV_PACKAGE, 0)
            true
        } catch (_: PackageManager.NameNotFoundException) {
            false
        }
    }

    /**
     * Resmi mpv-android Intent API'sini kullanarak (ACTION_VIEW, is.xyz.mpv, video/any) oynatıcıyı başlatır.
     */
    private fun launchMpvIntent(streamUrl: String, formatLabel: String, autoFinish: Boolean) {
        if (!isMpvInstalled()) {
            updateStatus(
                "mpv-android ($MPV_PACKAGE) is not installed on this device.\n" +
                    "Please install mpv-android from Google Play or GitHub Releases.",
                isError = true
            )
            return
        }

        val mpvIntent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndTypeAndNormalize(Uri.parse(streamUrl), MPV_MIME_TYPE)
            setPackage(MPV_PACKAGE)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }

        try {
            startActivity(mpvIntent)
            updateStatus(
                "mpv launch requested ($formatLabel).\n" +
                    "Note: If the stream requires a restricted HTTP Referer, mpv-android does not receive headers via Intent.",
                isError = false
            )
            if (autoFinish) {
                finish()
            }
        } catch (e: ActivityNotFoundException) {
            updateStatus(
                "Could not launch mpv-android ($MPV_PACKAGE): Activity not found for ACTION_VIEW with MIME $MPV_MIME_TYPE.",
                isError = true
            )
        } catch (e: Exception) {
            updateStatus(
                "Failed to start mpv-android: ${e.javaClass.simpleName}",
                isError = true
            )
        }
    }

    private fun updateStatus(message: String, isError: Boolean) {
        statusBox.text = message
        val bg = statusBox.background as? GradientDrawable ?: return
        if (isError) {
            bg.setColor(Color.parseColor("#2C1618"))
            bg.setStroke(2, Color.parseColor("#E74C3C"))
            statusBox.setTextColor(Color.parseColor("#F1948A"))
        } else {
            bg.setColor(Color.parseColor("#14291D"))
            bg.setStroke(2, Color.parseColor("#2ECC71"))
            statusBox.setTextColor(Color.parseColor("#82E0AA"))
        }
    }
}
