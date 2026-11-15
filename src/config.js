// Ortam değişkenlerinden yapılandırma. Gizli değerler asla koda gömülmez.
try {
  process.loadEnvFile();
} catch {
  /* .env yoksa ortam değişkenleri kullanılır */
}

const ids = (v) =>
  new Set(
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d{17,20}$/.test(s)),
  );
const bool = (v, d = false) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const int = (v, d) => (Number.isFinite(Number.parseInt(v, 10)) ? Number.parseInt(v, 10) : d);

export const config = {
  token: process.env.DISCORD_TOKEN ?? '',
  // Whitelist'i yönetebilen tek grup (sunucu sahibi her zaman dahildir).
  masterAdmins: ids(process.env.MASTER_ADMINS),
  // Verilirse komutlar yalnızca bu sunucuya (anında) kaydedilir; yoksa global.
  devGuildId: process.env.GUILD_ID || null,
  dataFile: process.env.DATA_FILE || 'data/sentinel.db',
  // Devre kesici: pencere içinde limit'ten FAZLA silme -> tetiklenir.
  breakerLimit: int(process.env.BREAKER_LIMIT, 10),
  // Aynı pencerede bu sayıdan FAZLA ban/kick -> tetiklenir (raid temizliği için daha yüksek).
  memberBreakerLimit: int(process.env.BREAKER_MEMBER_LIMIT, 20),
  breakerWindowMs: int(process.env.BREAKER_WINDOW_MINUTES, 10) * 60_000,
  // İhlal / devre kesici anında sunucuyu otomatik kilitle.
  autoLockdown: bool(process.env.AUTO_LOCKDOWN, false),
  // Ayarlanırsa lockdown onayı bir şifre modalı ister.
  lockdownPassword: process.env.LOCKDOWN_PASSWORD || null,
  // Raid koruması, yönetici DM'leri ve rol üyeliği yedeği için gerekli (privileged intent).
  membersIntent: bool(process.env.MEMBERS_INTENT, true),
};
