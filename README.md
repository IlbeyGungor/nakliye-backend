# Nakliye Pazar Backend

Nakliye Pazar uygulaması için Express/PostgreSQL API.

## Kapsam

- Auth: telefon/şifre, Firebase tabanlı giriş, profil.
- Listings: `vehicle_search` ve `cargo_search` ilan tipleri, nakliye kategorileri, fotoğraf yükleme.
- Offers: teklif, karşı teklif, kabul/red, rezervasyon akışı.
- Messages: kabul edilmiş teklifler üzerinden sohbet.
- Users: profil, yorumlar, raporlama, telefon doğrulama limitleri.

Hal fiyatı tabloları, scraper job'ları ve `/api/prices` endpointleri bu backend'de yoktur.

## Kurulum

```bash
npm install
cp .env.example .env
npm run migrate
npm run seed
npm run dev
```

Varsayılan demo kullanıcı:

```text
phone: +905321234567
password: demo1234
```
