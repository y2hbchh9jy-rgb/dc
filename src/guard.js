// Koruma çekirdeği. Tek giriş noktası: Discord'un gateway üzerinden gönderdiği
// audit log kayıtları (GuildAuditLogEntryCreate). Kayıt, işlemi yapan gerçek
// kullanıcıyı doğrudan içerir. Bot çevrimdışıyken kaçan kayıtlar catchUp() ile
// REST üzerinden taranıp aynı yoldan işlenir.
import { AuditLogEvent, PermissionFlagsBits as P, PermissionsBitField, Routes, SnowflakeUtil } from 'discord.js';
import { enableLockdown } from './lockdown.js';
import { actionRow, logEmbed } from './ui.js';

export const DANGEROUS =
  P.Administrator | P.ManageGuild | P.ManageRoles | P.ManageChannels | P.BanMembers | P.KickMembers | P.ManageWebhooks;

const CATCHUP_MAX_AGE_MS = 24 * 3_600_000;
const CROWN = '[⚠️ KRİTİK UYARI - TAÇ SAHİBİ İŞLEMİ]';

export function createGuard({ client, store, counter, config, backup }) {
  const inflight = new Map(); // eşzamanlı olaylarda tek yaptırım
  const seen = new Map(); // guildId -> işlenen son audit kayıt kimlikleri
  const healthState = new Map();
  const healthTimers = new Map();

  const isMaster = (guild, uid) => uid === guild.ownerId || config.masterAdmins.has(uid);
  const isTrusted = (guild, uid, scope) => isMaster(guild, uid) || store.isWhitelisted(guild.id, uid, scope);
  const masterIds = (guild) => new Set([guild.ownerId, ...config.masterAdmins]);

  // ---------------------------------------------------------------- loglama
  async function sendLog(guild, embed, components = []) {
    const id = store.get(guild.id, 'logChannelId');
    const ch = id && guild.channels.cache.get(id);
    if (!ch?.isTextBased()) return null;
    try {
      return await ch.send({ embeds: [embed], components, allowedMentions: { parse: [] } });
    } catch (e) {
      console.error(`[log] ${guild.id}: log kanalına yazılamadı: ${e.message}`);
      return null;
    }
  }

  async function alertAdmins(guild, embed, { excludeId, mastersOnly = false } = {}) {
    const ids = masterIds(guild);
    if (!mastersOnly && config.membersIntent) {
      try {
        const members = await guild.members.fetch();
        for (const m of members.values()) if (!m.user.bot && m.permissions.has(P.Administrator)) ids.add(m.id);
      } catch (e) {
        console.error(`[alarm] ${guild.id}: üye listesi alınamadı: ${e.message}`);
      }
    }
    ids.delete(excludeId);
    ids.delete(client.user.id);
    let ok = 0;
    for (const id of ids) {
      try {
        await client.users.send(id, { embeds: [embed] });
        ok++;
      } catch {
        /* DM kapalı */
      }
    }
    return { ok, total: ids.size };
  }

  // ------------------------------------------------------------- yaptırımlar
  async function stripRoles(guild, uid, reason) {
    const m = await guild.members.fetch(uid);
    if (m.user.bot) throw new Error('bot hesabı');
    const saved = m.roles.cache.filter((r) => !r.managed && r.id !== guild.id).map((r) => r.id);
    store.saveQuarantine(guild.id, uid, saved); // önceki kayıt varsa korunur
    await m.roles.set(
      m.roles.cache.filter((r) => r.managed).map((r) => r.id),
      reason,
    );
  }

  async function doBan(guild, uid, reason) {
    try {
      await guild.bans.create(uid, { reason });
      store.deleteQuarantine(guild.id, uid);
      return { kind: 'ban', ok: true };
    } catch (e) {
      // Ban başarısız (ör. rol hiyerarşisi): en azından rollerini sök.
      try {
        await stripRoles(guild, uid, reason);
        return { kind: 'quarantine', ok: true, note: `ban başarısız (${e.message})` };
      } catch {
        return { kind: 'ban', ok: false, note: e.message };
      }
    }
  }

  async function doQuarantine(guild, uid, reason) {
    try {
      await stripRoles(guild, uid, reason);
      return { kind: 'quarantine', ok: true };
    } catch {
      // Üye sunucuda değil, bot hesabı ya da rolleri sökülemiyor -> ban
      return doBan(guild, uid, reason);
    }
  }

  function sanctionOnce(guild, uid, mode, reason) {
    const key = `${guild.id}:${uid}:${mode}`;
    let p = inflight.get(key);
    if (!p) {
      p = (mode === 'ban' ? doBan : doQuarantine)(guild, uid, reason.slice(0, 500));
      inflight.set(key, p);
      setTimeout(() => inflight.delete(key), 30_000).unref();
    }
    return p;
  }

  const sanctionText = (s) =>
    !s.ok
      ? `❌ BAN BAŞARISIZ (${s.note}) — MANUEL MÜDAHALE GEREKLİ`
      : s.kind === 'ban'
        ? '✅ Sınırsız banlandı'
        : `🔒 Karantinaya alındı (rolleri söküldü)${s.note ? ` — ${s.note}` : ''}`;

  /** Karantinadaki kullanıcının rollerini geri verir. */
  async function forgive(guild, uid) {
    const q = store.getQuarantine(guild.id, uid);
    if (!q) return 'Karantina kaydı bulunamadı.';
    const m = await guild.members.fetch(uid).catch(() => null);
    if (!m) {
      store.deleteQuarantine(guild.id, uid);
      return 'Kullanıcı sunucuda değil; karantina kaydı silindi.';
    }
    const roles = q.roles.filter((id) => guild.roles.cache.get(id)?.editable);
    await m.roles.add(roles, 'SentinelGuard: affedildi');
    store.deleteQuarantine(guild.id, uid);
    return `Affedildi — ${roles.length}/${q.roles.length} rol geri verildi.`;
  }

  async function autoLockdown(guild, reason) {
    if (!config.autoLockdown) return null;
    const res = await enableLockdown(guild, store, { by: client.user.id, reason });
    return res.already || res.busy ? 'Kilit zaten aktif' : `Otomatik kilit: ${res.ok} kanal kilitlendi, ${res.failed} başarısız`;
  }

  /**
   * Tüm ihlallerin ortak çıkışı. mode: 'ban' | 'graded' | 'none' (yalnızca geri al).
   * İzleme modunda hiçbir işlem yapılmaz; ne yapılacağı loglanır.
   */
  async function enforce(guild, uid, { type, lines = [], targetId = null, detail = null, mode, undo, alarm = false, restorable = false }) {
    const s = store.settings(guild.id);
    const who = `**Kullanıcı:** <@${uid}> (\`${uid}\`)`;
    const real = mode === 'graded' && !s.graded ? 'ban' : mode;

    if (s.monitor) {
      const would = [real === 'ban' ? 'sınırsız ban' : real === 'graded' ? 'karantina' : null, undo && 'işlemin geri alınması']
        .filter(Boolean)
        .join(' + ');
      const result = `👁️ İzleme modu — işlem yapılmadı. Koruma açık olsaydı: **${would || 'yalnızca log'}**`;
      store.addIncident(guild.id, { type: `[İZLEME] ${type}`, executorId: uid, targetId, detail, result });
      await sendLog(
        guild,
        logEmbed('warn', `👁️ [İZLEME] ${type}`, [who, ...lines, result]),
        real === 'none' ? [] : actionRow({ uid, monitor: true }),
      );
      return;
    }

    const reason = `SentinelGuard: ${type}`;
    const [sanction, undone] = await Promise.all([
      real === 'none' ? null : sanctionOnce(guild, uid, real === 'ban' ? 'ban' : 'graded', reason),
      undo ? undo(reason).catch((e) => `Geri alma başarısız: ${e.message} — MANUEL MÜDAHALE GEREKLİ`) : null,
    ]);
    const lock = real === 'none' ? null : await autoLockdown(guild, reason);
    const result = [sanction && sanctionText(sanction), undone && `↩️ ${undone}`, lock].filter(Boolean).join('\n');
    store.addIncident(guild.id, { type, executorId: uid, targetId, detail, result });

    const embed = logEmbed('critical', alarm ? `🚨 ACİL DURUM — ${type}` : `⛔ ${type}`, [who, ...lines, `**Sonuç:**\n${result}`]);
    await sendLog(
      guild,
      embed,
      actionRow({ uid, kind: sanction?.ok ? sanction.kind : null, restorable: restorable && backup?.restorableCount(guild.id, uid) > 0 }),
    );
    if (alarm) {
      const dm = await alertAdmins(guild, embed.setDescription(`**Sunucu:** ${guild.name}\n${embed.data.description}`), { excludeId: uid });
      console.warn(`[alarm] ${guild.id}: ${uid} ${type} (DM ${dm.ok}/${dm.total})`);
    }
  }

  // -------------------------------------------------------- geri alma işlemleri
  const undoers = {
    async deleteChannel(entry, guild, reason) {
      const ch = guild.channels.cache.get(entry.targetId) ?? (await guild.channels.fetch(entry.targetId).catch(() => null));
      if (!ch) return 'Kanal zaten yok';
      await ch.delete(reason);
      return 'Oluşturulan kanal silindi';
    },
    async deleteRole(entry, guild, reason) {
      const role = guild.roles.cache.get(entry.targetId) ?? (await guild.roles.fetch(entry.targetId).catch(() => null));
      if (!role) return 'Rol zaten yok';
      await role.delete(reason);
      return 'Oluşturulan rol silindi';
    },
    async unban(entry, guild, reason) {
      await guild.bans.remove(entry.targetId, reason);
      return 'Yetkisiz ban kaldırıldı';
    },
    async banBot(entry, guild, reason) {
      await guild.bans.create(entry.targetId, { reason });
      return 'Eklenen bot banlanıp sunucudan atıldı';
    },
    async deleteWebhook(entry, _guild, reason) {
      const wh = await client.fetchWebhook(entry.targetId);
      await wh.delete(reason);
      return 'Webhook silindi';
    },
  };

  // scope: whitelist kapsamı | bucket: devre kesici sayacı | countOnly: tek başına ihlal değil
  const RULES = {
    [AuditLogEvent.ChannelCreate]: { label: 'Kanal oluşturma', scope: 'channels', undo: 'deleteChannel' },
    [AuditLogEvent.ChannelDelete]: { label: 'Kanal silme', scope: 'channels', bucket: 'structure', restorable: true },
    [AuditLogEvent.RoleCreate]: { label: 'Rol oluşturma', scope: 'roles', undo: 'deleteRole' },
    [AuditLogEvent.RoleDelete]: { label: 'Rol silme', scope: 'roles', bucket: 'structure', restorable: true },
    [AuditLogEvent.MemberBanAdd]: { label: 'Ban atma', scope: 'members', bucket: 'members', undo: 'unban' },
    [AuditLogEvent.MemberKick]: { label: 'Üye atma (kick)', scope: 'members', bucket: 'members' },
    [AuditLogEvent.MemberPrune]: { label: 'Toplu üye budama (prune)', scope: 'members', bucket: 'members' },
    [AuditLogEvent.BotAdd]: { label: 'Bot ekleme', scope: 'integrations', undo: 'banBot' },
    [AuditLogEvent.WebhookCreate]: { label: 'Webhook oluşturma', scope: 'integrations', undo: 'deleteWebhook' },
    [AuditLogEvent.WebhookUpdate]: { label: 'Webhook değiştirme', scope: 'integrations', undo: 'deleteWebhook' },
    [AuditLogEvent.WebhookDelete]: { label: 'Webhook silme', scope: 'integrations', bucket: 'structure' },
    [AuditLogEvent.EmojiDelete]: { label: 'Emoji silme', bucket: 'structure', countOnly: true },
    [AuditLogEvent.StickerDelete]: { label: 'Çıkartma silme', bucket: 'structure', countOnly: true },
  };
  const BUCKETS = {
    structure: { limit: () => config.breakerLimit, what: 'kanal/rol/webhook/emoji silme' },
    members: { limit: () => config.memberBreakerLimit, what: 'ban/kick' },
  };

  // ------------------------------------------------------------ özel korumalar
  async function handleVanity(guild, uid, change) {
    const fromTo = `\`${change.old ?? '—'}\` → \`${change.new ?? '—'}\``;
    if (uid === guild.ownerId) {
      await sendLog(guild, logEmbed('warn', `${CROWN} Vanity URL değişti`, [`**Kullanıcı:** <@${uid}>`, `**Değişiklik:** ${fromTo}`]));
      return;
    }
    await enforce(guild, uid, {
      type: 'Vanity URL değişikliği',
      lines: [`**Değişiklik:** ${fromTo}`],
      detail: fromTo,
      mode: isTrusted(guild, uid) ? 'none' : 'graded',
      undo: async (reason) => {
        if (!change.old) return 'Önceki bağlantı yok; geri alınamadı';
        await client.rest.patch(Routes.guildVanityUrl(guild.id), { body: { code: change.old }, reason });
        return `Vanity URL \`${change.old}\` olarak geri yüklendi`;
      },
    });
  }

  /** Bir role tehlikeli izin eklenmesi (yetki yükseltme). */
  async function handleRoleUpdate(guild, uid, entry) {
    const change = entry.changes?.find((c) => c.key === 'permissions');
    if (!change) return;
    const before = BigInt(change.old ?? 0);
    const added = BigInt(change.new ?? 0) & ~before & DANGEROUS;
    if (!added) return;
    const everyone = entry.targetId === guild.id;
    const names = new PermissionsBitField(added).toArray().join(', ');
    const lines = [`**Rol:** ${everyone ? '@everyone' : `<@&${entry.targetId}>`}`, `**Eklenen izinler:** ${names}`];

    if (uid === guild.ownerId) {
      if (everyone) await sendLog(guild, logEmbed('warn', `${CROWN} @everyone rolüne tehlikeli izin`, [`**Kullanıcı:** <@${uid}>`, ...lines]));
      return;
    }
    const trusted = isTrusted(guild, uid, 'roles');
    if (trusted && !everyone) return;
    await enforce(guild, uid, {
      type: everyone ? '@everyone rolüne tehlikeli izin' : 'Yetki yükseltme (rol izni)',
      lines,
      targetId: entry.targetId,
      detail: names,
      mode: trusted ? 'none' : 'graded',
      undo: async (reason) => {
        const role = guild.roles.cache.get(entry.targetId);
        if (!role) return 'Rol bulunamadı';
        await role.setPermissions(before, reason);
        return 'Rol izinleri eski haline döndürüldü';
      },
    });
  }

  /** Bir üyeye tehlikeli izinli rol verilmesi (yetki yükseltme). */
  async function handleMemberRoleUpdate(guild, uid, entry) {
    const added = entry.changes?.find((c) => c.key === '$add')?.new ?? [];
    const risky = added.filter((r) => guild.roles.cache.get(r.id)?.permissions.any(DANGEROUS));
    if (!risky.length || isTrusted(guild, uid, 'roles')) return;
    await enforce(guild, uid, {
      type: 'Yetki yükseltme (tehlikeli rol verme)',
      lines: [`**Hedef:** <@${entry.targetId}>`, `**Roller:** ${risky.map((r) => `<@&${r.id}>`).join(' ')}`],
      targetId: entry.targetId,
      mode: 'graded',
      undo: async (reason) => {
        const m = await guild.members.fetch(entry.targetId);
        await m.roles.remove(
          risky.map((r) => r.id),
          reason,
        );
        return 'Verilen roller geri alındı';
      },
    });
  }

  // ------------------------------------------------------------- ana işleyici
  function markSeen(guild, entry) {
    let ids = seen.get(guild.id);
    if (!ids) seen.set(guild.id, (ids = new Set()));
    if (ids.has(entry.id)) return false;
    ids.add(entry.id);
    if (ids.size > 1000) ids.delete(ids.values().next().value);
    const last = store.get(guild.id, 'lastAuditId');
    if (!last || BigInt(entry.id) > BigInt(last)) store.set(guild.id, 'lastAuditId', entry.id);
    return true;
  }

  async function handleAuditEntry(entry, guild) {
    if (entry.id && !markSeen(guild, entry)) return;
    const uid = entry.executorId;
    if (!uid || uid === client.user.id) return;

    switch (entry.action) {
      case AuditLogEvent.GuildUpdate: {
        const change = entry.changes?.find((c) => c.key === 'vanity_url_code');
        if (change) await handleVanity(guild, uid, change);
        return;
      }
      case AuditLogEvent.RoleUpdate:
        scheduleHealthCheck(guild);
        return handleRoleUpdate(guild, uid, entry);
      case AuditLogEvent.MemberRoleUpdate:
        if (entry.targetId === client.user.id) scheduleHealthCheck(guild);
        return handleMemberRoleUpdate(guild, uid, entry);
    }

    const rule = RULES[entry.action];
    if (!rule) return;
    const isOwner = uid === guild.ownerId;
    if (entry.action === AuditLogEvent.ChannelDelete) store.markDeleted(guild.id, 'channel', entry.targetId, uid);
    if (entry.action === AuditLogEvent.RoleDelete) store.markDeleted(guild.id, 'role', entry.targetId, uid);

    if (rule.bucket) {
      const bucket = BUCKETS[rule.bucket];
      const limit = bucket.limit();
      const key = `${guild.id}:${rule.bucket}:${uid}`;
      const ts = entry.createdTimestamp ?? Date.now();
      const weight = Math.min(entry.action === AuditLogEvent.MemberPrune ? (entry.extra?.removed ?? 1) : 1, limit + 1);
      let count = 0;
      for (let i = 0; i < Math.max(1, weight); i++) count = counter.hit(key, ts);
      const mins = Math.round(config.breakerWindowMs / 60_000);

      if (isOwner) {
        // Yapısal silmelerin her biri, üye işlemlerinde yalnızca limit aşımı raporlanır.
        if (rule.bucket === 'structure' || count === limit + 1) {
          await sendLog(
            guild,
            logEmbed('warn', `${CROWN} ${count > limit ? 'TOPLU İŞLEM' : rule.label}`, [
              `**Kullanıcı:** <@${uid}>`,
              `**İşlem:** ${rule.label}${entry.targetId ? ` (\`${entry.targetId}\`)` : ''}`,
              `**Penceredeki sayı:** ${count} / ${limit} (${mins} dk)`,
            ]),
          );
        }
        return;
      }
      if (count > limit) {
        // Devre kesici: whitelist ve Master Admin dahil herkes için geçerlidir.
        const detail = `${mins} dk içinde ${count} ${bucket.what} (limit: ${limit})`;
        counter.clear(key);
        const revoked = !store.get(guild.id, 'monitor') && store.revoke(guild.id, uid, detail);
        await enforce(guild, uid, {
          type: 'DEVRE KESİCİ TETİKLENDİ',
          lines: [`**Sebep:** ${detail}`, revoked ? '🗑️ Whitelist kaydı kalıcı olarak silindi' : null],
          detail,
          mode: 'ban',
          alarm: true,
          restorable: true,
        });
        return;
      }
    }

    if (rule.countOnly || isOwner || isTrusted(guild, uid, rule.scope)) return;
    await enforce(guild, uid, {
      type: `Yetkisiz işlem — ${rule.label}`,
      lines: entry.targetId ? [`**Hedef:** \`${entry.targetId}\``] : [],
      targetId: entry.targetId,
      mode: 'graded',
      undo: rule.undo && ((reason) => undoers[rule.undo](entry, guild, reason)),
      restorable: rule.restorable,
    });
  }

  // ------------------------------------------------- kopukluk sonrası telafi
  async function catchUp(guild) {
    const last = store.get(guild.id, 'lastAuditId');
    if (!last) {
      store.set(guild.id, 'lastAuditId', SnowflakeUtil.generate().toString());
      return 0;
    }
    let cursor = last;
    let processed = 0;
    for (let page = 0; page < 5; page++) {
      const logs = await guild.fetchAuditLogs({ limit: 100, after: cursor });
      const entries = [...logs.entries.values()]
        .filter((e) => BigInt(e.id) > BigInt(last))
        .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      for (const e of entries) {
        if (Date.now() - e.createdTimestamp > CATCHUP_MAX_AGE_MS) continue;
        if (seen.get(guild.id)?.has(e.id)) continue;
        await handleAuditEntry(e, guild).catch((err) => console.error('[catchup]', err));
        processed++;
      }
      if (entries.length < 100) break;
      cursor = entries.at(-1).id;
    }
    if (processed) {
      console.log(`[catchup] ${guild.id}: ${processed} kaçan kayıt işlendi`);
      await sendLog(guild, logEmbed('info', '🔁 Kopukluk Telafisi', [`Bot çevrimdışıyken oluşan **${processed}** audit kaydı incelendi.`]));
    }
    return processed;
  }

  // ---------------------------------------------------- botun kendini koruması
  function health(guild) {
    const me = guild.members?.me;
    if (!me) return null;
    const top = me.roles.highest;
    return {
      admin: me.permissions.has(P.Administrator),
      above: guild.roles.cache.filter((r) => !r.managed && r.comparePositionTo(top) > 0 && r.permissions.any(DANGEROUS)).size,
    };
  }

  async function checkHealth(guild) {
    const now = health(guild);
    if (!now) return;
    const prev = healthState.get(guild.id);
    healthState.set(guild.id, now);
    if (!prev) return;
    const problems = [];
    if (prev.admin && !now.admin) problems.push('Botun **Yönetici** yetkisi alındı — koruma güvenilir çalışmaz.');
    if (now.above > prev.above) {
      problems.push(`Botun rolünün üstünde artık **${now.above}** yetkili rol var — bu rollerdeki kişileri banlayamaz.`);
    }
    if (!problems.length) {
      if ((!prev.admin && now.admin) || now.above < prev.above) {
        await sendLog(guild, logEmbed('ok', '✅ Bot Yetkileri Düzeldi', [`Yönetici: ${now.admin ? 'var' : 'yok'} · Üstteki yetkili rol: ${now.above}`]));
      }
      return;
    }
    const embed = logEmbed('critical', '🛑 KORUMA ZAYIFLADI — Bot Yetkisi Değişti', [`**Sunucu:** ${guild.name}`, ...problems]);
    await sendLog(guild, embed);
    await alertAdmins(guild, embed, { mastersOnly: true });
  }

  function scheduleHealthCheck(guild) {
    clearTimeout(healthTimers.get(guild.id));
    const t = setTimeout(() => checkHealth(guild).catch((e) => console.error('[health]', e)), 3000);
    t.unref();
    healthTimers.set(guild.id, t);
  }

  /** Bot sunucudan atıldı / çıkarıldı. */
  async function onRemoved(guild) {
    const embed = logEmbed('critical', '🛑 SentinelGuard Sunucudan Çıkarıldı', [
      `**Sunucu:** ${guild.name} (\`${guild.id}\`)`,
      'Bot atıldı ya da banlandı. Bu sunucuda koruma artık **çalışmıyor**.',
    ]);
    await alertAdmins(guild, embed, { mastersOnly: true });
  }

  // ------------------------------------------------------------ haftalık özet
  async function weeklyReport(guild, now = Date.now()) {
    const week = 7 * 86_400_000;
    const last = store.get(guild.id, 'lastReportAt');
    if (!last) return void store.set(guild.id, 'lastReportAt', now);
    if (now - last < week) return;
    store.set(guild.id, 'lastReportAt', now);
    const st = store.incidentStats(guild.id, now - week);
    const h = health(guild);
    await sendLog(
      guild,
      logEmbed('info', '🗓️ Haftalık Güvenlik Özeti', [
        `**Toplam olay:** ${st.total}`,
        st.byType.length ? `**Türe göre:**\n${st.byType.map((r) => `• ${r.type}: ${r.n}`).join('\n')}` : null,
        st.top.length ? `**En çok olay:** ${st.top.map((r) => `<@${r.id}> (${r.n})`).join(', ')}` : null,
        `**Whitelist:** ${store.listWhitelist(guild.id).length} kişi · **Mod:** ${store.get(guild.id, 'monitor') ? '👁️ izleme' : '🛡️ koruma'}`,
        h ? `**Bot:** Yönetici ${h.admin ? '✅' : '❌'} · üstte ${h.above} yetkili rol` : null,
      ]),
    );
  }

  function resetGuild(guildId) {
    const counters = counter.clearPrefix(`${guildId}:`);
    for (const k of inflight.keys()) if (k.startsWith(`${guildId}:`)) inflight.delete(k);
    return counters;
  }

  return {
    handleAuditEntry,
    catchUp,
    sendLog,
    alertAdmins,
    forgive,
    banUser: (guild, uid, reason) => doBan(guild, uid, reason),
    health,
    checkHealth,
    scheduleHealthCheck,
    onRemoved,
    weeklyReport,
    resetGuild,
    isMaster,
    isTrusted,
    masterIds,
  };
}
