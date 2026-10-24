// Minimal i18n: English source strings are the keys; other languages map them to translations.
// Works in the browser (window.I18N) and in Node (module.exports, English only).
//
// Markup:  <span data-i18n>English text</span>            → text content is translated
//          <input placeholder="…" data-i18n-attr="placeholder,title">  → listed attributes are translated
// Code:    I18N.t('Sent {n} messages', { n: 5 })
//          I18N.msg({ key, p, text } | string)            → translates messages coming from the backend
//
// To add a language: add a dictionary to DICTS, an entry to LOCALES and an <option> to the language selects.
// `node tools/i18n-keys.js` lists strings that are missing from the Turkish dictionary.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(null);
  else root.I18N = factory(root);
})(typeof self !== 'undefined' ? self : this, function (win) {
  // Technical terms that stay the same in every language
  const SAME = ['p50', 'p95', 'p99', 'CPS', 'RPS', 'OK', 'ASR', 'RTP', 'OPTIONS', '503', 'PDD p50', 'PDD p95', 'PDD p99', '100 Trying p95', '503 Service Unavailable'];

  const TR = {
    // ---- General ----
    'Server': 'Sunucu', 'Save': 'Kaydet', 'Delete': 'Sil', 'Cancel': 'İptal', 'Rename': 'Ad', 'Refresh': 'Yenile', 'Stop': 'Durdur',
    'Export': 'Dışa aktar', 'Clear': 'Temizle', 'Yes': 'Evet', 'No': 'Hayır', 'Log out': 'Çıkış', 'Date': 'Tarih', 'Name': 'Ad', 'Type': 'Tür',
    'Time': 'Saat', 'Status': 'Durum', 'Result': 'Sonuç', 'Issues': 'Sorun', 'Target': 'Hedef', 'target': 'hedef', 'Capacity': 'Kapasite',
    'Passed': 'Geçti', 'Failed': 'Başarısız', 'none': 'yok', 'step': 'basamak', 'Password': 'Şifre', 'Advanced': 'Gelişmiş',
    'Connect': 'Bağlan', 'Disconnect': 'Kes', 'Error': 'Hata', 'off': 'kapalı', 'Count': 'Adet', 'Duration': 'Süre', 'End': 'Sonlanma',
    'Codec': 'Codec', 'Notes': 'Notlar', 'Timing': 'Süreler', 'Events': 'Olaylar', 'Limit': 'Sınır', 'Measured': 'Ölçülen', 'Criterion': 'Ölçüt',
    // ---- Connection ----
    '— Profile —': '— Profil —', 'Save profile': 'Profili kaydet', 'Delete profile': 'Profili sil', 'Profile name': 'Profil adı', 'Delete "{name}"?': '"{name}" silinsin mi?',
    'SIP server, PBX or SBC address. All requests are sent here (outbound proxy).': 'SIP sunucusu, PBX veya SBC adresi. Tüm istekler buraya gönderilir (outbound proxy).',
    'Domain': 'Domain', 'Domain used in SIP URIs (From, To, Request-URI). Defaults to the host.': "SIP URI'lerinde (From, To, Request-URI) kullanılan domain. Boşsa host kullanılır.",
    '(host)': '(host)', '(auto)': '(otomatik)', '(username)': '(kullanıcı adı)', '(optional)': '(opsiyonel)',
    'Username / extension': 'Kullanıcı / dahili', 'Auth username': 'Auth kullanıcı adı', 'Digest auth username when it differs from the extension': 'Dahiliden farklıysa digest kimlik doğrulama kullanıcı adı',
    'Display name': 'Görünen ad', 'Local SIP port': 'Yerel SIP portu', '0 = any free port': '0 = herhangi bir boş port', 'RTP start port': 'RTP başlangıç portu',
    'First RTP port; 0 = any free port. Open this range on the firewall if the server sends media back.': 'İlk RTP portu; 0 = herhangi bir boş port. Sunucu medya gönderiyorsa bu aralığı firewall’da aç.',
    'Contact IP': 'Contact IP', 'IP written into Via, Contact and SDP. Leave empty to detect it; set the public IP behind NAT.': "Via, Contact ve SDP'ye yazılan IP. Boş bırakılırsa otomatik bulunur; NAT arkasında genel IP'yi yaz.",
    'Register expiry (s)': 'Register süresi (sn)', 'Response timeout (s)': 'Yanıt zaman aşımı (sn)', 'Transaction timeout (Timer B/F); 32 s in RFC 3261': "İşlem zaman aşımı (Timer B/F); RFC 3261'de 32 sn",
    'Retransmission base timer for UDP': 'UDP için yeniden gönderim temel zamanlayıcısı', 'Send OPTIONS': 'OPTIONS gönder',
    'disconnected': 'bağlı değil', 'connecting…': 'bağlanıyor…', 'connected': 'bağlı', 'error': 'hata', 'registered': 'kayıtlı',
    '{transport} · local {local}': '{transport} · yerel {local}', 'Host is empty': 'Host boş', 'Not connected': 'Bağlı değil',
    'The server closed the connection': 'Sunucu bağlantıyı kapattı', 'Could not resolve {host}: {msg}': '{host} çözümlenemedi: {msg}',
    'Connection {n}: connect timed out': 'Bağlantı {n}: bağlantı zaman aşımı', 'Connection {n}: {msg}': 'Bağlantı {n}: {msg}', 'Socket error: {msg}': 'Soket hatası: {msg}',
    'Local port {port} is already in use': 'Yerel port {port} kullanımda',
    'OPTIONS: no response (timeout)': 'OPTIONS: yanıt yok (zaman aşımı)', 'Lost connection to the server': 'Sunucu bağlantısı koptu',
    'Lost connection to the server, reconnecting…': 'Sunucu bağlantısı koptu, yeniden bağlanılıyor…',
    // ---- Registration ----
    'Registration': 'Kayıt (REGISTER)', 'Register': 'Kaydol', 'Unregister': 'Kaydı sil', 'Not registered': 'Kayıtlı değil', 'Registered': 'Kayıtlı',
    'Registering…': 'Kaydolunuyor…', 'Unregistering…': 'Kayıt siliniyor…', 'Registration failed': 'Kayıt başarısız', 'no response (timeout)': 'yanıt yok (zaman aşımı)',
    'Registered for {s} s (refreshed automatically)': '{s} sn için kayıtlı (otomatik yenilenir)', 'Username is empty': 'Kullanıcı adı boş',
    'Registration is optional for test calls: most PBXes authenticate each call with the username and password above.': "Test aramaları için kayıt şart değil: çoğu PBX her aramayı yukarıdaki kullanıcı adı ve şifreyle doğrular.",
    // ---- Single test ----
    'Single test': 'Tekil test', 'Load test': 'Yük testi', 'Reports': 'Raporlar', 'Destination': 'Aranan', 'Duration (s)': 'Süre (sn)',
    'Number or SIP URI. X = random digit; separate several with commas.': "Numara veya SIP URI. X = rastgele rakam; birden fazlası virgülle ayrılır.",
    '0 = until you hang up': '0 = sen kapatana kadar',
    'Send 20 ms G.711 packets and measure what comes back (loss, jitter; round trip on an echo extension)': '20 ms G.711 paketleri gönderir, geri geleni ölçer (kayıp, jitter; echo dahilisinde gidiş-dönüş)',
    'Call': 'Ara', 'Hang up': 'Kapat', 'Hang up all': 'Hepsini kapat', 'Calls': 'Aramalar', 'SIP log': 'SIP log', 'Showing one call': 'Tek arama gösteriliyor',
    'Show all': 'Tümünü göster', 'Hide OPTIONS': 'OPTIONS gizle', 'Answer ms': 'Cevap ms', 'Loss': 'Kayıp', 'Calling…': 'Aranıyor…',
    'Post-dial delay: INVITE → first 180/183 (or 200)': 'Çevir sesi gecikmesi (PDD): INVITE → ilk 180/183 (veya 200)',
    'Round trip of our own packets coming back from an echo extension': 'Echo dahilisinden geri dönen kendi paketlerimizin gidiş-dönüş süresi',
    'Click a call to see its SIP messages. Echo test extensions (Asterisk: Echo()) give the most complete media measurement.': "SIP mesajlarını görmek için bir aramaya tıkla. En eksiksiz medya ölçümünü echo test dahilileri (Asterisk: Echo()) verir.",
    'calling': 'aranıyor', 'trying': 'deneniyor', 'ringing': 'çalıyor', 'answered': 'cevaplandı', 'ended': 'bitti', 'terminating': 'kapatılıyor',
    'hung up (BYE)': 'kapatıldı (BYE)', 'hung up by the server': 'sunucu kapattı', 'failed': 'başarısız', 'no response': 'yanıt yok',
    'no answer (cancelled)': 'cevap yok (iptal edildi)', 'cancelled': 'iptal edildi', 'BYE failed': 'BYE başarısız', 'BYE: no response': 'BYE: yanıt yok',
    'CANCEL: no response': 'CANCEL: yanıt yok', 'Destination is empty': 'Aranan numara boş',
    // ---- Load test form ----
    'Scenario': 'Senaryo', 'What the test generates': 'Testin ürettiği trafik', 'Calls (INVITE)': 'Aramalar (INVITE)', 'Registrations (REGISTER)': 'Kayıtlar (REGISTER)',
    'Test name': 'Test adı', "Shown in the reports list, e.g. 'v2.3 — 500 CPS target'": "Raporlar listesinde görünür, ör. 'v2.3 — 500 CPS hedef'",
    'Destination (X = random digit)': 'Aranan (X = rastgele rakam)', 'Accounts (rotate)': 'Hesaplar (sırayla)', 'Accounts to register': 'Kaydedilecek hesaplar',
    'Accounts used in rotation, e.g. 1000-1499 or 1000,1001. Empty = the account from the Server section.': 'Sırayla kullanılan hesaplar, ör. 1000-1499 veya 1000,1001. Boş = Sunucu bölümündeki hesap.',
    'Password template': 'Şifre şablonu',
    'Password for each account; {user} is replaced with the username, e.g. pw{user}. Empty = the password from the Server section.': 'Her hesabın şifresi; {user} kullanıcı adıyla değişir, ör. pw{user}. Boş = Sunucu bölümündeki şifre.',
    'Target CPS': 'Hedef CPS', 'Target RPS': 'Hedef RPS', 'Test type': 'Test tipi', 'Constant — duration': 'Sabit — süre', 'Constant — count': 'Sabit — adet',
    'Step': 'Kademeli', 'Constant': 'Sabit', 'Step test': 'Kademeli test', 'Calls': 'Aramalar', 'Requests': 'İstek',
    'Step: climbs from the start rate to the target in steps; the best way to find the load at which latency starts': 'Kademeli: başlangıç hızından hedefe basamak basamak çıkar; gecikmenin hangi yükte başladığını bulmanın en iyi yolu',
    'Start rate': 'Başlangıç hızı', 'Rate of the first step': 'İlk basamağın hızı', 'Increment': 'Artış', 'Rate added at each step': 'Her basamakta eklenen hız',
    'Step (s)': 'Basamak (sn)', 'Duration of each step': 'Her basamağın süresi', 'Time to ramp up to the target rate': 'Hedef hıza kademeli çıkış süresi',
    'Max concurrent calls': 'Maks. eşzamanlı arama', 'Max requests in flight': 'Maks. bekleyen istek',
    'Calls: maximum simultaneous calls. Registrations / OPTIONS: maximum requests waiting for a response.': 'Aramalar: en fazla eşzamanlı arama. Kayıt / OPTIONS: yanıt bekleyen en fazla istek.',
    'Hold min (s)': 'Konuşma min (sn)', 'Hold max (s)': 'Konuşma maks (sn)',
    'Each answered call is held for a random time in this range, then hung up with BYE': 'Cevaplanan her arama bu aralıkta rastgele bir süre açık tutulur, sonra BYE ile kapatılır',
    'Max ring (s)': 'Maks. çalma (sn)', 'Calls ringing longer than this are cancelled and counted as unanswered': 'Bundan uzun çalan aramalar iptal edilir ve cevapsız sayılır',
    'Expiry (s)': 'Süre (Expires, sn)', 'Sockets / connections': 'Soket / bağlantı',
    'UDP: local sockets (ports). TCP: connections. Some servers spread load by source port.': 'UDP: yerel soket (port) sayısı. TCP: bağlantı sayısı. Bazı sunucular yükü kaynak porta göre dağıtır.',
    'Response limit (s)': 'Yanıt limiti (sn)', 'No final response within this time counts as a timeout': 'Bu süre içinde nihai yanıt gelmezse zaman aşımı sayılır',
    'RTP calls (max)': 'RTP’li arama (maks)', 'Media is sent on at most this many calls at the same time; the other calls carry signalling only': 'Medya aynı anda en fazla bu kadar aramada gönderilir; diğer aramalar yalnızca sinyalleşme taşır',
    'Send RTP (light)': 'RTP gönder (hafif)', "Send 20 ms G.711 packets on up to 'RTP calls' calls and measure loss, jitter and echo round trip": "'RTP’li arama' kadar aramada 20 ms G.711 paketleri gönderir; kayıp, jitter ve echo gidiş-dönüşü ölçer",
    'Slow down on 503': "503'te yavaşla", 'On 503 Service Unavailable, lower the rate and recover over 3 s (calls are not retried)': '503 Service Unavailable gelince hızı düşür, 3 sn içinde toparla (aramalar tekrar denenmez)',
    'Reuse nonce': "Nonce'u yeniden kullan",
    'Send credentials with the next request using the last nonce, saving a 401/407 round trip (like a phone re-registering). Off = every request is challenged.': 'Kimlik bilgisini son nonce ile bir sonraki isteğe ekler, 401/407 turunu atlar (yeniden kaydolan bir telefon gibi). Kapalı = her istek sorgulanır.',
    'Acceptance criteria': 'Kabul ölçütleri', 'PDD p95 ≤ (ms)': 'PDD p95 ≤ (ms)', 'PDD p99 ≤ (ms)': 'PDD p99 ≤ (ms)', 'Response p95 ≤ (ms)': 'Yanıt p95 ≤ (ms)', 'Response p99 ≤ (ms)': 'Yanıt p99 ≤ (ms)',
    'ASR ≥ %': 'ASR ≥ %', 'Failures ≤ %': 'Hata ≤ %', 'RTP loss ≤ %': 'RTP kaybı ≤ %', 'Min rate': 'Min. hız', 'Defaults to the target rate when empty': 'Boşsa hedef hız kullanılır',
    'Open report': 'Raporu aç', 'Open report · Passed': 'Raporu aç · Geçti', 'Open report · Failed': 'Raporu aç · Kaldı', 'Export CSV': 'CSV dışa aktar', 'Start test': 'Testi başlat',
    'Enter the server details on the left first.': 'Önce soldaki sunucu bilgilerini gir.', 'Enter a destination to call.': 'Aranacak numarayı gir.',
    'Enter the accounts to register (e.g. 1000-1499).': 'Kaydedilecek hesapları gir (ör. 1000-1499).', 'Enter the users to register': 'Kaydedilecek kullanıcıları gir',
    'At {rate} CPS with ~{hold} s calls you need about {need} concurrent calls, but the limit is {lim}. The target rate will not be reached. Start anyway?':
      '{rate} CPS ve ~{hold} sn’lik aramalar için yaklaşık {need} eşzamanlı arama gerekir ama sınır {lim}. Hedef hıza ulaşılamaz. Yine de başlatılsın mı?',
    '{n} steps · {from} → {to} {unit} · ~{min} min total': '{n} basamak · {from} → {to} {unit} · toplam ~{min} dk',
    'Starting…': 'Başlatılıyor…', 'Running': 'Çalışıyor', 'Test finished': 'Test bitti', 'Last test finished': 'Son test bitti', 'Done': 'Bitti',
    'Stopping new calls… (press again to hang up all active calls now)': 'Yeni aramalar durduruluyor… (aktif aramaların hepsini şimdi kapatmak için tekrar bas)',
    'Stopping… (press again to finish without waiting)': 'Durduruluyor… (beklemeden bitirmek için tekrar bas)',
    // ---- Load test view ----
    'Call attempts': 'Arama denemesi', 'REGISTER sent': 'Gönderilen REGISTER', 'OPTIONS sent': 'Gönderilen OPTIONS', 'Answered': 'Cevaplanan',
    'Answered (2xx)': 'Cevaplanan (2xx)', 'Active calls': 'Aktif aramalar', 'In flight': 'Bekleyen', 'PDD p50 / p95 / p99': 'PDD p50 / p95 / p99',
    'Response p50 / p95 / p99': 'Yanıt p50 / p95 / p99', 'Attempts': 'Deneme', 'Timeouts': 'Zaman aşımı', 'Retransmissions': 'Yeniden gönderim',
    'Requests sent again because no response came in time (UDP)': 'Zamanında yanıt gelmediği için tekrar gönderilen istekler (UDP)',
    'Answer-seizure ratio: answered / attempts': 'Cevaplanma oranı (ASR): cevaplanan / deneme', 'Completed · dropped': 'Tamamlanan · düşen',
    'Auth challenges': 'Kimlik sorgusu (401/407)', 'Average rate': 'Ortalama hız', 'RTP packets tx / rx': 'RTP paket gönderilen / alınan', 'RTP loss': 'RTP kaybı',
    'Jitter p50 / p95': 'Jitter p50 / p95', 'Echo RTT p50 / p95': 'Echo RTT p50 / p95', 'Round trip of our own packets from an echo extension': 'Echo dahilisinden dönen kendi paketlerimizin gidiş-dönüşü',
    'Calls per second': 'Saniyedeki arama', 'Requests per second': 'Saniyedeki istek', 'Setup latency (ms)': 'Kurulum gecikmesi (ms)', 'Response latency (ms)': 'Yanıt gecikmesi (ms)',
    'Media': 'Medya', 'Failure codes': 'Hata kodları', 'No failures': 'Hata yok', 'With RTP': 'RTP’li', 'Loss %': 'Kayıp %', 'Jitter ms': 'Jitter ms',
    'Echo RTT p95 ms': 'Echo RTT p95 ms', 'Sent': 'Gönderilen', 'peak {n}': 'tepe {n}', '{n} live': '{n} canlı', 'now {p}%': 'şu an %{p}',
    '{n} calls without audio': '{n} aramada ses yok', 'INVITE → 100 Trying': 'INVITE → 100 Trying', 'PDD (INVITE → 180/183)': 'PDD (INVITE → 180/183)',
    'INVITE → 200 OK': 'INVITE → 200 OK', 'BYE → 200 OK': 'BYE → 200 OK', 'REGISTER → 200 OK (with challenge)': 'REGISTER → 200 OK (sorgu dahil)', 'OPTIONS → response': 'OPTIONS → yanıt',
    'Connection details come from the Server section on the left. Calls use the extension to call: an echo test or IVR that answers automatically.': 'Bağlantı bilgileri soldaki Sunucu bölümünden alınır. Aramalar için otomatik cevaplayan bir dahili kullan: echo test veya IVR.',
    'SIP Tester load test': 'SIP Tester yük testi', 'Completed': 'Tamamlanan', 'Dropped': 'Düşen',
    // ---- Reports list ----
    'A report is saved automatically when each load test finishes. Click a row to open it.': 'Her yük testi bittiğinde rapor otomatik kaydedilir. Açmak için satıra tıkla.',
    'No reports yet.': 'Henüz rapor yok.', 'No reports yet. They appear here when a load test finishes.': 'Henüz rapor yok. Yük testi bitince burada görünür.',
    'Latency onset': 'Gecikme başlangıcı', 'Delete this report?': 'Bu rapor silinsin mi?', 'Registrations': 'Kayıtlar',
    // ---- Engine messages ----
    'A test is already running': 'Zaten çalışan bir test var', 'Opening the connection…': 'Bağlantı açılıyor…', 'Opening {n} connections…': '{n} bağlantı açılıyor…',
    '{transport} · local {ip} · test started': '{transport} · yerel {ip} · test başladı', 'Step {i}/{n}: {rate}/s': 'Basamak {i}/{n}: {rate}/sn',
    'Connection {n} closed by the server': 'Bağlantı {n} sunucu tarafından kapatıldı', 'First timeout (no final response)': 'İlk zaman aşımı (nihai yanıt yok)',
    'First 503 Service Unavailable (overload)': 'İlk 503 Service Unavailable (aşırı yük)', 'First {status}': 'İlk {status}',
    'First unanswered call (cancelled after {s} s of ringing)': 'İlk cevapsız arama ({s} sn çaldıktan sonra iptal edildi)',
    'First call hung up by the server before the hold time ended': 'Sunucunun konuşma süresi bitmeden kapattığı ilk arama',
    'No new calls; waiting for active calls to finish': 'Yeni arama yok; aktif aramaların bitmesi bekleniyor', 'Sending finished, waiting for responses': 'Gönderim bitti, yanıtlar bekleniyor',
    'Waiting for {n} active calls to finish…': '{n} aktif aramanın bitmesi bekleniyor…', 'Waiting for responses…': 'Yanıtlar bekleniyor…',
    'Hanging up {n} active calls': '{n} aktif arama kapatılıyor', 'Hanging up {n} active calls…': '{n} aktif arama kapatılıyor…',
    'Stopped while connecting': 'Bağlanırken durduruldu', 'The load engine process exited': 'Yük motoru süreci kapandı',
    // ---- Report ----
    'SIP Tester · Test report': 'SIP Tester · Test raporu', 'Download CSV': 'CSV indir', 'Download JSON': 'JSON indir', 'Save as PDF': 'PDF olarak kaydet',
    'Loading report…': 'Rapor yükleniyor…', 'Report not found': 'Rapor bulunamadı', 'It may have been deleted.': 'Silinmiş olabilir.',
    'Call load test': 'Arama yük testi', 'Registration load test': 'Kayıt yük testi', 'OPTIONS load test': 'OPTIONS yük testi',
    'PASSED': 'GEÇTİ', 'FAILED': 'KALDI', 'No criteria': 'Ölçüt yok', 'Findings': 'Bulgular', 'PDD': 'PDD', 'Response': 'Yanıt',
    'The server ran without a latency increase <b>up to {good} {unit}</b>; it saturated at the <b>{knee} {unit}</b> step.': 'Sunucu <b>{good} {unit}’e kadar</b> gecikme artışı olmadan çalıştı; <b>{knee} {unit}</b> basamağında doydu.',
    'The server ran without a latency increase <b>up to {good} {unit}</b>; latency rose at the <b>{knee} {unit}</b> step.': 'Sunucu <b>{good} {unit}’e kadar</b> gecikme artışı olmadan çalıştı; <b>{knee} {unit}</b> basamağında gecikme yükseldi.',
    'The server ran without a latency increase or saturation <b>up to {max} {unit}</b>, the highest load tested.': 'Sunucu test edilen en yüksek yük olan <b>{max} {unit}’e kadar</b> gecikme artışı ve doyma olmadan çalıştı.',
    'Target {target} {unit}; the server sustained at most <b>{cap} {unit}</b>': 'Hedef {target} {unit}; sunucu en fazla <b>{cap} {unit}</b> taşıyabildi',
    ', and latency started rising at <b>~{tps} {unit}</b>': ' ve gecikme <b>~{tps} {unit}</b> civarında yükselmeye başladı',
    'The server sustained the target <b>{tps} {unit}</b> without issues{dur}; {lat} p95 {p95} ms.': 'Sunucu hedef <b>{tps} {unit}</b> yükü sorunsuz taşıdı{dur}; {lat} p95 {p95} ms.',
    ' for {s} s': ' ({s} sn boyunca)', 'Peak capacity': 'Tepe kapasite', '{unit} · 10 s avg.': '{unit} · 10 sn ort.', 'Latency onset step': 'Gecikme başlangıç basamağı',
    'Latency onset load': 'Gecikme başlangıç yükü', 'Peak simultaneous calls': 'Tepe eşzamanlı arama', 'calls': 'arama', 'requests': 'istek', 'Sustained': 'Kararlı',
    '{unit} · steady state': '{unit} · kararlı durum', 'Baseline latency (p95)': 'Taban gecikme (p95)', 'ms · at low load': 'ms · düşük yükte',
    'Failure rate': 'Hata oranı', 'RTP loss · jitter p95': 'RTP kaybı · jitter p95', '{n} calls with media': '{n} medyalı arama', 'not measured': 'ölçülmedi',
    'Load: target vs. actual ({unit})': 'Yük: hedef ve gerçekleşen ({unit})',
    'Vertical lines: {steps}latency onset (yellow), saturation (red), connection drops.': 'Dikey çizgiler: {steps}gecikme başlangıcı (sarı), doyma (kırmızı), bağlantı kopmaları.',
    'step changes (thin), ': 'basamak geçişleri (ince), ', 'Setup latency: post-dial delay (INVITE → 180/183)': 'Kurulum gecikmesi: PDD (INVITE → 180/183)',
    'Response latency': 'Yanıt gecikmesi', 'Dotted line: baseline p95 at low load ({ms} ms).': 'Noktalı çizgi: düşük yükteki taban p95 ({ms} ms).',
    'Dashed red: acceptance limit ({ms} ms).': 'Kesikli kırmızı: kabul sınırı ({ms} ms).', 'Simultaneous calls': 'Eşzamanlı aramalar', 'Media quality': 'Medya kalitesi',
    'Measured on calls that send RTP. Echo round trip appears when the extension sends our packets back (echo test).': 'RTP gönderen aramalarda ölçülür. Echo gidiş-dönüşü, dahili paketlerimizi geri gönderdiğinde (echo test) görünür.',
    'Latency vs. load': 'Gecikme ve yük', 'Each dot is one second: rate on the x axis, p95 latency on the y axis. Where the curve bends is the load at which the server starts adding latency':
      'Her nokta bir saniye: x ekseninde hız, y ekseninde p95 gecikme. Eğrinin kırıldığı yer, sunucunun gecikme eklemeye başladığı yüktür',
    'Steps': 'Basamaklar', 'Active': 'Aktif', 'Retr.': 'Tekrar', 'Clean': 'Temiz', 'Latency up': 'Gecikme arttı', 'Saturated': 'Doydu', '503 / failures / retransmissions': '503 / hata / yeniden gönderim',
    'The first seconds of each step are excluded as settling time. A step counts as saturated when the successful rate is below 95% of its target.': "Her basamağın ilk saniyeleri oturma süresi olarak hesaba katılmaz. Başarılı hız hedefin %95'inin altındaysa basamak doymuş sayılır.",
    'Latency started rising (p95 {ms} ms)': 'Gecikme yükselmeye başladı (p95 {ms} ms)', 'Successful rate fell below the target': 'Başarılı hız hedefin altına düştü',
    'Counters': 'Sayaçlar', 'Call attempts (INVITE)': 'Arama denemesi (INVITE)', 'Answered (200 OK)': 'Cevaplanan (200 OK)', 'Successful (2xx)': 'Başarılı (2xx)',
    'Completed with BYE': 'BYE ile tamamlanan', 'Dropped by the server': 'Sunucunun düşürdüğü', 'Unanswered (cancelled)': 'Cevapsız (iptal)',
    'Auth challenges (401/407)': 'Kimlik sorguları (401/407)', 'INVITE → 100 Trying (p50/p95/p99/max)': 'INVITE → 100 Trying (p50/p95/p99/maks)', 'PDD (p50/p95/p99/max)': 'PDD (p50/p95/p99/maks)',
    'INVITE → 200 OK (p50/p95/p99/max)': 'INVITE → 200 OK (p50/p95/p99/maks)', 'BYE → 200 OK (p50/p95/p99/max)': 'BYE → 200 OK (p50/p95/p99/maks)', 'Response (p50/p95/p99/max)': 'Yanıt (p50/p95/p99/maks)',
    'RTP packets sent / received': 'RTP paket gönderilen / alınan', 'RTP lost / loss': 'RTP kayıp / oran', 'Jitter per call (p50/p95/p99/max)': 'Arama başına jitter (p50/p95/p99/maks)',
    'Echo round trip (p50/p95/p99/max)': 'Echo gidiş-dönüş (p50/p95/p99/maks)', 'Answered calls without audio': 'Sessiz cevaplanan aramalar', 'No events': 'Olay yok',
    'Test settings': 'Test ayarları', 'Step: {from} → {to} {unit}, {n} steps × {s} s': 'Kademeli: {from} → {to} {unit}, {n} basamak × {s} sn',
    'Constant: {tps} {unit}, {amount}': 'Sabit: {tps} {unit}, {amount}', 'Response limit': 'Yanıt limiti', 'Hold time': 'Konuşma süresi', 'Max ring': 'Maks. çalma',
    'on, up to {n} calls · {codec}': 'açık, en fazla {n} arama · {codec}', 'Expiry': 'Süre (Expires)', 'Accounts': 'Hesaplar',
    'Latency onset: p95 exceeding 2× the low-load baseline (at least +20 ms){crit} for 3 consecutive seconds. Saturation: the successful rate staying below 90% of the target for 3 seconds.':
      "Gecikme başlangıcı: p95'in 3 saniye üst üste düşük yükteki tabanın 2 katını (en az +20 ms){crit} aşması. Doyma: başarılı hızın 3 saniye boyunca hedefin %90'ının altında kalması.",
    ' or the acceptance limit': ' veya kabul sınırını', 'Latency onset · ~{tps} {unit}': 'Gecikme başlangıcı · ~{tps} {unit}', 'Saturation · {tps} {unit}': 'Doyma · {tps} {unit}',
    'log scale': 'log ölçek', 'Dropped / s': 'Düşen / sn', 'p95 (median)': 'p95 (medyan)', 'p99 (median)': 'p99 (medyan)', 'p95 per second': 'saniyelik p95', 'WARNING': 'UYARI', 'ISSUE': 'SORUN',
    // ---- Analysis ----
    'Nothing was sent during the test; there is no data to analyse.': 'Test boyunca hiçbir şey gönderilmedi; analiz edilecek veri yok.',
    'overload: the server answered 503 Service Unavailable': 'aşırı yük: sunucu 503 Service Unavailable döndü',
    'connection loss: some TCP connections were closed': 'bağlantı kaybı: bazı TCP bağlantıları kapandı',
    'the server stopped answering in time (timeouts and retransmissions)': 'sunucu zamanında yanıt vermeyi bıraktı (zaman aşımı ve yeniden gönderimler)',
    'the concurrency limit filled up because the server answered slowly': 'sunucu yavaş yanıt verdiği için eşzamanlılık sınırı doldu',
    'the server rejected requests with error responses': 'sunucu istekleri hata yanıtlarıyla reddetti',
    'the test machine could not send at the target rate (CPU or network)': 'test makinesi hedef hızda gönderemedi (CPU veya ağ)',
    'The server is clean up to {good} {unit}; it saturated at the {knee} {unit} step (successful {ok} {unit}).': 'Sunucu {good} {unit}’e kadar temiz; {knee} {unit} basamağında doydu (başarılı {ok} {unit}).',
    'The server is clean up to {good} {unit}; latency rose at the {knee} {unit} step (p95 {p95} ms, baseline {base} ms).': 'Sunucu {good} {unit}’e kadar temiz; {knee} {unit} basamağında gecikme yükseldi (p95 {p95} ms, taban {base} ms).',
    'All steps (up to {max} {unit}) passed without a latency increase or saturation.': 'Tüm basamaklar ({max} {unit}’e kadar) gecikme artışı veya doyma olmadan geçti.',
    'Post-dial delay': 'Çevir sesi gecikmesi (PDD)', 'Response time': 'Yanıt süresi',
    '{what} started rising at {time}, at about {tps} {unit}: p95 went from a {base} ms baseline to {p95} ms': "{what} {time}'de, yaklaşık {tps} {unit} yükte yükselmeye başladı: p95 {base} ms tabandan {p95} ms'ye çıktı",
    '(step {n})': '(basamak {n})', '{what} stayed at its baseline throughout the test (p95 ≈ {p95} ms).': '{what} test boyunca tabanda kaldı (p95 ≈ {p95} ms).',
    'At {time} the successful rate fell below the target ({ok} / {target} {unit}). Likely cause: {cause}.': "{time}'de başarılı hız hedefin altına düştü ({ok} / {target} {unit}). Olası neden: {cause}.",
    'The target rate was reached and held (best 10 s average {tps} {unit}).': 'Hedef hıza ulaşıldı ve korundu (en iyi 10 sn ortalaması {tps} {unit}).',
    'Latency grows over time under steady load: p95 rose ~{d} ms per minute ({from} → {to} ms). This may point to a growing queue or a resource leak.': 'Kararlı yükte gecikme zamanla artıyor: p95 dakikada ~{d} ms yükseldi ({from} → {to} ms). Büyüyen bir kuyruğa veya kaynak sızıntısına işaret edebilir.',
    'Latency stayed flat for {min} minutes under steady load.': 'Kararlı yükte gecikme {min} dakika boyunca sabit kaldı.',
    'ASR {asr}%: {ok} of {sent} call attempts were answered.': 'ASR %{asr}: {sent} arama denemesinin {ok} tanesi cevaplandı.',
    'The server held about {n} simultaneous calls at steady state (peak {max}).': 'Sunucu kararlı durumda yaklaşık {n} eşzamanlı aramayı taşıdı (tepe {max}).',
    '{n} answered calls were hung up by the server before their hold time ended (first at {time}).': "{n} cevaplanan arama konuşma süresi bitmeden sunucu tarafından kapatıldı (ilki {time}'de).",
    '{n} calls were not answered within {s} s and were cancelled.': '{n} arama {s} sn içinde cevaplanmadı ve iptal edildi.',
    '{n} BYE requests failed or got no response; those calls may stay open on the server.': '{n} BYE isteği başarısız oldu veya yanıt almadı; bu aramalar sunucuda açık kalmış olabilir.',
    'Media on {n} calls: {loss}% packet loss, jitter p95 {jit} ms.': '{n} aramada medya: %{loss} paket kaybı, jitter p95 {jit} ms.',
    'Echo round trip p95 {rtt} ms.': 'Echo gidiş-dönüş p95 {rtt} ms.',
    '{n} answered calls received no audio at all. Expected if the extension does not send media; otherwise check NAT, the firewall (RTP ports) or media relay capacity.': '{n} cevaplanan aramada hiç ses gelmedi. Dahili medya göndermiyorsa normal; değilse NAT, firewall (RTP portları) veya medya aktarma kapasitesini kontrol et.',
    'No RTP came back on any call. Use an echo or announcement extension to measure media.': 'Hiçbir aramada RTP geri gelmedi. Medyayı ölçmek için echo veya anons dahilisi kullan.',
    '{n} × 503 Service Unavailable received (first at {time}).': "{n} × 503 Service Unavailable alındı (ilki {time}'de).",
    '{n} requests got no final response (timeout).': '{n} istek nihai yanıt almadı (zaman aşımı).',
    '{n} retransmissions ({pct}% of requests): the server or network answered late or dropped packets.': '{n} yeniden gönderim (isteklerin %{pct}): sunucu veya ağ geç yanıt verdi ya da paket düşürdü.',
    '{n} connection(s) were closed during the test (first at {time}).': "Test sırasında {n} bağlantı kapandı (ilki {time}'de).",
    'Failure responses: {list}.': 'Hata yanıtları: {list}.', 'Authentication failed: check the username, password or password template.': 'Kimlik doğrulama başarısız: kullanıcı adını, şifreyi veya şifre şablonunu kontrol et.',
    'Sustained rate': 'Kararlı hız',
    'PBX routing delay started rising (p95 {ms} ms)': 'PBX yönlendirme gecikmesi yükselmeye başladı (p95 {ms} ms)',
    'The target rate was not reached (best 10 s average {tps} of {target} {unit}).': 'Hedef hıza ulaşılamadı (en iyi 10 sn ortalaması {tps} / {target} {unit}).',
    'Every call reached the vendor, so the {n} failures happened on the trunk side (vendor answers passed back by the PBX), not inside the PBX.': "Tüm aramalar vendor'a ulaştı; yani {n} hata PBX içinde değil, trunk tarafında oldu (vendor'ın yanıtı PBX üzerinden geri geldi).",
    'The failed calls never reached the vendor: the PBX itself rejected or lost them.': "Başarısız aramalar vendor'a hiç ulaşmadı: PBX'in kendisi reddetti veya kaybetti.",
    // ---- Vendor (built-in trunk) ----
    'Vendor (built-in trunk)': 'Vendor (dahili trunk)', 'Vendor': 'Vendor', 'Start': 'Başlat', 'Vendor stopped': 'Vendor durduruldu',
    'A fake carrier your PBX sends calls to over a trunk. It answers, echoes the audio back and can act slow or full on purpose. Used for end-to-end measurement.':
      "PBX'inin trunk üzerinden arama göndereceği sahte operatör. Aramaları cevaplar, sesi geri yansıtır ve istenirse yavaş ya da dolu bir operatör gibi davranır. Uçtan uca ölçüm için kullanılır.",
    'Listen on': 'Dinleme', 'This machine only (127.0.0.1)': 'Sadece bu makine (127.0.0.1)', 'Network (0.0.0.0)': 'Ağdan erişilebilir (0.0.0.0)',
    'UDP and TCP on the same port': 'Aynı portta UDP ve TCP', 'Ring after (ms)': 'Çalma (ms sonra)', 'Sends 180 Ringing after this delay': 'Bu gecikmeden sonra 180 Ringing gönderir',
    'Answer after (ms)': 'Cevap (ms sonra)', 'Sends 200 OK after this delay': 'Bu gecikmeden sonra 200 OK gönderir',
    'Hang up after (s)': 'Kapatma (sn sonra)', 'The vendor hangs up answered calls after this time (0 = the caller hangs up)': 'Vendor cevaplanan aramaları bu süreden sonra kapatır (0 = arayan kapatır)',
    'CPS limit': 'CPS sınırı', 'Above this rate new calls get 503 (0 = unlimited)': 'Bu hızın üstündeki yeni aramalara 503 döner (0 = sınırsız)',
    'Channel limit': 'Kanal sınırı', 'Calls beyond this many simultaneous calls get 503, like a full trunk (0 = unlimited)': 'Bu kadar eşzamanlı aramadan sonrakilere dolu bir trunk gibi 503 döner (0 = sınırsız)',
    'Processing capacity (CPS)': 'İşleme kapasitesi (CPS)',
    'Calls processed per second; the rest wait in a queue and the answer slows down (0 = unlimited). Simulates a slow carrier.': 'Saniyede işlenen arama; fazlası kuyrukta bekler ve cevap gecikir (0 = sınırsız). Yavaş bir operatörü taklit eder.',
    'Busy %': 'Meşgul %', 'Failure %': 'Hata %', 'Failure code': 'Hata kodu', 'Trunk username': 'Trunk kullanıcı adı', 'Trunk password': 'Trunk şifresi',
    'Leave empty to accept calls from any address without authentication (IP trunk)': 'Boş bırakılırsa her adresten gelen arama kimlik doğrulaması olmadan kabul edilir (IP trunk)',
    '(any)': '(herkes)', '(none)': '(yok)', 'Echo RTP': 'RTP echo', 'Send every RTP packet back (echo). Off = the vendor stays silent.': 'Her RTP paketini geri gönderir (echo). Kapalı = vendor sessiz kalır.',
    'Add this as a trunk / outbound route on your PBX:': "PBX'inde trunk / dış hat olarak tanımla:", 'No IP found': 'IP bulunamadı', 'this machine only': 'sadece bu makineden',
    'Auth: {user} / password': 'Kimlik: {user} / şifre', 'Auth: any username / password': 'Kimlik: herhangi bir kullanıcı / şifre', 'No authentication (IP trunk)': 'Kimlik doğrulama yok (IP trunk)',
    'Calls {ps}/s · active {act} (peak {max}) · answered {ans} · rejected {rej} · RTP {rtp} pkt/s': 'Arama {ps}/sn · aktif {act} (tepe {max}) · cevaplanan {ans} · reddedilen {rej} · RTP {rtp} pkt/sn',
    'queue {n}': 'kuyruk {n}', 'Port {port} is already in use': 'Port {port} kullanımda', 'No permission for port {port} (choose a port above 1024)': 'Port {port} için izin yok (1024 üstü bir port seç)',
    // ---- End-to-end ----
    'End-to-end via vendor': 'Vendor üzerinden uçtan uca', 'End-to-end': 'Uçtan uca',
    "The trailing X's of the destination carry a call number; the built-in vendor reads it back when your PBX routes the call to it. Measures PBX routing delay, calls that never reached the trunk and duplicates.":
      "Aranan numaranın sondaki X'leri bir arama numarası taşır; PBX aramayı dahili vendor'a yönlendirdiğinde vendor bunu okur. PBX yönlendirme gecikmesini, trunk'a hiç ulaşmayan aramaları ve çiftleri ölçer.",
    'End-to-end p95 ≤ (ms)': 'Uçtan uca p95 ≤ (ms)', 'Not reached ≤ %': 'Ulaşmayan ≤ %', 'Reached the vendor': "Vendor'a ulaşan", 'Not reached': 'Ulaşmayan', 'Duplicates': 'Çift',
    'Calls that never arrived at the vendor: rejected or lost inside the PBX (includes calls still in progress while the test runs)': "Vendor'a hiç gelmeyen aramalar: PBX içinde reddedilen veya kaybolanlar (test sürerken devam edenler de dahil)",
    'The same call arrived at the vendor more than once (PBX retry or failover)': "Aynı arama vendor'a birden fazla kez geldi (PBX yeniden deneme veya yedek hat)",
    'Routing delay p50 / p95 / p99': 'Yönlendirme gecikmesi p50 / p95 / p99',
    'INVITE sent by the client → INVITE received by the vendor: the time the PBX needs to route the call': "Client'ın gönderdiği INVITE → vendor'a gelen INVITE: PBX'in aramayı yönlendirmek için harcadığı süre",
    'incl. in progress': 'devam edenler dahil', '{n} unknown': '{n} bilinmeyen', 'INVITE → vendor (routing)': 'INVITE → vendor (yönlendirme)', 'Routing p95': 'Yönlendirme p95',
    'For end-to-end measurement the destination must end with at least 4 X, e.g. 8XXXXXXX. Route that prefix to the vendor on your PBX.': "Uçtan uca ölçüm için aranan numara en az 4 X ile bitmeli, ör. 8XXXXXXX. PBX'inde bu ön eki vendor'a yönlendir.",
    'End-to-end measurement needs the vendor on the left to be running and your PBX to route the calls to it. The vendor is stopped. Start anyway?': "Uçtan uca ölçüm için soldaki vendor'ın çalışması ve PBX'inin aramaları ona yönlendirmesi gerekir. Vendor durmuş. Yine de başlatılsın mı?",
    'End-to-end measurement needs at least 4 X at the end of the destination (e.g. 8XXXXXXX)': 'Uçtan uca ölçüm için aranan numaranın sonunda en az 4 X olmalı (ör. 8XXXXXXX)',
    'End-to-end measurement: every destination needs the same number of trailing X': "Uçtan uca ölçüm: tüm aranan numaraların sonunda aynı sayıda X olmalı",
    'First call that reached the vendor twice': "Vendor'a iki kez ulaşan ilk arama",
    'End-to-end routing p95': 'Uçtan uca yönlendirme p95', 'Not reached the vendor': "Vendor'a ulaşmayan",
    'No call reached the vendor. Check that your PBX routes the destination prefix to the built-in vendor (trunk address, port, authentication).': "Hiçbir arama vendor'a ulaşmadı. PBX'inin aranan ön eki dahili vendor'a yönlendirdiğini kontrol et (trunk adresi, port, kimlik doğrulama).",
    '{n} of {sent} calls ({pct}%) never reached the vendor: they were rejected or lost inside the PBX.': "{sent} aramanın {n} tanesi (%{pct}) vendor'a hiç ulaşmadı: PBX içinde reddedildi veya kayboldu.",
    'All {n} calls reached the vendor through the PBX.': "{n} aramanın tamamı PBX üzerinden vendor'a ulaştı.",
    'PBX routing delay (client INVITE → vendor INVITE): p50 {p50} ms, p95 {p95} ms, p99 {p99} ms.': 'PBX yönlendirme gecikmesi (client INVITE → vendor INVITE): p50 {p50} ms, p95 {p95} ms, p99 {p99} ms.',
    'PBX routing delay rose at {time}, at about {tps} {unit} (p95 {base} → {p95} ms): the PBX takes longer to send calls to the trunk.': "PBX yönlendirme gecikmesi {time}'de, yaklaşık {tps} {unit} yükte yükseldi (p95 {base} → {p95} ms): PBX aramaları trunk'a daha geç gönderiyor.",
    '{n} calls reached the vendor more than once (PBX retry or failover).': "{n} arama vendor'a birden fazla kez ulaştı (PBX yeniden deneme veya yedek hat).",
    '{n} calls arrived at the vendor with a number the test did not send. The PBX may rewrite the dialled number, or other traffic reaches the vendor.': "{n} arama vendor'a testin göndermediği bir numarayla geldi. PBX aranan numarayı değiştiriyor olabilir ya da vendor'a başka trafik geliyor.",
    'Routing delay p95 (PBX)': 'Yönlendirme gecikmesi p95 (PBX)', 'ms · {pct} reached the vendor': "ms · {pct} vendor'a ulaştı", 'Duplicates at the vendor': "Vendor'da çift",
    'Unknown numbers at the vendor': "Vendor'da bilinmeyen numara", 'Routing: INVITE → vendor (p50/p95/p99/max)': 'Yönlendirme: INVITE → vendor (p50/p95/p99/maks)',
    'call number in the last {k} digits': 'arama numarası son {k} hanede', 'Routing delay up · ~{tps} {unit}': 'Yönlendirme gecikmesi arttı · ~{tps} {unit}',
    'answer {ms} ms': 'cevap {ms} ms', 'answers at once': 'hemen cevaplar', 'hangs up after {s} s': '{s} sn sonra kapatır', 'limit {n} CPS': 'sınır {n} CPS',
    '{n} channels': '{n} kanal', 'capacity {n} CPS': 'kapasite {n} CPS', 'busy {p}%': 'meşgul %{p}', '{code} on {p}%': '%{p} aramada {code}', 'silent': 'sessiz', 'RTP echo': 'RTP echo',
    'The server saturated already at the first step ({knee} {unit}; successful {ok} {unit}).': 'Sunucu daha ilk basamakta doydu ({knee} {unit}; başarılı {ok} {unit}).',
    'Latency rose already at the first step ({knee} {unit}; p95 {p95} ms).': 'Gecikme daha ilk basamakta yükseldi ({knee} {unit}; p95 {p95} ms).',
    'The server could not handle even the first step (<b>{knee} {unit}</b>).': 'Sunucu ilk basamağı (<b>{knee} {unit}</b>) bile kaldıramadı.',
  };

  const DICTS = { en: {}, tr: TR };
  const LOCALES = { en: 'en-US', tr: 'tr-TR' };
  const listeners = [];
  const store = {
    get() { try { return win && win.localStorage.getItem('lang'); } catch { return null; } },
    set(v) { try { win && win.localStorage.setItem('lang', v); } catch {} },
  };
  const detect = () => (win && win.navigator && /^tr\b/i.test(win.navigator.language || '')) ? 'tr' : 'en';
  let lang = (store.get() in DICTS) ? store.get() : (win ? detect() : 'en');

  const fill = (s, p) => p ? String(s).replace(/\{(\w+)\}/g, (m, k) => p[k] !== undefined ? p[k] : m) : String(s);
  function t(s, p) { const d = DICTS[lang]; return fill(d && d[s] !== undefined ? d[s] : s, p); }
  // Backend messages: { key, p, text } objects, plain strings, or undefined
  function msg(m) {
    if (m == null) return '';
    if (typeof m === 'string') return t(m);
    if (m.key) return t(m.key, m.p);
    return m.text != null ? t(m.text) : String(m);
  }
  function apply(rootEl) {
    if (!win) return;
    const doc = rootEl || win.document;
    doc.querySelectorAll('[data-i18n]').forEach(el => {
      if (el.dataset.i18nSrc === undefined) el.dataset.i18nSrc = el.textContent.replace(/\s+/g, ' ').trim();
      el.textContent = t(el.dataset.i18nSrc);
    });
    doc.querySelectorAll('[data-i18n-attr]').forEach(el => {
      for (const a of el.dataset.i18nAttr.split(',').map(x => x.trim())) {
        const k = 'i18nSrc' + a[0].toUpperCase() + a.slice(1);
        if (el.dataset[k] === undefined) el.dataset[k] = el.getAttribute(a) || '';
        if (el.dataset[k]) el.setAttribute(a, t(el.dataset[k]));
      }
    });
    win.document.documentElement.lang = lang;
  }
  function setLang(l) {
    if (!(l in DICTS) || l === lang) return;
    lang = l; store.set(l); apply();
    listeners.forEach(fn => { try { fn(lang); } catch (e) { console.error(e); } });
  }
  return {
    t, msg, apply, setLang, same: SAME,
    onChange: fn => listeners.push(fn),
    dict: l => DICTS[l] || {},
    get lang() { return lang; },
    get locale() { return LOCALES[lang] || 'en-US'; },
  };
});
