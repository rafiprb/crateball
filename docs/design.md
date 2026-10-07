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
  - FW (orta çizginin 80 px ilerisinden): en hızlı, %25 sert şut; direğin az dışına giden ya da direğe
    değecek şut, top direğe değmeden geçecek şekilde içeri kıvrılır (en fazla ~20°; yakından çok dik açılı
    şut kıvrılmaz). Nişan oku yalnızca top direğe değmeden girecekse yeşil yanar.
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
- **Beach:** kumdan saha, çizgiler kuma kazınmış gibi; deniz üst kenardan iki koy halinde girer (kaleler,
  ceza sahaları, santra kuru; kutular suya düşmez). Su yalnızca görünüm: herkes kumdaki gibi hareket eder.
  Suda oyuncu simitle yüzer (hafif sallantı, yüzey gerilmesi, halkalar, damlalar), top deniz topu olur.
  4 lastik ördek sim varlığı: dolaşır, oyunculardan kaçar, top onlardan seker (ağır lastik oyuncak), oyuncu
  iter. Çarpınca "quack", sert çarpmada "QUACK!" ve tüy; ördekler birbirine çarpınca ses yok.
- Sesler: yağmur/volkan/rüzgâr/deniz uğultusu, ördek quack'ı, birikintide şıpırtı, lavda cızırtı, patlama öncesi
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
- Maç bitince 2 sn sonra oda lobiye döner (sonuç ekranı lobinin üstünde kalır, aşağıda). Host çıkarsa
  host'luk sıradakine geçer; boş oda 2 dk yaşar.

## Maç sonu ekranı

- Son düdükte herkesin önüne sonuç ekranı gelir: arka plan kazananın renginde, başlıkta "RED WINS!" ve
  skor, altında önce Red sonra Blue kartı, her kartta o takımın oyuncuları. Kendi satırın sarımsı, MVP'nin
  adının yanında "MVP" rozeti.
- Ekran 30 sn açık kalır (`MATCH.resultsShow`), "Back to lobby" ya da Esc ile kapanır. Oda arkada 2 sn
  sonra lobiye dönmüş olur: isteyen hemen lobiye geçer, isteyen okumaya devam eder. Host bu arada yeni
  maçı başlatırsa ekran herkeste kapanır.
- Sütunlar (oyuncu başına, yalnızca bu maç; `Player.stats`, sayan yer `game.ts`):
  - Goals: atılan gol (kendi kalesine atılan sayılmaz).
  - Touches: senin dokunuşun / maçtaki toplam dokunuş. Vuruş her zaman bir dokunuş; temas ise top son
    başkasındaysa ya da 0,5 sn'dir topa değmiyorsan yeni dokunuş (top sürmek tek dokunuş).
  - Shots: şut / isabetli şut. Pas yardımıyla takım arkadaşına bükülmeyen ve topu kendi hâlinde rakip kale
    çizgisine ortadan 140 px içinde ulaştıracak vuruş şuttur (topun gidebileceği yol: hız / (1 − sönüm));
    direklerin arasına gidiyorsa isabetli. Her gol isabetli şut sayılır (sürerek ya da direkten giren de).
  - Saves: yalnızca kaleci (mevkiler açıkken); kendi kalesine giden topa yeni dokunuş. Diğer herkes 0.
  - Crates: açılan iyi / kötü kutu (kötü: mine, ice, dizzy).
  - Damage: rakibe verilen hasar (mermi, roket; canı kadar, fazlası sayılmaz) / kalkanın yuttuğu hasar.
  - Deaths: ölüm.
  - Top istatistikleri (dokunuş, şut, kurtarış) yalnızca top oyundayken sayılır, gol sonrası duraklamada değil.
- MVP = gol + verilen hasar + kurtarış − ölüm (botlar dahil). Eşitlikte kazanan takımdan olan, sonra çok
  dokunan, sonra listede önce gelen.
- Ağ: istatistikler oyun durumunun parçası; delta snapshot'larda yalnızca değişen sayılar gider. Ekran, son
  düdükten sonraki ilk snapshot'taki sunucu sayılarını gösterir. Tasarım denemesi için dev'de
  `window.__game.cmd('results')` (ya da `'blue'`) uydurma bir maç sonu açar.

## Ses ve efektler

- Ses: WebAudio ile kodla üretilir (dosya yok): vuruş, düdük, gol, ateş, isabet, kutu içeriğine göre
  efekt. M ile sessiz.
- Parçacıklar (yalnızca istemci, sabit havuz ≤ 900): vuruş kıvılcımı, top izi, koşu tozu, namlu
  alevi, isabet kırıkları, mayın patlaması + duman + ekran sarsıntısı, buz kırıkları, gol konfetisi,
  kutu kıymıkları, hız/power/donma/yavaşlama izleri.
- Olaylar (`events.ts`) tahmin edilen durum karelerinin farkından çıkar; geri sarma aynı tick'leri
  tekrar oynattığı için tick damgası / artan id ile tekrar çalmaz.

## Ağ modeli (Godot sürümündeki "client'ta top geç/kötü geliyor" sorununun çözümü)

- Sunucu otoriter, 60 Hz sim, 30 Hz snapshot. Snapshot'lar binary (protocol 13, `packages/protocol/src/snap.ts`):
  genelde bir öncekine göre yalnızca değişenler (delta), yeni bağlanana ve en az 5 sn'de bir tam durum (key frame).
  Codec şemasız: sim'e alan eklemek codec değişikliği istemez. Sayılar 1/100.000 hassasiyetle taşınır ve sim
  durumu her adımdan sonra aynı hassasiyete yuvarlar (`canon.ts`): sunucunun devam ettiği durum istemcinin
  aldığıyla bit bit aynıdır, yuvarlama farkından düzeltme doğmaz. Oyuncu başına ~800 kbit/s yerine ~50 kbit/s.
- İstemci her tick kendi girdisini sıraya koyar, gönderir **ve tüm dünyayı (top dahil) hemen
  kendisi simüle eder**. Diğer oyuncular son bilinen girdilerini tekrarlar; botlar deterministik.
- Snapshot gelince: o duruma geri sar → sunucunun onayladığı (`ack`) girdileri at → kalanları yeniden
  simüle et. Eski ve yeni tahmin arasındaki fark görsel ofset olur ve söner: kendi oyuncun ~50 ms, top
  yanındayken ~90 ms, uzaktayken ~200 ms yarı ömür (kendi dokunuşun keskin, başkasının vuruşu kayarak).
  Ofset son çizilen karedeki ara noktaya göre hesaplanır, yani düzeltme anında çizilen top yerinden
  oynamaz (vuruşla hız değişse bile). Tek seferde 80 px (top için 250 px) üstü ışınlanma sayılır.
  Böylece kendi vuruşun top üzerinde anında görünür.
- Bir düzeltmenin boyu, tahminin sunucunun ne kadar önünde olduğuyla (bekleyen girdi ≈ RTT + kuyruk) ve
  bunu ne kadar geç öğrendiğimizle büyür. Başkasının vuruşunun bize zamanında ulaşması için:
  - **Girdi aktarımı (`ri`)**: sunucu bir oyuncunun tuş değişikliğini geldiği anda, uygulayacağı tick'le
    (`tick + kuyruktaki yeri`) diğerlerine yollar. Alıcı her oyuncu için `[tick, tuş]` listesi tutar; yeni
    gelen, kendi tick'i ve sonrasındakilerin yerini alır. Tahminimizin henüz gelmediği bir tick'se zamanı
    gelince oynanır (düzeltme yok); geçtiğimiz bir tick'se son snapshot'a geri sarılır (karede en çok bir
    kez). Snapshot her insan oyuncunun son adımda yürürlükteki girdisini de taşır (`h`, otoriter): alıcı
    listenin başını bununla değiştirir ve snapshot'tan sonra da oynar. Böylece başlama vuruşu `input`'u
    sıfırlasa da basılı tuş sürer, bütçe yüzünden aktarılmamış bir değişiklik de en geç sonraki
    snapshot'ta düzelir. İlk snapshot'tan önce gelen aktarımlar (yeni izleyici, yenilenen sayfa) saklanır.
    - Sunucu alıcıların listesinin aynısını (`sched`) tutar ve her tick uyguladığı girdiyi onunla
      karşılaştırır (henüz girdisi alınmamış oyuncu dahil); farklıysa (kuyruk kırpıldı ya da boşaldı, geç
      girdi, uzun sessizlikte tuş bırakıldı; yeniden bağlanmada eski liste unutulmaz)
      listeyi o tick'ten yeniden yollar. Kırpma/kopma listeyi hemen "kirli" yapar, ileriye duyurulmuş
      tuşlar (hayalet vuruş) en geç bir sonraki tick'te iptal edilir.
    - Kötüye kullanıma karşı: her geç sıra numarası bir kez düzeltir (eski numarayla sel işe yaramaz), geç
      girdi tick başına en çok bir kez aktarılır, oyuncu başına bütçe 20 mesaj/sn. İleri duyuruların
      iptali bütçe bitmişken de gider (duyurmak bütçe harcadığı için sınırlı).
    - Maç ortasında gelen izleyici ya da yeniden bağlanan için herkesin listesi yeniden yollanır.
      Yalnızca değişiklikler gider (~0,4 KB/s, snapshot'lar ~130 KB/s).
  - **Saat eşitleme (uyarlanır tampon)**: istemcinin kuyruktaki fazlası eskiden hiç erimiyordu (uzun bir
    Wi-Fi takılması `ack`'ı dondurur, kuyruk maç boyu 5-7'de kalır). Sunucu her tick'ten sonra "boşluğu"
    (o tick'in girdisi alındıktan sonra bekleyen girdi; eksikse eksi) ölçer; 2 sn boyunca en küçüğü 1'in
    üstündeyse snapshot'ta `lead` = fazlalık döner (o an bekleyen girdiyi aşmaz) ve istemci tick'ini en
    çok %3 uzatıp fazlalığı eritir (dünya zıplamaz, bir iki saniye %1-3 yavaş akar). Uzun sessizlikte
    ölçüm sıfırlanır; 250 ms snapshot gelmezse istemci bildirimi yok sayar. Boşluğu sık sık 0'a inen
    (seğiren) bağlantıya dokunulmaz. İstemci hiç hızlandırılmaz: ölçümde seğiren bağlantıya derin tampon
    vermek sahibinin düzeltmelerini, kaçırılan tick'lerden daha çok büyüttü.
- Sunucu her oyuncu için tick başına bir girdi tüketir; kuyruk 10'u aşarsa 4'e kırpılır (gecikme
  birikmesin). Girdi gelmezse son girdi en fazla 18 tick (~300 ms, Wi-Fi takılması) tekrarlanır;
  daha uzun sessizlikte tuşlar bırakılmış sayılır, geç gelen eski girdi onları yeniden kilitlemez.
- Ölçüm: `tests/netsim` gerçek `rooms.ts` + dört gerçek tahminciyi sanal saatle, modellenmiş bağlantılarla
  oynatır (`pnpm netsim 300 6`). 6 tohum × 5 dk; önce → sonra:

  | Ölçü | steady20 | spiky20 | far100 | bursty |
  |---|---|---|---|---|
  | Bekleyen girdi medyanı | 8,7 → 3 | 5 → 2 | 8,2 → 7,5 | 2,3 → 2,3 |
  | Top düzeltmesi, 2 sn penceresi en büyüğü p95 (px) | 58 → 21 | 43 → 17 | 60 → 44 | 27 → 17 |
  | Çizilen top − o anki gerçek top, p95 (px) | 37 → 13 | 16 → 9 | 20 → 19 | 8,8 → 7,7 |
  | Tahmin hatası (aynı tick'teki gerçeğe), p95 (px) | 24 → 4,9 | 20 → 5,2 | 29 → 21 | 10 → 2,4 |
  | Kendi oyuncunun düzeltmesi p95 (px) | 28 → 12 | 9 → 4 | 12 → 7 | 8 → 3 |

  100 ms'lik istemcide çizilen topun o anki gerçeğe uzaklığı pek değişmez: orada hatayı ne kadar önde
  tahmin etmek zorunda olduğu belirler. Topun ters yöne kaymasını önleyen ayrı bir sönüm kuralı denendi,
  ölçülebilir fark yaratmadı (uzak topta sönüm zaten neredeyse hiç geri kaydırmıyor), alınmadı.
- Bağlantı canlılığı: sunucu 5 sn'de bir ping atar, 2 cevapsızda bağlantıyı kapatır; istemci 6 sn hiçbir
  şey duymazsa yeniden bağlanır. Aynı sekme (oturum anahtarı) yeni bağlantıyla gelirse eski bağlantı
  hâlâ açık görünse de yeri devralır; eskisi 4011 ile kapanır ("başka sekmede açık").
- Sim yalnızca `+ - * / sqrt` kullanır (trig yok) → motorlar arası aynı sonuç.
- Gizli bilgi: kutudan ne çıkacağı ortak `rng`'den çekilseydi her istemci (izleyici dahil) snapshot'tan bir
  sonraki ganimeti hesaplayıp kötü kutudan kaçabilirdi. Ganimet ayrı `lootRng`'den çekilir; sunucu onu her
  adımdan önce crypto ile yeniler ve snapshot'a koymaz. İstemcinin tahmini kutuyu açar (nötr `crate`
  patlaması, tahta sesi), eşyanın etkisi ve ismi sonraki snapshot'la gelir. Hava (yağmur gölleri, lav
  akıntıları, rüzgâr), kutuların çıkış yeri/zamanı ve saha sırası ortak `rng`'de kalır: herkes için aynı,
  açık tehlikeler; tahmin edilmeleri akıcı tahmin için gerekli, önceden bilinmeleri yalnızca birkaç
  saniyelik konum bilgisi verir.

## Yayın

- İstanbul'da tek bir VDS (ayrılmış vCPU; Türkiye'den ~20 ms). Paylaşımlı VPS'te CPU "steal" yüzünden
  tick'ler ara ara 40-70 ms takılıyordu; VDS'te 4 ms'lik uykunun en kötüsü ~2 ms. Docker Compose: oyun +
  Caddy (otomatik HTTPS), domain `playcrateball.com` (DNS GoDaddy'de, TTL 10 dk). Cloudflare proxy
  kullanılmıyor (Türkiye'den Amsterdam'a dolaşıyordu).
- Durum tamamen bellekte (veritabanı yok); yayın açık odaları siler. Deploy maç bitene kadar, lobide
  insan varken de en fazla 10 dk bekler.
- Yayın güvenliği: deploy anahtarı yalnızca `crateball-deploy` çalıştırabilir ve yüklenen arşiv yalnızca
  oyun imajının derleme bağlamıdır. Compose, Caddyfile, Dockerfile ve betiğin kendisi sunucuda root'a ait
  sabit dosyalardır (`/etc/crateball`, `/usr/local/bin/crateball-deploy`); onları yalnızca
  `scripts/install-deploy.sh` (sahibin SSH anahtarıyla) değiştirir. Çalınan bir deploy anahtarı en fazla
  aynı kısıtlı konteynere (salt okunur, yetkisiz, bellek/pid sınırlı) başka bir oyun derlemesi koyabilir.
  Sağlıksız yayın `crateball:previous` imajına döner.
- Süreçler (`packages/server/src/cluster.ts`): bir Node süreci tek çekirdekte koşar; prod'da 3 oyun süreci
  (`CRATEBALL_WORKERS`). Ana süreç (coordinator) sayfayı, `/health`, `/rooms`'u sunar, her WebSocket
  upgrade'ini kabul kontrolünden geçirir ve TCP soketini odanın sürecine devreder; sonrasında oyun trafiği
  ana süreçten geçmez. Oda kodunun ilk harfi süreci belirler: `/ws?room=KOD` doğrudan oraya, menü en az
  soketi olan sürece gider ve oda o sürecin kod payından kurulur. Başka süreçteki odaya katılma `moved`
  cevabı alır, istemci `?room=` ile yeniden bağlanır. Yeniden bağlanma anahtarları tüm süreçlerin bildiği
  bir sırla MAC'lidir. Süreçler sayılarını saniyede iki kez bildirir; sınırlar, `/health` ve `/rooms`
  toplamdan. Düşen süreç 1 sn sonra yeniden başlar (odaları gider). Dev ve testlerde 0: tek süreç.
- Caddy oyuna Unix soketinden bağlanır (`/run/crateball/game.sock`, iki konteynerin paylaştığı volume):
  yük testinde yük bayttan değil mesaj sayısından geliyordu (120 oyuncuda saniyede ~12.000 mesaj); her mesajın
  konteyner ağından (veth, NAT) ikinci kez geçmesi kesme ve Caddy yükü demekti. TCP 8080 sağlık kontrolü ve
  Caddy'nin yedeği olarak kalır (soket yoksa, örneğin geri dönülen eski imajda, Caddy TCP'ye düşer).
- Telemetri: istemci 2 sn'lik özet + R ile işaretli rapor; sunucu oda başına girdisiz tick ve tick süresi;
  5 sn'de bir `sunucu istatistik` (tick süresi, event loop gecikmesi, en yüklü sürecin ve toplam CPU,
  bellek, trafik).

## Güvenlik ve sınırlar (`packages/server/src/ws.ts` `LIMITS`, `rooms.ts`)

- Sınırlar ofise göre gevşek: tek genel IP'nin (NAT) arkasında ~30 kişi, 4-5 oda hiçbir sınıra
  takılmamalı. Adres başına: 96 açık bağlantı, 120'lik patlama + saniyede 2 yeni bağlantı, dakikada 30 oda
  kurma, en fazla 20 oda. IP ile yasaklama yok; önek (prefix) bazlı kısıtlama yok.
- Sunucu çapında (tüm süreçler, env ile: `CRATEBALL_MAX_ROOMS/PLAYERS/SOCKETS`): varsayılan 100 oda, 600 kişi
  (oyuncu + izleyici), 1000 soket (lobi gezenler dahil). Prod varsayılanı yük testinden (2026-10-08):
  90 kişi, 24 oda, 300 soket (`config.ts` `DEFAULT_CAPS`). Yük testi modu (`scripts/loadtest-mode.sh`)
  sınırları en fazla 30 dk kaldırır. Dolunca "Servers are full" ekranı, 15 sn'de bir yeniden dener. Adres başına sınırlar
  ve soket sayısı ana süreçte (tüm upgrade'leri o görür); mesaj, oda kurma ve kod deneme bütçeleri her
  oyun sürecinde ayrı tutulur.
- Kabul (upgrade'den önce): prod'da tarayıcı Origin'i yalnızca `playcrateball.com` (masaüstü uygulaması da
  bu siteyi yükler; Origin'siz istemciler geçer, yerel prod denemesi için `CRATEBALL_ORIGINS`), dev'de
  localhost. Dolu sunucu 503, çok hızlı bağlanan adres 429.
- Mesajlar ayrıştırılmadan önce sayılır: bağlantı başına mesaj ve bayt bütçesi, adres başına bayt bütçesi
  (yeniden bağlanınca sıfırlanmaz), türe göre boyut sınırı (rapor 8 KB, gerisi 2 KB). Yerel WebSocket
  ping'lerine sunucu kendisi, bütçeyle cevap verir (`autoPong: false`); kalp atışı rastgele bir yük taşır,
  yalnızca onu taşıyan pong sayılır. 90 sn tam mesaj göndermeyen (yarım/parçalı mesajda kalan) soket kapanır.
- Log: istemcinin tetiklediği her satır sunucu çapında türüne göre bütçeli (`log-budget.ts`): yaşam döngüsü
  ve raporlar (bağlantı, oda, maç, atma, R) için ayrılmış 40 satır/sn; `istemci istatistik` 60 satır/sn
  (~120 oyuncuya kadar hepsi yazılır, üstünde örneklenir); uyarılar 20 satır/sn. Biri diğerini aç
  bırakmaz; aşanlar türüne göre sayılıp dakikada bir özetlenir. Bozuk mesaj bağlantı başına ilk ve her
  100'üncü; bozuk HTTP istek hedefi 400 alır; istatistik/rapor yalnızca odadakilerden.
- Kimlik: yeniden bağlanma anahtarını sunucu verir (`welcome.token`); istemcinin uydurduğu anahtar yok
  sayılır. Bir anahtarın tek canlı bağlantısı olur (lobide de: aynı anahtarla gelen yeni bağlantı eskisinin yerini
  aynı oyuncu olarak alır, eskisi 4011 ile kapanır). Odada/bağlı olanların ve süren bir atma kaydındakilerin
  anahtarı hiç unutulmaz; yalnızca geri
  kalan geçmiş en fazla 50.000 ile sınırlı. Atma kaydı oda başına en fazla 64, 30 dk sürer. Yeni anonim kimlik her zaman alınabildiği için
  oda çapında katılma (12'lik patlama, 5 sn'de bir) ve sohbet (15'lik patlama, saniyede 2) bütçesi var.
- Özel oda: 4 harfli kod kriptografik rastgele; yanlış kod denemesi adres başına dakikada 60, sunucu
  çapında dakikada 300. Bütçe dolunca yalnızca son dakikada ıskalamış adresler bekler (doğru kodla da: kod
  geçerliliği sızmaz), hiç ıskalamamış ofis kullanıcısı etkilenmez.
- Devralınan (aynı sekme yeniden bağlandı) ya da kapanmakta olan soketten gelen mesaj işlenmez.
- Otomasyon (#13): tam dünya tahmini bot yazmayı kolaylaştırır; sunucu tarafında vuruş aralığı sınırı
  eklenmedi (oyun hissini değiştirir, faydası belirsiz). Oyun kuralları zaten tamamen sunucuda.

## Fikir havuzu

Penaltı/serbest vuruş yok; müzik; mobil kontroller; bot zorluk seviyesi;
tekrar (replay) ve F9 hata klasörü; snapshot'ları ikili/delta kodlama.
