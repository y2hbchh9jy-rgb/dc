// Raid koruması: kısa sürede anormal katılım -> raid modu.
// Raid modunda doğrulama seviyesi en yükseğe çekilir ve yeni katılanlar atılır;
// sakinleşince (ya da butonla) eski seviye geri yüklenir.
import { GuildVerificationLevel } from 'discord.js';
import { logEmbed, raidRow } from './ui.js';

const RAID_CALM_MS = 10 * 60_000; // son tetiklenmeden bu kadar sonra raid modu biter
const DAY = 86_400_000;

export function createRaid({ store, guard }) {
  const joins = new Map(); // guildId -> [{ id, t }]
  const monitorCooldown = new Map();

  const kick = (member, reason) =>
    member.kick(reason).then(
      () => true,
      () => false,
    );

  async function startRaid(guild, burst, s) {
    const state = { since: Date.now(), until: Date.now() + RAID_CALM_MS, oldLevel: guild.verificationLevel, kicked: 0 };
    store.set(guild.id, 'raidState', state);
    let levelNote = 'Doğrulama seviyesi **en yükseğe** çekildi';
    try {
      await guild.setVerificationLevel(GuildVerificationLevel.VeryHigh, 'SentinelGuard: raid modu');
    } catch (e) {
      levelNote = `Doğrulama seviyesi değiştirilemedi (${e.message})`;
    }
    for (const j of burst) {
      const m = guild.members.cache.get(j.id);
      if (m && (await kick(m, 'SentinelGuard: raid dalgası'))) state.kicked++;
    }
    store.set(guild.id, 'raidState', state);
    store.addIncident(guild.id, {
      type: 'RAID ALGILANDI',
      detail: `${s.raidWindowSec} sn içinde ${burst.length} katılım`,
      result: `${state.kicked} hesap atıldı`,
    });
    const embed = logEmbed('critical', '🚨 RAID ALGILANDI — Raid Modu Açıldı', [
      `**Sunucu:** ${guild.name}`,
      `**Sebep:** ${s.raidWindowSec} saniyede **${burst.length}** katılım (eşik: ${s.raidJoins})`,
      `${levelNote}\nDalgadaki **${state.kicked}** hesap atıldı; raid modu boyunca yeni katılanlar da atılacak.`,
      `Katılımlar ${RAID_CALM_MS / 60_000} dakika sakin kalırsa raid modu kendiliğinden kapanır.`,
    ]);
    await guard.sendLog(guild, embed, raidRow());
    await guard.alertAdmins(guild, embed);
  }

  async function endRaid(guild, by = null) {
    const state = store.get(guild.id, 'raidState');
    if (!state) return null;
    store.set(guild.id, 'raidState', null);
    joins.delete(guild.id);
    let note = 'Doğrulama seviyesi eski haline döndürüldü.';
    try {
      await guild.setVerificationLevel(state.oldLevel, 'SentinelGuard: raid modu bitti');
    } catch (e) {
      note = `Doğrulama seviyesi geri yüklenemedi (${e.message}).`;
    }
    const text = `Raid modu ${by ? `<@${by}> tarafından` : 'kendiliğinden'} kapatıldı. Toplam **${state.kicked}** hesap atıldı. ${note}`;
    await guard.sendLog(guild, logEmbed('ok', '✅ Raid Modu Kapandı', [text]));
    return text;
  }

  async function onJoin(member) {
    if (member.user.bot) return; // bot eklemeleri audit log üzerinden ele alınır
    const { guild } = member;
    const s = store.settings(guild.id);
    if (!s.raid) return;
    const now = Date.now();

    // Raid modu aktif: yeni katılanı at, süreyi uzat
    if (s.raidState) {
      if (await kick(member, 'SentinelGuard: raid modu aktif')) s.raidState.kicked++;
      s.raidState.until = now + RAID_CALM_MS;
      store.set(guild.id, 'raidState', s.raidState);
      return;
    }

    // Hesap yaşı filtresi
    const ageDays = (now - member.user.createdTimestamp) / DAY;
    if (s.minAccountAgeDays > 0 && ageDays < s.minAccountAgeDays) {
      const acted = !s.monitor && (await kick(member, `SentinelGuard: hesap ${s.minAccountAgeDays} günden yeni`));
      await guard.sendLog(
        guild,
        logEmbed('warn', `${s.monitor ? '👁️ [İZLEME] ' : ''}Yeni Hesap Filtresi`, [
          `**Kullanıcı:** <@${member.id}> (\`${member.id}\`)`,
          `**Hesap yaşı:** ${ageDays.toFixed(1)} gün (en az ${s.minAccountAgeDays})`,
          s.monitor ? 'İzleme modu — atılmadı.' : acted ? 'Sunucudan atıldı.' : '❌ Atılamadı.',
        ]),
      );
      if (acted) return;
    }

    // Katılım hızı
    let list = joins.get(guild.id);
    if (!list) joins.set(guild.id, (list = []));
    const cut = now - s.raidWindowSec * 1000;
    while (list.length && list[0].t <= cut) list.shift();
    list.push({ id: member.id, t: now });
    if (list.length < s.raidJoins) return;

    if (s.monitor) {
      if (now - (monitorCooldown.get(guild.id) ?? 0) < RAID_CALM_MS) return;
      monitorCooldown.set(guild.id, now);
      store.addIncident(guild.id, { type: '[İZLEME] RAID ALGILANDI', detail: `${s.raidWindowSec} sn içinde ${list.length} katılım` });
      await guard.sendLog(
        guild,
        logEmbed('warn', '👁️ [İZLEME] Raid Algılandı', [
          `${s.raidWindowSec} saniyede **${list.length}** katılım (eşik: ${s.raidJoins}).`,
          'İzleme modu — işlem yapılmadı. Koruma açık olsaydı: **raid modu + dalgadaki hesapların atılması**',
        ]),
      );
      return;
    }
    const burst = list.splice(0);
    await startRaid(guild, burst, s);
  }

  /** Süresi dolan raid modlarını kapatır (periyodik + açılışta). */
  async function tick(guilds) {
    for (const guild of guilds) {
      const state = store.get(guild.id, 'raidState');
      if (state && state.until <= Date.now()) await endRaid(guild).catch((e) => console.error('[raid]', e));
    }
  }

  return { onJoin, endRaid, tick };
}
