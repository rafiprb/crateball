# Crateball — tasarım

Tarayıcıda linkle açılan 1–3 v 1–3 arcade futbol. Rastgele yerlerde kutular düşer;
oyuncu kutuya değince açılır.

## Kurallar (sabitler: `packages/sim/src/content/rules.ts`)

- Saha 840×400 px, 60 tick/sn. Fizik: daire çarpışmaları, sönümleme, vuruş tuşu basılıyken
  yavaşlama, tuşa her basışta bir vuruş.
- Oyuncular kenar çizgilerinin 40 px, kale çizgilerinin 70 px dışına çıkabilir: kalenin (34 px derin) arkasından geçilebilir.
- Maç 3 dk, 5 gole kadar; süre bittiğinde berabere ise altın gol. "No time limit" seçilirse süre yok: maç yalnızca
  gol limitiyle biter, saat oynanan süreyi ileri sayar.
- Can 3; ölünce 3 sn sonra orta çizginin bir ucunda, kendi yarısında doğar: üst yarıda öldüyse alt uçta, alt yarıda öldüyse üst uçta. Her santrada (gol sonrası dahil) herkesin canı dolar, eşyalar ve kutular silinir.
- Kutu payları host'un elinde: lobide her eşyaya 0–100 kaydırıcı, toplam 100'ü geçemez (birini kısınca
  boşa çıkan pay havuza düşer, diğeri oradan artar; boşta kalan maçta orantılı dağılır). Hazır ayarlar:
  Default / Friendly / Mean / Guns only. Maç başlarken ayarlar loglanır ('maç başladı'), hangi
  karışımların seçildiği oradan sayılır.
- Varsayılan kutu ağırlıkları (100 üzerinden; üç kutudan ikisi işe yarar: iyiler 62, kötüler 38): Mine 14, Ice 14,
  Dizzy 10 | Gun 13, Speed 10, Shield 8, Power kick 12, Teleport 12, Bazooka 7.
- **Dizzy** (kötü): 4 sn yön tuşları ters çalışır; kafadan kabarcıklar çıkar. Santrada ve ölünce geçer.
- **Shield** süresiz: gol olana ya da ilk kötü şey gelene kadar kalır ve onu tek seferlik engeller (mermi,
  roket, patlama, mayın, buz, sarhoş). Engellediğinde "BLOCKED!", kırılan cam efekti ve pat-çatır cam kırılma sesi.
- Kutu içerikleri: **Gun** (3 mermi, yeni silah 3’e doldurur; otomatik nişan: en yakın, önü açık rakip; hedef alınana kırmızı uyarı; 3 isabet öldürür, topa da çarpar), **Mine** (patlar:
  açana 1 hasar + 4 sn yavaşlama, çevredekileri ve topu iter), **Ice** (2.5 sn donma), **Speed**,
  **Shield** (bir hasarı emer), **Power kick** (elde tutulur; E/F/Shift basılıyken top menzile girince 2.2× vuruş,
  o vuruşta harcanır; Space normal vuruş kalır ve gücü harcamaz), **Teleport** (elde tutulur; E/F/Shift
  ile o an basılan yön tuşlarının yönüne sabit 150 px sıçratır, tuşa basılmıyorsa son hareket yönüne;
  hız korunur, saha sınırında durur; donmuşken kullanılamaz, ölünce/santrada kaybolur), **Bazooka** (en nadir
  kutu; tek roket; tuşla yön verilmez, menzildeki en yakın rakibe kilitlenir (arada top ya da takım
  arkadaşı olsa da), hedefe kırmızı uyarı düşer; roket hedefi takip eder ama sınırlı döner, son anda yana
  kaçan kurtulabilir; isabet 3 can götürür yani öldürür, kalkan bir kez durdurur; toptan ve takım
  arkadaşlarından geçer).
- Elde tek eşya: Gun, Teleport, Bazooka ve Power kick aynı tuşu (E/F/Shift) kullanır, yeni gelen eskisinin
  yerini alır. Skorun altındaki sarı şerit eldeki eşyayı ve tuşu yazar. Silah tuş basılıyken ateşler; ışınlanma
  ve bazuka yeni bir basış ister. Bazukalı bot kilitlenince ateşler, güçlü şutlu bot vuruşunu bu tuşla atar.
  Botlar gitmek istedikleri yere uzak kalınca (200 px+) o yöne sıçrar.
- Mevkiler (herkes topa koşmasın diye; bonus yalnızca kendi bölgesinde):
  - GK (kale çizgisinden 140 px): sert gelen topu tutar (top hızının %20'si kalır, ayağının dibine düşer), çevik
    (1,5× ivme ve fren). Ceza sahasında biraz büyük (r 19).
  - DF (kendi kalesinden 340 px): ağır; hızla rakibe çarpınca omuz atar (ekstra itiş + 0,6 sn yarı hız), sonra
    1,5 sn bekleme.
  - MF (sahanın ortadaki %60'ı): uzun menzil, sert pas, ±15° pas yardımı, sert gelen topu yumuşak karşılar (%45).
  - FW (orta çizginin 80 px ilerisinden): en hızlı, %25 sert şut; direğin az dışına giden şut içeri kıvrılır.
  - Tutma / yumuşak karşılama sadece sert gelen topta (top ve çarpma hızı ≥ 2 px/tik): yavaş dokunuş, top
    sürme ve topun etrafında dönme normal kalır, yani kaleci tutup çevirip pas atabilir.
  - Gerçek mevkiler takımda tek kişilik: bir insan takım arkadaşının mevkisi alınamaz (lobide düğmesi
    kapalı), botunki alınır (bot boşta kalan bir mevkiye geçer). "No role" (pasifsiz) herkese açık.
    Mevki yalnızca lobide seçilir; maç başlayınca kilitlenir (sunucu lobi dışındaki değişikliği yok sayar).
  - Host lobide "Positions" kutusunu kapatırsa kimse pasif almaz (mevki etiketleri ve seçici gizlenir).
- Pas: vuruş yönü bir takım arkadaşına ±6° (orta saha kendi bölgesinde ±15°) yakınsa top ona doğru
  bükülür ve koşusunun önüne atılır; kale ağzına giden şut bükülmez. Vuruş tuşu basılı değilken
  topa değmek "hafif dokunuş"tur (top az seker, kontrol kolay). Kendi oyuncunun topa yakınken
  vuruş yönünü gösteren ok çizilir; orta sahada pas yardımı devredeyse sarı olur ve alıcıyı halkayla gösterir,
  forvet bölgesindeyken şut kaleyi tutuyorsa (kıvrılanlar dahil) yeşil olur ve kale çizgisinde gideceği yeri
  işaretler. Kaleci sert topu tutunca herkes "SAVE!" görür ve duyar.
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
- Maçta yazılan mesaj ayrıca ~4,5 sn yazanın üstünde konuşma balonunda görünür (en fazla üç satır).
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

- İstanbul'da tek bir VDS (ayrılmış vCPU; Türkiye'den ~20 ms). Paylaşımlı VPS'te CPU "steal" yüzünden
  tick'ler ara ara 40-70 ms takılıyordu; VDS'te 4 ms'lik uykunun en kötüsü ~2 ms. Docker Compose: oyun +
  Caddy (otomatik HTTPS), domain `playcrateball.com` (DNS GoDaddy'de, TTL 10 dk). Cloudflare proxy
  kullanılmıyor (Türkiye'den Amsterdam'a dolaşıyordu).
- Durum tamamen bellekte (veritabanı yok); yayın açık odaları siler. Deploy maç bitene kadar, lobide
  insan varken de en fazla 10 dk bekler.
- Telemetri: istemci 2 sn'lik özet + R ile işaretli rapor; sunucu oda başına girdisiz tick ve tick süresi.

## Fikir havuzu

Penaltı/serbest vuruş yok; müzik; mobil kontroller; bot zorluk seviyesi;
tekrar (replay) ve F9 hata klasörü; snapshot'ları ikili/delta kodlama.
