# SentinelGuard v3.0

Discord anti-nuke + anti-raid botu. Node.js ≥ 22.13, discord.js v14, veriler SQLite'ta (`data/sentinel.db`).

## Kurulum

```bash
npm install
```

```bash
cp .env.example .env
```

`.env` içine `DISCORD_TOKEN` ve `MASTER_ADMINS` (virgülle ayrılmış kullanıcı ID'leri) yazın, sonra:

```bash
npm start
```

### Discord tarafı (zorunlu)

1. Developer Portal → Bot → **Server Members Intent** açık olmalı (raid koruması ve rol üyeliği yedeği buna bağlı).
2. Botu `bot` + `applications.commands` kapsamlarıyla ve **Yönetici** yetkisiyle davet edin.
3. Botun rolünü rol listesinde **en üste** taşıyın. Bot, kendi rolünden yukarıdaki birini banlayamaz.
4. `/guard panel` → alttaki menüden **güvenlik log kanalını** seçin.
5. Bot **izleme modunda** başlar: ihlalleri loglar ama ceza vermez. Logları birkaç gün izleyip whitelist'i
   oturttuktan sonra `/guard panel` → ⚙️ Ayarlar → **İzleme: Kapat** ile korumayı etkinleştirin.

## Komutlar

| Komut | Kim | İşlev |
|---|---|---|
| `/guard panel` | Whitelist + Master Admin | Durum paneli, loglar, ayarlar |
| `/guard whitelist islem kullanici [kapsam] [sure]` | Master Admin | Kapsamlı / süreli whitelist |
| `/guard lockdown` | Master Admin | Kilidi aç / kapat (onaylı, isteğe bağlı şifreli) |

## Anti-nuke kuralları

| Olay | Whitelist dışı | Whitelist (kapsamı uygunsa) / Master | Taç sahibi |
|---|---|---|---|
| Kanal / rol oluşturma | Yaptırım + oluşturulan silinir | Serbest | Serbest |
| Kanal / rol / webhook silme | Yaptırım | Serbest (sayaç işler) | Serbest, loglanır |
| Ban / kick / prune | Yaptırım (+ ban geri alınır) | Serbest (sayaç işler) | Serbest |
| Bot ekleme | Yaptırım + bot banlanır | Serbest | Serbest |
| Webhook oluşturma / değiştirme | Yaptırım + webhook silinir | Serbest | Serbest |
| Role tehlikeli izin ekleme | Yaptırım + izinler geri alınır | Serbest (`@everyone` ise geri alınır) | Serbest |
| Tehlikeli rolü birine verme | Yaptırım + rol geri alınır | Serbest | Serbest |
| Vanity URL değişikliği | Yaptırım + geri yüklenir | Geri yüklenir | Serbest, loglanır |
| **Devre kesici:** 10 dk'da >10 silme ya da >20 ban/kick | Ban | **Ban + whitelist kaydı kalıcı silinir + alarm DM** | Banlanmaz, uyarı loglanır |

**Yaptırım:** Kademeli ceza açıkken karantina (roller sökülür; log mesajından *Affet* / *Banla*), kapalıyken
doğrudan ban. Devre kesici her zaman banlar. Emoji / çıkartma silme tek başına ihlal değildir, yalnızca sayaca girer.

## Diğer katmanlar

- **Raid koruması:** `60 sn` içinde `10` katılım → raid modu: doğrulama seviyesi en yükseğe çekilir, dalgadaki ve
  sonradan gelen hesaplar atılır; 10 dk sakinlikten sonra kendiliğinden kapanır. İsteğe bağlı hesap yaşı filtresi.
- **Yedek ve geri yükleme:** Kanal ve roller sürekli yedeklenir. Alarm mesajındaki *Silinenleri Geri Yükle* butonu,
  o kişinin son 24 saatte sildiği kanal ve rolleri (izinler, kategori bağı, rol üyeleri) yeniden oluşturur.
- **Çift onay:** Whitelist'e ekleme, kilidi kaldırma ve korumayı zayıflatan ayarlar ikinci bir Master Admin'in
  onayını ister. Sunucu sahibi muaftır.
- **Kendini koruma:** Botun Yönetici yetkisi alınırsa, rolünün üstüne yetkili rol çıkarsa ya da bot atılırsa
  Master Adminlere DM gider.
- **Kopukluk telafisi:** Bot yeniden bağlandığında kaçırdığı audit log kayıtlarını (son 24 saat) işler.
- **Haftalık özet** log kanalına düşer.

Testler: `npm test`.
