package com.talha.mpvcompanion

import android.net.Uri
import java.util.Locale

/**
 * Android Share / View Intent üzerinden gelen metin veya URL'leri doğrular.
 * Normal bir web sayfası URL'sini (örn: https://example.com/watch?v=123) doğrudan medya
 * akışıymış gibi değerlendirmez; yalnızca gerçek medya akışı (.m3u8, .mp4, .webm vb.)
 * olup olmadığını ayırt eder.
 */
object StreamValidator {

    enum class ValidationCategory {
        DIRECT_MEDIA_STREAM,
        UNSUPPORTED_DRM_OR_DASH,
        NORMAL_WEBPAGE_NOT_STREAM,
        INVALID_URL
    }

    data class ValidationResult(
        val category: ValidationCategory,
        val normalizedUrl: String?,
        val formatLabel: String?,
        val message: String
    )

    private val DIRECT_MEDIA_EXTENSIONS = listOf(
        ".m3u8",
        ".mp4",
        ".webm",
        ".mkv",
        ".m4v",
        ".mov",
        ".ts"
    )

    private val DRM_INDICATORS = listOf(
        ".mpd",
        "widevine",
        "fairplay",
        "playready"
    )

    // Metin içinden ilk http/https URL'sini ayıklamak için düzenli ifade
    private val URL_EXTRACT_REGEX = Regex("""https?://[^\s"'<>]+""", RegexOption.IGNORE_CASE)

    /**
     * Paylaşılan ham metin içerisinden (örn. "Check out this video: https://...") URL'yi ayıklar.
     */
    fun extractFirstHttpUrl(rawText: String?): String? {
        if (rawText.isNullOrBlank()) return null
        val match = URL_EXTRACT_REGEX.find(rawText.trim())
        return match?.value
    }

    /**
     * Verilen URL'nin doğrudan mpv-android'e gönderilebilir bir medya akışı olup olmadığını denetler.
     */
    fun validateMediaCandidate(rawInput: String?): ValidationResult {
        val candidateUrl = extractFirstHttpUrl(rawInput)
            ?: return ValidationResult(
                category = ValidationCategory.INVALID_URL,
                normalizedUrl = null,
                formatLabel = null,
                message = "No valid http:// or https:// URL found in the shared content."
            )

        // Kontrol karakterlerini (CR/LF/Null) reddet
        if (candidateUrl.any { it.code < 0x20 || it.code == 0x7F }) {
            return ValidationResult(
                category = ValidationCategory.INVALID_URL,
                normalizedUrl = null,
                formatLabel = null,
                message = "URL contains invalid control characters."
            )
        }

        val uri = try {
            Uri.parse(candidateUrl)
        } catch (_: Exception) {
            return ValidationResult(
                category = ValidationCategory.INVALID_URL,
                normalizedUrl = null,
                formatLabel = null,
                message = "Malformed URL syntax."
            )
        }

        val scheme = uri.scheme?.lowercase(Locale.ROOT)
        if (scheme != "http" && scheme != "https") {
            return ValidationResult(
                category = ValidationCategory.INVALID_URL,
                normalizedUrl = null,
                formatLabel = null,
                message = "Only http:// and https:// URLs are supported."
            )
        }

        if (uri.host.isNullOrBlank()) {
            return ValidationResult(
                category = ValidationCategory.INVALID_URL,
                normalizedUrl = null,
                formatLabel = null,
                message = "URL is missing a valid hostname."
            )
        }

        val lowerPath = (uri.path ?: "").lowercase(Locale.ROOT)
        val lowerQuery = (uri.query ?: "").lowercase(Locale.ROOT)
        val combined = "$lowerPath?$lowerQuery"

        // DRM veya DASH (.mpd) kontrolü
        if (DRM_INDICATORS.any { combined.contains(it) }) {
            return ValidationResult(
                category = ValidationCategory.UNSUPPORTED_DRM_OR_DASH,
                normalizedUrl = candidateUrl,
                formatLabel = "DRM / DASH",
                message = "Unsupported stream: DRM-protected or DASH (.mpd) streams cannot be opened directly."
            )
        }

        // Doğrudan HLS (.m3u8) kontrolü (path veya r_file=chunklist.m3u8 gibi query parametresi)
        if (lowerPath.endsWith(".m3u8") || lowerPath.contains(".m3u8/") || lowerQuery.contains(".m3u8")) {
            return ValidationResult(
                category = ValidationCategory.DIRECT_MEDIA_STREAM,
                normalizedUrl = candidateUrl,
                formatLabel = "HLS (.m3u8)",
                message = "Valid HLS stream URL detected."
            )
        }

        // Doğrudan MP4 / WebM / MKV kontrolü
        for (ext in DIRECT_MEDIA_EXTENSIONS) {
            if (lowerPath.endsWith(ext) || lowerQuery.contains("$ext&") || lowerQuery.endsWith(ext)) {
                val label = ext.removePrefix(".").uppercase(Locale.ROOT)
                return ValidationResult(
                    category = ValidationCategory.DIRECT_MEDIA_STREAM,
                    normalizedUrl = candidateUrl,
                    formatLabel = label,
                    message = "Valid direct $label media URL detected."
                )
            }
        }

        // MIME veya yaygın CDN stream path işaretçileri (örn: /hls/, /manifest.m3u8, mime=video/mp4)
        if (lowerQuery.contains("mime=video%2fmp4") || lowerQuery.contains("mime=video/mp4") ||
            lowerQuery.contains("mime=video%2fwebm") || lowerQuery.contains("mime=video/webm")
        ) {
            return ValidationResult(
                category = ValidationCategory.DIRECT_MEDIA_STREAM,
                normalizedUrl = candidateUrl,
                formatLabel = "Direct Video",
                message = "Valid video stream URL detected via MIME parameter."
            )
        }

        // Normal web sayfası URL'si: Chrome for Android başka uygulamaların ağ trafiğini okumasına
        // izin vermediği için ve bu bir doğrudan medya akışı olmadığı için kullanıcıya dürüst ve net hata döndürülür.
        return ValidationResult(
            category = ValidationCategory.NORMAL_WEBPAGE_NOT_STREAM,
            normalizedUrl = candidateUrl,
            formatLabel = "Web Page (Not a Direct Stream)",
            message = "This is a standard web page URL, not a direct media stream (.m3u8 / .mp4). " +
                "Chrome for Android does not expose internal network requests to external apps. " +
                "Please share a direct stream URL or use a WebExtensions-capable Android browser with the extension."
        )
    }
}
