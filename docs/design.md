# Crateball — tasarım

Tarayıcıda linkle açılan 1–3 v 1–3 arcade futbol. Rastgele yerlerde kutular düşer;
oyuncu kutuya değince açılır.

## Kurallar (sabitler: `packages/sim/src/content/rules.ts`)

- Saha 840×400 px, 60 tick/sn. Fizik: daire çarpışmaları, sönümleme, vuruş tuşu basılıyken
  yavaşlama, tuşa her basışta bir vuruş.
- Maç 3 dk, 5 gole kadar; süre bittiğinde berabere ise altın gol.
- Can 3; ölünce 3 sn sonra orta çizginin bir ucunda, kendi yarısında doğar: üst yarıda öldüyse alt uçta, alt yarıda öldüyse üst uçta. Her santrada (gol sonrası dahil) herkesin canı dolar, eşyalar ve kutular silinir.
- Kutu ağırlıkları (100 üzerinden; kötüler = iyiler = 50): Mine 20, Ice 16, Dizzy 14 | Gun 18, Speed 7,
  Shield 7, Power kick 6, Teleport 6, Bazooka 6.
- **Dizzy** (kötü): 4 sn yön tuşları ters çalışır; kafadan kabarcıklar çıkar. Santrada ve ölünce geçer.
- **Shield** süresiz: gol olana ya da ilk kötü şey gelene kadar kalır ve onu tek seferlik engeller (mermi,
  roket, patlama, mayın, buz, sarhoş). Engellediğinde "BLOCKED!", kırılan cam efekti ve "ting" sesi.
- Kutu içerikleri: **Gun** (3 mermi, yeni silah 3’e doldurur; otomatik nişan: en yakın, önü açık rakip; hedef alınana kırmızı uyarı; 3 isabet öldürür, topa da çarpar), **Mine** (patlar:
  açana 1 hasar + 4 sn yavaşlama, çevredekileri ve topu iter), **Ice** (2.5 sn donma), **Speed**,
  **Shield** (bir hasarı emer), **Power kick** (sonraki vuruş 2.2×), **Teleport** (elde tutulur; E/F/Shift
  ile o an basılan yön tuşlarının yönüne sabit 150 px sıçratır, tuşa basılmıyorsa son hareket yönüne;
  hız korunur, saha sınırında durur; donmuşken kullanılamaz, ölünce/santrada kaybolur), **Bazooka** (en nadir
  kutu; tek roket; tuşla yön verilmez, menzildeki en yakın rakibe kilitlenir (arada top ya da takım
  arkadaşı olsa da), hedefe kırmızı uyarı düşer; roket hedefi takip eder ama sınırlı döner, son anda yana
  kaçan kurtulabilir; isabet 3 can götürür yani öldürür, kalkan bir kez durdurur; toptan ve takım
  arkadaşlarından geçer).
- Elde tek eşya: Gun, Teleport ve Bazooka aynı tuşu (E/F/Shift) kullanır, yeni gelen eskisinin yerini
  alır. Silah tuş basılıyken ateşler; ışınlanma ve bazuka yeni bir basış ister. Bazukalı bot kilitlenince ateşler. Botlar gitmek istedikleri yere uzak kalınca
  (200 px+) o yöne sıçrar.
- Mevkiler (herkes topa koşmasın diye; bonus yalnızca kendi bölgesinde):
  GK kendi ceza sahasında büyük (r 22), DF kendi yarısında ağır + hızlı, MF orta bölgede uzun
  menzil + sert pas + geniş pas yardımı, FW hücum bölgesinde en hızlı + en sert şut. 1–4 tuşlarıyla değişir (takım
  arkadaşıyla takas).
- Pas: vuruş yönü bir takım arkadaşına ±6° (orta saha kendi bölgesinde ±15°) yakınsa top ona doğru
  bükülür ve koşusunun önüne atılır; kale ağzına giden şut bükülmez. Vuruş tuşu basılı değilken
  topa değmek "hafif dokunuş"tur (top az seker, kontrol kolay). Kendi oyuncunun topa yakınken
  vuruş yönünü gösteren ok çizilir; pas yardımı devredeyse sarı olur ve alıcıyı halkayla gösterir.
- Botlar takımları eşitler (tek kişi gelirse 1v1 bot); mevkilerini korurlar.

## Sahalar

Her santrada (maç başı ve her gol sonrası) saha değişir. Host lobide hangi sahaların dönüşte olacağını
seçer (en az biri). Sıra maç başlarken bu havuzdan çekilir: en fazla 2 × gol limiti santra; her turda
havuzdaki sahaların hepsi birer kez, aynı saha üst üste gelmez (tek saha seçiliyse hep o).

- **Classic:** normal saha.
- **Rain:** kaygan ve ağır zemin (top daha uzağa yuvarlanır, oyuncular kayar, ivme ×0.85). Düzensiz
  su birikintileri oluşur, 9–14 sn kalır, kurur; yenileri çıkar (3–5 tane). Birikintide oyuncu ×0.55,
  top hızla yavaşlar.
- **Volcano:** üst kenardan aşağı kıvrılarak akan lav dereleri (en fazla 2). Sıcak lav can götürmez,
  yavaşlatır (×0.5); ~10 sn'de soğur. Patlamalar yalnızca sıcak lavın üstünde: 1.5 sn uyarı, sonra
  merkezde 1 hasar ve 90 px içinde herkesi ve topu savurur.
- **Ice:** çok kaygan (ivme ×0.55, top neredeyse yavaşlamaz); koşanların ayağından buz kırıntıları.
- **Wind:** topa hafif rüzgâr kuvveti; yön 360° yumuşakça döner (skorun altında ok).
- Sesler: yağmur/volkan/rüzgâr uğultusu, birikintide şıpırtı, lavda cızırtı, patlama öncesi
  gümbürtü, buzda kayma.

## Menü ve lobi

- Ana menü: takma ad → **Create Room** (ad, herkese açık/özel, ayarlar) / **Find Room** (`GET /rooms`,
  arama) / **Join with Code** (4 harf, I/O yok). `/r/KOD` linki takma ad kayıtlıysa direkt katılır.
- Lobi: iki takım sütunu, herkes kendi mevkisini seçer (GK/DF/MF/FW), "Join Red/Blue". Host
  sürükle-bırak ile oyuncuyu başka oyuncunun üstüne bırakırsa ikisi takım+mevki takası yapar,
  takım sütununa bırakırsa taşır. Ayarlar (süre 2/3/5/10 dk, gol limiti 3/5/7/10, kutular
  kapalı/normal/kaos, kutu içerikleri, sahalar, botlarla doldur) yalnızca host'ta düzenlenir; **Start Game**
  yalnızca host. Host bir oyuncuyu ✕ ile odadan atabilir; atılan aynı sekmeden (yenilese de) o odaya
  geri giremez. Takım değişikliği yalnızca lobide; maç başlayınca takımlar sabit.
- İzleyiciler: lobide "Spectators" bölümü; herkes "Watch" ile izleyiciye geçebilir, host sürükleyerek
  taşıyabilir. Maç sırasında gelen herkes izleyici olarak girer ve maçı izler; maç bitince lobiden
  takıma geçer. Odada en fazla 12 kişi (6 oyuncu).
- Host maç sırasında sol üstteki "Stop match" ile (iki tık) maçı bitirir; herkes lobiye döner.
- Sohbet: lobide sol altta kayıt + yazı alanı; maçta Enter ile yazılır, yeni mesajlar birkaç saniye
  üst üste görünüp kaybolur. Odaya yeni gelen son 30 mesajı görür; kişi başı flood sınırı var.
- Maç bitince 6 sn sonra oda lobiye döner. Host çıkarsa host'luk sıradakine geçer; boş oda 2 dk yaşar.

## Ses ve efektler

- Ses: WebAudio ile kodla üretilir (dosya yok): vuruş, düdük, gol, ateş, isabet, kutu içeriğine göre
  efekt. M ile sessiz.
- Parçacıklar (yalnızca istemci, sabit havuz ≤ 900): vuruş kıvılcımı, top izi, koşu tozu, namlu
  alevi, isabet kırıkları, mayın patlaması + duman + ekran sarsıntısı, buz kırıkları, gol konfetisi,
  kutu kıymıkları, hız/power/donma/yavaşlama izleri.
- Olaylar (`events.ts`) tahmin edilen durum karelerinin farkından çıkar; geri sarma aynı tick'leri
  tekrar oynattığı için tick damgası / artan id ile tekrar çalmaz.

## Ağ modeli (Godot sürümündeki "client'ta top geç/kötü geliyor" sorununun çözümü)

- Sunucu otoriter, 60 Hz sim, 30 Hz snapshot (tam durum, JSON, sayılar 1/1000'e yuvarlanır).
- İstemci her tick kendi girdisini sıraya koyar, gönderir **ve tüm dünyayı (top dahil) hemen
  kendisi simüle eder**. Diğer oyuncular son bilinen girdilerini tekrarlar; botlar deterministik.
- Snapshot gelince: o duruma geri sar → sunucunun onayladığı (`ack`) girdileri at → kalanları yeniden
  simüle et. Eski ve yeni tahmin arasındaki fark görsel ofset olur ve ~50 ms'de söner (60 px üstü
  ışınlanma sayılır, yumuşatılmaz). Böylece kendi vuruşun top üzerinde anında görünür.
- Sunucu her oyuncu için tick başına bir girdi tüketir; kuyruk 8'i aşarsa 3'e kırpılır (gecikme
  birikmesin). Girdi gelmezse son girdi en fazla 18 tick (~300 ms, Wi-Fi takılması) tekrarlanır;
  daha uzun sessizlikte tuşlar bırakılmış sayılır, geç gelen eski girdi onları yeniden kilitlemez.
- Bağlantı canlılığı: sunucu 5 sn'de bir ping atar, 2 cevapsızda bağlantıyı kapatır; istemci 6 sn hiçbir
  şey duymazsa yeniden bağlanır. Aynı sekme (oturum anahtarı) yeni bağlantıyla gelirse eski bağlantı
  hâlâ açık görünse de yeri devralır; eskisi 4011 ile kapanır ("başka sekmede açık").
- Sim yalnızca `+ - * / sqrt` kullanır (trig yok) → motorlar arası aynı sonuç.

## Yayın

- İstanbul'da tek bir VPS (Türkiye'den ~20 ms). Docker Compose: oyun + Caddy (otomatik HTTPS),
  domain `playcrateball.com`. Cloudflare proxy kullanılmıyor (Türkiye'den Amsterdam'a dolaşıyordu).
- Durum tamamen bellekte (veritabanı yok); yayın açık odaları siler, `pnpm deploy` maç bitene kadar
  bekler.
- Telemetri: istemci 2 sn'lik özet + R ile işaretli rapor; sunucu oda başına girdisiz tick ve tick süresi.

## Fikir havuzu

Penaltı/serbest vuruş yok; müzik; mobil kontroller; bot zorluk seviyesi;
tekrar (replay) ve F9 hata klasörü; snapshot'ları ikili/delta kodlama.
