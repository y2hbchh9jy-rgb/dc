# Çalışma kuralları

- Bu depodaki her değişikliği, iş bitince commit edip GitHub'a (`main`) gönder. Kod yalnızca oturumun
  yerel diskinde bırakılmaz.
- Gizli değerler (`.env`, token, veritabanı dosyaları) asla commit edilmez.
- Göndermeden önce `npm test` çalıştır; başarısız test varsa bunu açıkça bildir.
