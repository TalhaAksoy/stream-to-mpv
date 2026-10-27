# Stream to mpv

**Tek sefer kur, videonun altındaki `mpv` butonuna bas, çözünürlüğü seç ve doğrudan `mpv` oynatıcısında izle.**

**Stream to mpv**, web sitelerinde (YouTube, Twitch, Türkçe anime/dizi izleme sitelerindeki `iframe` oynatıcılar vb.) oynatılan videoların gerçek medya akışlarını (**HLS `.m3u8` Master/Variant**, **`.mp4`**, **`.webm`** ve `yt-dlp` destekli akışlar) otomatik tespit eden ve video oynatıcısının **kontrol çubuğuna** yerleşen **`▶ mpv`** butonuyla videoyu harici **mpv** uygulamasında açan hafif, güvenli ve sıfır-bağımlılıklı bir sistemdir.

> **Önemli:** Bu proje bir video indirme aracı değildir. Yakalanan akış URL'si ve gerekli HTTP başlıkları (`Referer`, `Origin`, `User-Agent`) doğrudan `mpv` oynatıcısına iletilerek anlık **streaming** yapılır.

---

## Özellikler

- **Oynatıcı Kontrol Çubuğuna Entegre Buton:** YouTube, JWPlayer, Video.js, ArtPlayer, Plyr ve DPlayer gibi oynatıcılarda sağ alttaki ayar/altyazı/tam ekran butonlarının hemen yanına yerleşir. Özel kontrol çubuğu olmayan sitelerde sağ alt köşede şık bir yüzen buton olarak belirir.
- **Çözünürlük Seçim Menüsü:** Butona tıkladığınızda videonun desteklediği çözünürlükleri (**4K 2160p, 2K 1440p, 1080p, 720p, 480p, 360p, Auto/Best** ve **Audio Only**) listeler; seçtiğiniz kalitede `mpv`'yi başlatır.
- **Türkçe Anime & Dizi Siteleri (`iframe` Embed) Desteği:** Alucard, Tau Video, Vidmoly, Sibnet, Amani vb. `iframe` tabanlı oynatıcılardaki gizlenmiş HLS (`/hls/.../master.txt`), imzalı `.m3u8` ve çoklu `.mp4` akışlarını yakalar; `403 Forbidden` hatası almamak için `Referer` ve `User-Agent` başlıklarını `mpv`'ye aktarır.
- **YouTube SABR `403` Koruması Uyumlu:** `mpv` + `yt-dlp` entegrasyonunda HLS (`m3u8`) öncelikli format seçimiyle YouTube videolarını kapanmadan yüksek kare hızında (60fps) oynatır.
- **Sıfır Konfigürasyonlu Kurulum:** Eklenti ID'si kopyalama veya JSON dosyası düzenleme gerektirmez (`make` komutu her şeyi otomatik kurar ve doğrular).

---

## Gereksinimler (Requirements)

### 1. Bilgisayar (macOS — Apple Silicon & Intel)

| Bileşen | Durum | Açıklama |
| :--- | :--- | :--- |
| **macOS** | Zorunlu | macOS 12+ (Apple Silicon M1/M2/M3/M4 veya Intel) |
| **Tarayıcı** | Zorunlu | Google Chrome, Chromium, Brave, Microsoft Edge, Vivaldi, Arc veya Opera |
| **Python 3** | Zorunlu | macOS üzerinde yerleşik gelir (`/usr/bin/python3` 3.9+ tam uyumludur) |
| **Homebrew** | Önerilen | `mpv` ve `yt-dlp` paketlerini otomatik kurmak için (`https://brew.sh`) |
| **mpv** | Zorunlu | `make` komutu eksikse Homebrew üzerinden otomatik kurar (`brew install mpv`) |
| **yt-dlp** | Önerilen | YouTube/Twitch gibi MSE siteleri için (`make` eksikse otomatik kurar: `brew install yt-dlp`) |
| **deno** *(İsteğe bağlı)* | Önerilen | Güncel `yt-dlp` sürümlerinin YouTube JS imzalarını hızlı çözmesi için (`brew install deno`) |

### 2. Android (Telefon / Tablet — Android 8.0+)

| Bileşen | Durum | Açıklama |
| :--- | :--- | :--- |
| **mpv-android** | Zorunlu | Paket adı: `is.xyz.mpv` (Google Play Store veya F-Droid / GitHub Releases üzerinden kurulmalı) |
| **Eklenti Destekli Tarayıcı** | Zorunlu *(Tek Tık Buton İçin)* | **Bare Browser**, **Lemur Browser**, **Mises Browser** (Chromium MV3) veya **Firefox for Android** |

> **Android Chrome Hakkında Önemli Not:** Google'ın standart **Chrome for Android** uygulaması masaüstü eklentilerini (`content_scripts` / `webRequest`) desteklemez. Video üzerinde tek tıklamalık **`mpv`** butonu deneyimi için yukarıdaki eklenti destekli Android tarayıcılarından birini kullanmalısınız. *(Standart Android Chrome'da yalnızca doğrudan `.m3u8`/`.mp4` linklerini paylaşarak açmak isterseniz `android/` klasöründeki yardımcı Kotlin uygulamasını kullanabilirsiniz).*

---

## Kurulum Rehberi

### A. macOS Kurulumu (2 Adımda Hazır)

#### 1. Adım: Arka Plan Köprüsünü ve Bağımlılıkları Kurun

Projeyi indirin ve klasörün içinde terminali açıp sadece **`make`** yazın:

```bash
git clone https://github.com/TalhaAksoy/stream-to-mpv.git
cd stream-to-mpv
make
```

> **Alternatif (Terminalsiz):** Klasör içindeki **`Install Stream to mpv.command`** veya **`dist/StreamToMpv-Installer.pkg`** dosyasına Finder'da çift tıklayarak da aynı kurulumu yapabilirsiniz.

`make` komutu şunları otomatik yapar:
1. Sisteminizde `mpv` ve `yt-dlp` kurulu değilse Homebrew ile kurar.
2. `~/mpv_host/mpv_host.py` dosyasını kurar.
3. Chrome, Chromium, Brave, Edge, Vivaldi, Arc, Opera ve Firefox için Native Messaging izin kayıtlarını (Eklenti ID'si sormadan) otomatik oluşturur ve bağlantıyı test eder.

#### 2. Adım: Eklentiyi Tarayıcıya Yükleyin

1. Tarayıcınızı (örn. Google Chrome) açın ve adres çubuğuna **`chrome://extensions`** yazıp Enter'a basın.
2. Sağ üst köşedeki **Geliştirici modu (Developer mode)** anahtarını açın.
3. Sol üstteki **Paketlenmemiş öğe yükle (Load unpacked)** butonuna tıklayın.
4. Proje klasörünün içindeki **`extension`** klasörünü seçin.

**Kurulum bitti!** Artık herhangi bir video açtığınızda sağ alt kontrol çubuğundaki **`▶ mpv`** butonuna tıklayıp istediğiniz çözünürlüğü seçebilirsiniz.

---

### B. Android Kurulumu (Bare Browser / Lemur / Mises)

1. Telefonunuza Google Play Store veya GitHub Releases üzerinden **[mpv-android](https://play.google.com/store/apps/details?id=is.xyz.mpv)** (`is.xyz.mpv`) uygulamasını yükleyin.
2. Eklenti destekleyen bir Android tarayıcısı yükleyin (Önerilen: **Bare Browser**, **Lemur Browser** veya **Mises Browser**).
3. Proje klasöründe **`make zip`** komutunu çalıştırın (veya hazır üretilmiş **`dist/stream-to-mpv-extension.zip`** dosyasını doğrudan telefonunuza gönderin):
   ```bash
   make zip
   ```
4. Telefondaki tarayıcının **Extensions (`chrome://extensions`)** menüsünü açın, **Developer mode** anahtarını etkinleştirin ve `stream-to-mpv-extension.zip` dosyasını (veya klasörünü) yükleyin.
5. **Bare Browser Kullanıyorsanız Kritik Ayar:** Bare Browser varsayılan olarak tüm harici uygulama geçişlerini engeller (`Open links in apps = Never`). Tek dokunuşla `mpv-android` açılması için **Bare Browser → Settings → Open links in apps → `Always` (veya `Ask`)** seçeneğini etkinleştirin. *(Gizli sekmede veya bu ayarı açmadan kullanmak isterseniz menüdeki **`Share Stream to App…`** seçeneğine basıp Android paylaşım ekranından **Open with mpv** diyerek de açabilirsiniz).*
6. **Mobilde YouTube Notu:** Doğrudan `.m3u8` / `.mp4` sunan siteler `mpv-android` içinde anında açılır. YouTube linklerini mobilde `mpv-android` ile açmak için `mpv-android` içinde `ytdl` desteğinin açık/destekli olması gerekir (aksi halde YouTube için NewPipe/PipePipe veya doğrudan HLS/MP4 siteleri tercih edilmelidir).

---

## Kullanım İpuçları

- **Çözünürlük Seçimi:** Oynatıcının sağ altındaki **`▶ mpv`** butonuna tıklayın -> Açılan menüden **`1080p`**, **`720p`**, **`Auto (Best Quality)`** veya **`Audio Only`** seçeneğine tıklayın. Video tarayıcıda otomatik duraklatılır ve `mpv` penceresinde başlar.
- **Anime / Dizi Sitelerinde Kullanım:** Çoğu Türkçe anime sitesinde video oynatıcısının üzerinde önce sahte bir kapak/reklam katmanı bulunur. Önce videonun ortasındaki Play tuşuna bir kez basıp gerçek videonun yüklenmesini sağlayın, ardından sağ alttaki **`▶ mpv`** butonuna tıklayın.
- **Toolbar Popup Menüsü:** Tarayıcının sağ üstündeki eklenti ikonuna tıklayarak bağlantı durumunu (`mpv Ready`) görebilir veya isterseniz `Auto-open videos` (otomatik açma, varsayılan kapalıdır) özelliğini açıp kapatabilirsiniz.

---

## Bilinen Sınırlar ve Güvenlik Notları

1. **DRM Korumalı İçerikler (Netflix, Disney+, Spotify vb.):** Widevine / FairPlay şifreli içerikler yasal ve teknik olarak harici oynatıcılarda çözülemez; eklenti bu akışları tespit ettiğinde `Unsupported stream (DRM)` uyarısı gösterir.
2. **Android Intent HTTP Başlık Kısıtı:** Resmi `mpv-android` (`is.xyz.mpv`) uygulaması, Android `ACTION_VIEW` Intent'leri üzerinden özel HTTP `Referer` veya `User-Agent` başlıklarını henüz okumamaktadır (`MPVActivity.kt` kaynak kodunda `TODO` durumundadır). Bu nedenle sıkı `Referer` kontrolü yapmayan doğrudan `.m3u8` ve `.mp4` akışları Android'de tek tıklamayla açılırken, sıkı `Referer` korumalı bazı embed sunucuları Android üzerinde `403` hatası verebilir (macOS üzerinde ise `Referer` + `Origin` + `User-Agent` tam desteklidir ve sorunsuz çalışır).
3. **Tam Ekran (Fullscreen) Görünürlüğü:** YouTube, JWPlayer, Video.js, ArtPlayer gibi özel kapsayıcı kullanan tüm sitelerde tam ekranda buton görünür kalır. Yalnızca tarayıcının saf `<video>` etiketini doğrudan tam ekran yaptığı nadir sitelerde tarayıcı güvenlik mimarisi `<video>` içine harici buton çizilmesine izin vermez.
4. **Gizlilik ve Güvenlik:** Eklenti çerezlerinizi (`Cookie`) veya `Authorization` başlıklarınızı izinsiz olarak harici süreçlere sızdırmaz. Native Host (`mpv_host.py`) yalnızca `http://` ve `https://` şemalarını kabul eder, `shell=False` ile çalışır ve çağrıyı yapan eklenti kimliğini (`allowed_origins`) doğrular.

---

## Geliştirici Komutları ve Testler

Proje hiçbir harici JavaScript framework'ü veya bundler gerektirmez. Tüm birim, yaşam döngüsü, güvenlik ve gerçek `mpv` + `ffmpeg` anime HLS entegrasyon testlerini çalıştırmak için:

```bash
# Kurulum ve bağlantı doğrulaması
make

# Tüm otomatik test paketlerini çalıştır (Node.js + Python 3 + gerçek mpv/ffmpeg testi)
make test

# Dağıtılabilir macOS kurulum paketini (dist/StreamToMpv-Installer.pkg) yeniden oluştur
make pkg
```

---

## Proje Dizin Yapısı

```text
.
├── Makefile                        # Tek komutluk kurulum (make), doğrulama ve test yöneticisi
├── Install Stream to mpv.command   # Finder'dan çift tıklamayla çalışan macOS kurulum betiği
├── dist/
│   └── StreamToMpv-Installer.pkg   # Standart macOS kurulum paketi
├── extension/                      # Tarayıcı eklentisi (Manifest V3, saf JS)
│   ├── manifest.json               # Eklenti izinleri ve sabit ortak anahtar
│   ├── content.js                  # Oynatıcı kontrol çubuğu butonu ve çözünürlük menüsü (Shadow DOM)
│   ├── background.js               # webRequest akış yakalama, frameId eşleştirme ve Native Messaging
│   ├── stream_utils.js             # HLS Master (#EXT-X-STREAM-INF) ayrıştırma ve akış önceliklendirme
│   ├── popup.html                  # Sade durum ve ayar penceresi
│   └── popup.js                    # Popup mantığı
├── native/                         # macOS Native Messaging Host
│   ├── mpv_host.py                 # Güvenli Python 3 mpv & yt-dlp başlatıcısı (com.talha.mpv)
│   ├── install.sh                  # Tüm Chromium/Firefox tarayıcılarını otomatik yapılandıran betik
│   ├── build_macos_pkg.sh          # .pkg paket üretici
│   └── com.talha.mpv.json.example  # Örnek Native Messaging manifest şablonu
├── android/                        # Standart Android Chrome için isteğe bağlı Share Intent Kotlin uygulaması
└── tests/                          # Otomatik birim, yaşam döngüsü, güvenlik ve gerçek mpv E2E testleri
```
