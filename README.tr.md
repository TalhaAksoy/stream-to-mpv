> **[🇬🇧 Click here to read in English (README.md)](./README.md)** | **🇹🇷 Türkçe**

# Stream to mpv

**Tek sefer kur, videonun altındaki `▶ mpv` butonuna bas, çözünürlüğü seç ve doğrudan `mpv` oynatıcısında izle.**

**Stream to mpv**, web sitelerinde (YouTube, Twitch, Türkçe anime/dizi izleme sitelerindeki `iframe` oynatıcılar vb.) oynatılan videoların gerçek medya akışlarını (**HLS `.m3u8` Master/Variant**, **`.mp4`**, **`.webm`**, gizlenmiş `.txt` HLS ve `yt-dlp` destekli akışlar) otomatik tespit eden ve video oynatıcısının **kontrol çubuğuna** yerleşen **`▶ mpv`** butonuyla videoyu harici **mpv** uygulamasında açan hafif, güvenli ve sıfır-bağımlılıklı bir sistemdir.

> **Önemli:** Bu proje bir video indirme aracı değildir. Yakalanan akış URL'si ve gerekli HTTP başlıkları (`Referer`, `Origin`, `User-Agent`) doğrudan `mpv` oynatıcısına iletilerek anlık **streaming** yapılır.

---

## Özellikler

- **Oynatıcı Kontrol Çubuğuna Entegre Buton:** YouTube, JWPlayer, Video.js, ArtPlayer, Plyr ve DPlayer gibi oynatıcılarda sağ alttaki ayar/altyazı/tam ekran butonlarının hemen yanına yerleşir. Özel kontrol çubuğu olmayan sitelerde sağ alt köşede şık bir yüzen buton olarak belirir.
- **Çözünürlük Seçim Menüsü:** Butona tıkladığınızda videonun desteklediği çözünürlükleri (**4K 2160p, 2K 1440p, 1080p, 720p, 480p, 360p, Auto/Best** ve **Audio Only**) listeler; seçtiğiniz kalitede `mpv`'yi başlatır.
- **Türkçe Anime & Dizi Siteleri (`iframe` Embed) Desteği:** **OK.ru, VK, Mail.ru, Sibnet, Dailymotion**, Alucard, Tau Video, Vidmoly, Amani vb. `iframe` tabanlı oynatıcılardaki gizlenmiş HLS (`/hls/.../master.txt`), imzalı `.m3u8`, `302` yönlendirmeli CDN linklerini ve çoklu `.mp4` akışlarını hem macOS hem Android için yakalar.
- **YouTube SABR `403` Koruması Uyumlu (macOS & Android):**
  - **macOS:** `mpv` + `yt-dlp` entegrasyonunda HLS (`m3u8`) öncelikli format seçimiyle YouTube videolarını kapanmadan yüksek kare hızında (60fps) oynatır.
  - **Android:** Mobilde `yt-dlp` gerektirmeden doğrudan tarayıcı içinden YouTube HLS `.m3u8` yayın akışını çıkararak `mpv-android` içinde ses + görüntü olarak açar.
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

### 2. Bilgisayar (Linux)

| Bileşen | Durum | Notlar |
| :--- | :--- | :--- |
| **Tarayıcı** | Zorunlu | Chromium, Google Chrome, Brave, Microsoft Edge, Vivaldi, Thorium, Firefox veya LibreWolf |
| **Python 3** | Zorunlu | Dağıtımınızın `python3` paketi |
| **mpv** | Zorunlu | Paket yöneticinizle kurun (`sudo pacman -S mpv`, `sudo apt install mpv`, …) |
| **yt-dlp** | Önerilen | YouTube/Twitch gibi MSE siteleri için (`sudo pacman -S yt-dlp` veya `pipx install yt-dlp`) |

### 3. Android (Telefon / Tablet — Android 8.0+)

| Bileşen | Durum | Açıklama |
| :--- | :--- | :--- |
| **mpv-android** | Zorunlu | Paket adı: `is.xyz.mpv` (Google Play Store veya F-Droid / GitHub Releases üzerinden kurulmalı) |
| **Eklenti Destekli Tarayıcı** | Zorunlu *(Tek Tık Buton İçin)* | **Bare Browser**, **Lemur Browser**, **Mises Browser** (Chromium MV3) veya **Firefox for Android** |

> **Android Chrome Hakkında Önemli Not:** Google'ın standart **Chrome for Android** uygulaması masaüstü eklentilerini (`content_scripts` / `webRequest`) desteklemez. Video üzerinde tek tıklamalık **`▶ mpv`** butonu deneyimi için yukarıdaki eklenti destekli Android tarayıcılarından birini kullanmalısınız. *(Standart Android Chrome'da yalnızca doğrudan `.m3u8`/`.mp4` linklerini paylaşarak açmak isterseniz `android/` klasöründeki yardımcı Kotlin uygulamasını kullanabilirsiniz).*

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

### B. Linux Kurulumu

1. `mpv` (ve isteğe bağlı olarak `yt-dlp`) paketini paket yöneticinizle kurun — `make` sizin yerinize `sudo` çalıştırmaz, yalnızca eksikse uyarır.
2. Klonladığınız klasörde `make` çalıştırın. Host betiği `~/mpv_host/mpv_host.py` konumuna kurulur; Native Messaging manifestleri `~/.config/<tarayıcı>/NativeMessagingHosts` (`$XDG_CONFIG_HOME` dikkate alınır), `~/.mozilla/native-messaging-hosts` ve `~/.librewolf/native-messaging-hosts` altına yazılır.
3. `chrome://extensions` sayfasında **Load unpacked** ile **`extension`** klasörünü yükleyin (yukarıdaki 2. Adım ile aynı).

> **Not:** Flatpak/Snap tarayıcılar sandbox içinde çalıştığı için ev dizinindeki host programını başlatamaz; dağıtımın kendi paketiyle kurulmuş bir tarayıcı kullanın.

---

### C. Android Kurulumu (Bare Browser / Lemur / Mises)

1. Telefonunuza Google Play Store veya GitHub Releases üzerinden **[mpv-android](https://play.google.com/store/apps/details?id=is.xyz.mpv)** (`is.xyz.mpv`) uygulamasını yükleyin.
2. Eklenti destekleyen bir Android tarayıcısı yükleyin (Önerilen: **Bare Browser**, **Lemur Browser** veya **Mises Browser**).
3. Hazır üretilmiş **`dist/stream-to-mpv-extension.zip`** dosyasını telefonunuza gönderin *(veya bilgisayarınızda `make zip` komutuyla yeniden oluşturabilirsiniz)*.
4. Telefondaki tarayıcının **Extensions (`chrome://extensions`)** menüsünü açın, **Developer mode** anahtarını etkinleştirin ve `stream-to-mpv-extension.zip` dosyasını yükleyin.
5. **Bare Browser Kullanıyorsanız Kritik Ayar:** Bare Browser varsayılan olarak tüm harici uygulama geçişlerini engeller (`Open links in apps = Never`). Tek dokunuşla `mpv-android` açılması için **Bare Browser → Settings → Open links in apps → `Always` (veya `Ask`)** seçeneğini etkinleştirin. *(Gizli sekmede veya bu ayarı açmadan kullanmak isterseniz menüdeki **`Share Stream to App…`** seçeneğine basıp Android paylaşım ekranından **Open with mpv** diyerek de açabilirsiniz).*
6. **Android'de VK & OK.ru İçin Tek Seferlik İpucu (İsteğe Bağlı):** **YouTube, Mail.ru, Sibnet, Dailymotion ve Tau** oynatıcıları `mpv-android` içinde hiçbir ek ayar olmadan doğrudan açılır. **VK** ve **OK.ru** sunucuları (`vkuser.net`) URL imzasında tarayıcı `User-Agent` (`srcAg`) kontrolü yaptığı için, bu iki oynatıcının da Android'de sorunsuz açılması adına **`mpv-android → Settings → Advanced → Edit mpv.conf`** ekranına tek seferlik şu satırı ekleyebilirsiniz:
   ```ini
   user-agent="Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
   ```

---

## Kullanım İpuçları

- **Çözünürlük Seçimi:** Oynatıcının sağ altındaki **`▶ mpv`** butonuna tıklayın -> Açılan menüden **`1080p`**, **`720p`**, **`Auto (Best Quality)`** veya **`Audio Only`** seçeneğine tıklayın. Video tarayıcıda otomatik duraklatılır ve `mpv` penceresinde başlar.
- **Anime / Dizi Sitelerinde Kullanım:** Çoğu Türkçe anime sitesinde video oynatıcısının üzerinde önce sahte bir kapak/reklam katmanı bulunur. Önce videonun ortasındaki Play tuşuna bir kez basıp gerçek videonun yüklenmesini sağlayın, ardından sağ alttaki **`▶ mpv`** butonuna tıklayın.
- **Toolbar Popup Menüsü:** Tarayıcının sağ üstündeki eklenti ikonuna tıklayarak bağlantı durumunu (`mpv Ready` / `Android Ready`) görebilir veya isterseniz `Auto-open videos` (otomatik açma, varsayılan kapalıdır) özelliğini açıp kapatabilirsiniz.

---

## Bilinen Sınırlar ve Güvenlik Notları

1. **DRM Korumalı İçerikler (Netflix, Disney+, Spotify vb.):** Widevine / FairPlay şifreli içerikler yasal ve teknik olarak harici oynatıcılarda çözülemez; eklenti bu akışları tespit ettiğinde `Unsupported stream (DRM)` uyarısı gösterir.
2. **Android Intent HTTP Başlık Kısıtı:** Resmi `mpv-android` (`is.xyz.mpv`) uygulaması, Android `ACTION_VIEW` Intent'leri üzerinden özel HTTP `Referer` veya `User-Agent` başlıklarını henüz okumamaktadır (`MPVActivity.kt` kaynak kodunda `TODO` durumundadır). **YouTube, Mail.ru, Sibnet, Dailymotion, Tau ve GDrive** Android'de hiçbir ayar olmadan doğrudan açılır; **VK ve OK.ru** ise `mpv.conf` içine yukarıdaki 6. adımda verilen `user-agent` satırı eklendiğinde doğrudan çalışır. Yalnızca sıkı `Referer` korumalı bazı sunucular (örn. Alucard / Vidmoly) Android üzerinde `403` dönebilir (macOS üzerinde ise `Referer` + `Origin` + `User-Agent` tam desteklidir ve hepsi sorunsuz çalışır).
3. **Gizlilik ve Güvenlik:** Eklenti çerezlerinizi (`Cookie`) veya `Authorization` başlıklarınızı izinsiz olarak harici süreçlere sızdırmaz. Native Host (`mpv_host.py`) yalnızca `http://` ve `https://` şemalarını kabul eder, `shell=False` ile çalışır ve çağrıyı yapan eklenti kimliğini (`allowed_origins`) doğrular.

---

## Geliştirici Komutları ve Testler

Proje hiçbir harici JavaScript framework'ü veya bundler gerektirmez. Tüm birim, yaşam döngüsü, güvenlik ve gerçek `mpv` + `ffmpeg` anime HLS entegrasyon testlerini çalıştırmak için:

```bash
# Kurulum, bağlantı doğrulaması ve mobil zip üretimi
make

# Tüm otomatik test paketlerini çalıştır (Node.js + Python 3 + gerçek mpv/ffmpeg testi)
make test

# Mobil eklenti arşivini (dist/stream-to-mpv-extension.zip) yeniden oluştur
make zip

# Dağıtılabilir macOS kurulum paketini (dist/StreamToMpv-Installer.pkg) yeniden oluştur
make pkg

# Chrome Web Store ve Firefox AMO yükleme paketlerini (dist/store/*.zip) üret ve Firefox paketini denetle
make store
```

---

## Proje Dizin Yapısı

```text
.
├── Makefile                        # Tek komutluk kurulum (make), doğrulama ve test yöneticisi
├── Install Stream to mpv.command   # Finder'dan çift tıklamayla çalışan macOS kurulum betiği
├── README.md                       # İngilizce dokümantasyon (varsayılan)
├── README.tr.md                    # Türkçe dokümantasyon
├── PRIVACY.md                      # Gizlilik politikası (mağaza sayfaları için)
├── LICENSE                         # MIT Lisansı
├── tools/build_store_zips.sh       # Chrome Web Store ve Firefox AMO paket üreticisi
├── dist/
│   ├── StreamToMpv-Installer.pkg   # Standart macOS kurulum paketi
│   └── stream-to-mpv-extension.zip # Android tarayıcılar için hazır eklenti arşivi
├── extension/                      # Tarayıcı eklentisi (Manifest V3, saf JS)
│   ├── manifest.json               # Eklenti izinleri ve sabit ortak anahtar
│   ├── content.js                  # Oynatıcı kontrol çubuğu butonu, menü ve Android YT HLS çıkarıcı
│   ├── background.js               # webRequest akış yakalama, frameId eşleştirme ve Native Messaging
│   ├── stream_utils.js             # HLS Master (#EXT-X-STREAM-INF) ayrıştırma ve akış önceliklendirme
│   ├── popup.html                  # Sade durum ve ayar penceresi
│   └── popup.js                    # Popup mantığı
├── native/                         # macOS & Linux Native Messaging Host
│   ├── mpv_host.py                 # Güvenli Python 3 mpv & yt-dlp başlatıcısı (com.talha.mpv)
│   ├── install.sh                  # Tüm Chromium/Firefox tarayıcılarını otomatik yapılandıran betik
│   ├── build_macos_pkg.sh          # .pkg paket üretici
│   └── com.talha.mpv.json.example  # Örnek Native Messaging manifest şablonu
├── android/                        # Standart Android tarayıcılar için isteğe bağlı Share Intent Kotlin uygulaması
└── tests/                          # Otomatik birim, yaşam döngüsü, güvenlik ve gerçek mpv E2E testleri
```

---

## Lisans

[MIT](./LICENSE) · [Gizlilik Politikası](./PRIVACY.md)
