// Slash komutu (/guard) ve tüm buton / menü / modal etkileşimleri.
// Her tıklamada yetki YENİDEN doğrulanır; customId'ye asla güvenilmez.
import crypto from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { disableLockdown, enableLockdown, isLocked } from './lockdown.js';
import { SCOPES } from './store.js';
import {
  approvalMessage,
  confirmView,
  incidentsView,
  logEmbed,
  notice,
  panelView,
  passwordModal,
  raidModal,
  settingsView,
  whitelistView,
} from './ui.js';

const DURATIONS = { 0: 'kalıcı', 3600: '1 saat', 86400: '24 saat', 604800: '7 gün', 2592000: '30 gün' };
const SETTING_LABELS = { monitor: 'İzleme Modu', graded: 'Kademeli Ceza', dual: 'Çift Onay', raid: 'Raid Koruması' };
const APPROVAL_TTL_MS = 10 * 60_000;

export const commands = [
  {
    name: 'guard',
    description: 'SentinelGuard güvenlik yönetimi',
    default_member_permissions: '8', // Yönetici olmayanlara komut görünmez
    contexts: [0], // yalnızca sunucu
    options: [
      { type: 1, name: 'panel', description: 'Güvenlik panelini açar' },
      {
        type: 1,
        name: 'whitelist',
        description: 'Whitelist yönetimi (yalnızca Master Admin)',
        options: [
          {
            type: 3,
            name: 'islem',
            description: 'Yapılacak işlem',
            required: true,
            choices: [
              { name: 'ekle', value: 'add' },
              { name: 'çıkar', value: 'remove' },
            ],
          },
          { type: 6, name: 'kullanici', description: 'Kullanıcı (etiket veya ID)', required: true },
          {
            type: 3,
            name: 'kapsam',
            description: 'Hangi işlemler için güvenilsin? (varsayılan: tam yetki)',
            choices: Object.entries(SCOPES).map(([value, name]) => ({ name, value })),
          },
          {
            type: 3,
            name: 'sure',
            description: 'Ne kadar süreyle? (varsayılan: kalıcı)',
            choices: Object.entries(DURATIONS).map(([value, name]) => ({ name, value })),
          },
        ],
      },
      { type: 1, name: 'lockdown', description: 'Acil durum kilidini açar / kapatır (onaylı)' },
    ],
  },
];

const EPHEMERAL = { flags: MessageFlags.Ephemeral };
const DENIED_VIEW = '⛔ Bu paneli yalnızca whitelist üyeleri ve Master Adminler kullanabilir.';
const DENIED_MANAGE = '⛔ Bu işlem yalnızca Master Adminlere açıktır.';

function passwordMatches(input, expected) {
  const h = (s) => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(h(input), h(expected));
}

export function createInteractionHandler(ctx) {
  const { store, config, guard, backup, raid } = ctx;

  async function doLockdown(guild, mode, actorId) {
    const reason = `${actorId} tarafından`;
    const res =
      mode === 'on' ? await enableLockdown(guild, store, { by: actorId, reason }) : await disableLockdown(guild, store, { reason });
    if (res.busy) return { level: 'warn', title: '⏳ İşlem Sürüyor', text: 'Başka bir kilit işlemi devam ediyor.' };
    if (res.already) {
      return { level: 'warn', title: 'Değişiklik Yok', text: mode === 'on' ? 'Sunucu zaten kilitli.' : 'Sunucu zaten kilitli değil.' };
    }
    const title = mode === 'on' ? '🔒 Sunucu Kilitlendi' : '🔓 Kilit Kaldırıldı';
    const text = `**${res.ok}** kanal işlendi, **${res.failed}** başarısız.${
      mode === 'off' && res.failed ? '\nGeri yüklenemeyen kanallar kayıtta tutuldu; tekrar deneyebilirsiniz.' : ''
    }`;
    const level = mode === 'on' ? 'critical' : 'ok';
    store.addIncident(guild.id, { type: mode === 'on' ? 'LOCKDOWN AÇILDI' : 'LOCKDOWN KAPATILDI', executorId: actorId, result: text });
    await guard.sendLog(guild, logEmbed(level, title, [`**Yetkili:** <@${actorId}>`, text]));
    return { level, title, text };
  }

  // Çift onaya tabi olabilen işlemler. gated(): bu çağrı onay gerektirir mi?
  const ACTIONS = {
    wl_add: {
      gated: () => true,
      describe: (p) => `<@${p.userId}> whitelist'e eklensin — kapsam: **${SCOPES[p.scope]}**, süre: **${DURATIONS[p.ttl]}**`,
      async run(guild, p, actorId) {
        if (store.isRevoked(guild.id, p.userId)) {
          return { level: 'critical', title: 'Whitelist', text: `<@${p.userId}> devre kesici tarafından **kalıcı olarak** silindi; yeniden eklenemez.` };
        }
        const isNew = store.addWhitelist(guild.id, p.userId, actorId, {
          scopes: [p.scope],
          expiresAt: p.ttl ? Date.now() + p.ttl * 1000 : null,
        });
        const text = `<@${p.userId}> whitelist'${isNew ? 'e eklendi' : 'te güncellendi'} — kapsam: **${SCOPES[p.scope]}**, süre: **${DURATIONS[p.ttl]}**`;
        await guard.sendLog(guild, logEmbed('info', '➕ Whitelist Eklendi', [text, `**Yetkili:** <@${actorId}>`]));
        return { level: 'ok', title: 'Whitelist', text };
      },
    },
    lock: {
      gated: (p) => p.mode === 'off',
      describe: (p) => (p.mode === 'off' ? 'Acil durum kilidi **kaldırılsın**' : 'Sunucu **kilitlensin**'),
      run: (guild, p, actorId) => doLockdown(guild, p.mode, actorId),
    },
    set: {
      // Korumayı zayıflatan yöndeki değişiklikler onaya tabidir.
      gated: (p) => (p.key === 'monitor' && p.value) || (p.key === 'dual' && !p.value) || (p.key === 'raid' && !p.value),
      describe: (p) => `**${SETTING_LABELS[p.key]}** → **${p.value ? 'AÇIK' : 'KAPALI'}**`,
      async run(guild, p, actorId) {
        store.set(guild.id, p.key, p.value);
        const text = `${SETTING_LABELS[p.key]} ${p.value ? 'açıldı' : 'kapatıldı'}.`;
        await guard.sendLog(guild, logEmbed('warn', '⚙️ Ayar Değişti', [`**${text}**`, `**Yetkili:** <@${actorId}>`]));
        return { level: 'ok', title: '⚙️ Ayarlar', text, view: 'settings' };
      },
    },
  };

  const needsApproval = (guild, uid, action, payload) =>
    store.get(guild.id, 'dual') && uid !== guild.ownerId && guard.masterIds(guild).size >= 2 && Boolean(ACTIONS[action].gated(payload));

  /** Henüz yanıtlanmamış etkileşimi uygun biçimde yanıtlar. */
  function finish(interaction, view, ephemeral) {
    if (interaction.deferred || interaction.replied) return interaction.editReply(view);
    if (!ephemeral && (interaction.isMessageComponent() || (interaction.isModalSubmit() && interaction.isFromMessage()))) {
      return interaction.update(view);
    }
    return interaction.reply({ ...view, ...EPHEMERAL });
  }

  /** İşlemi doğrudan çalıştırır ya da çift onay gerekiyorsa istek oluşturur. */
  async function dispatch(interaction, action, payload, { ephemeral = false } = {}) {
    const { guild, user } = interaction;
    ephemeral ||= interaction.isChatInputCommand();

    if (needsApproval(guild, user.id, action, payload)) {
      const id = store.addApproval(guild.id, action, payload, user.id, APPROVAL_TTL_MS);
      const logId = store.get(guild.id, 'logChannelId');
      const channel = (logId && guild.channels.cache.get(logId)) || interaction.channel;
      try {
        await channel.send(approvalMessage(id, user.id, ACTIONS[action].describe(payload)));
      } catch {
        store.deleteApproval(id);
        return finish(interaction, notice('critical', 'Onay İsteği Gönderilemedi', `Bot <#${channel.id}> kanalına yazamıyor.`), ephemeral);
      }
      return finish(
        interaction,
        notice('warn', '⏳ İkinci Onay Bekleniyor', `İstek <#${channel.id}> kanalına gönderildi. Başka bir Master Admin 10 dakika içinde onaylamalı.`),
        ephemeral,
      );
    }

    if (ephemeral) await interaction.deferReply(EPHEMERAL);
    else await interaction.deferUpdate();
    const r = await ACTIONS[action].run(guild, payload, user.id);
    return interaction.editReply(r.view === 'settings' ? settingsView(guild, ctx) : notice(r.level, r.title, r.text));
  }

  async function onCommand(interaction) {
    const { guild, user } = interaction;
    const sub = interaction.options.getSubcommand();

    if (sub === 'panel') {
      if (!guard.isTrusted(guild, user.id)) return interaction.reply({ content: DENIED_VIEW, ...EPHEMERAL });
      return interaction.reply({ ...panelView(guild, ctx), ...EPHEMERAL });
    }
    if (!guard.isMaster(guild, user.id)) return interaction.reply({ content: DENIED_MANAGE, ...EPHEMERAL });
    if (sub === 'lockdown') return interaction.reply({ ...confirmView('lock', isLocked(store, guild.id)), ...EPHEMERAL });

    // whitelist
    const target = interaction.options.getUser('kullanici', true);
    if (interaction.options.getString('islem', true) === 'remove') {
      const done = store.removeWhitelist(guild.id, target.id);
      if (done) {
        await guard.sendLog(
          guild,
          logEmbed('info', '➖ Whitelist Çıkarıldı', [`**Kullanıcı:** <@${target.id}> (\`${target.id}\`)`, `**Yetkili:** <@${user.id}>`]),
        );
      }
      const text = done ? `<@${target.id}> whitelist'ten çıkarıldı.` : `<@${target.id}> whitelist'te değil.`;
      return interaction.reply({ ...notice(done ? 'ok' : 'warn', 'Whitelist', text), ...EPHEMERAL });
    }
    if (guard.isMaster(guild, target.id)) {
      return interaction.reply({ ...notice('warn', 'Whitelist', `<@${target.id}> zaten Master Admin / sunucu sahibi.`), ...EPHEMERAL });
    }
    return dispatch(interaction, 'wl_add', {
      userId: target.id,
      scope: interaction.options.getString('kapsam') ?? 'all',
      ttl: Number(interaction.options.getString('sure') ?? 0),
    });
  }

  /** Log mesajlarının altındaki karar butonları (herkese açık mesaj, yalnızca Master Admin). */
  async function onLogAction(interaction, kind, uid) {
    const { guild, user } = interaction;
    if (kind === 'wl') return dispatch(interaction, 'wl_add', { userId: uid, scope: 'all', ttl: 0 }, { ephemeral: true });
    await interaction.deferUpdate();
    const reason = `SentinelGuard: ${user.tag} kararıyla`;
    let text;
    switch (kind) {
      case 'forgive':
        text = await guard.forgive(guild, uid);
        break;
      case 'ban': {
        const r = await guard.banUser(guild, uid, reason);
        text = r.ok && r.kind === 'ban' ? 'Sınırsız banlandı.' : `Ban başarısız: ${r.note}`;
        break;
      }
      case 'unban':
        text = await guild.bans.remove(uid, reason).then(
          () => 'Ban kaldırıldı.',
          (e) => `Ban kaldırılamadı: ${e.message}`,
        );
        break;
      case 'restore': {
        const r = await backup.restoreDeletedBy(guild, uid);
        text = `${r.roles} rol ve ${r.channels} kanal yeniden oluşturuldu, ${r.failed} başarısız.${
          r.members ? ` ${r.members} üyeye roller arka planda geri veriliyor.` : ''
        } Mesaj geçmişi geri gelmez.`;
        break;
      }
      case 'raidend':
        text = (await raid.endRaid(guild, user.id)) ?? 'Raid modu zaten kapalı.';
        break;
      default:
        return;
    }
    // Kullanılan karar grubunun butonlarını kaldır, kararı mesaja işle.
    const group = kind === 'restore' || kind === 'raidend' ? [kind] : ['forgive', 'ban', 'unban', 'wl'];
    const components = interaction.message.components
      .map((r) =>
        new ActionRowBuilder().addComponents(
          r.components.filter((c) => !group.includes(c.customId?.split(':')[2])).map((c) => ButtonBuilder.from(c)),
        ),
      )
      .filter((r) => r.components.length);
    const embed = EmbedBuilder.from(interaction.message.embeds[0]).addFields({
      name: 'Karar',
      value: `${text} — <@${user.id}>`.slice(0, 1024),
    });
    return interaction.editReply({ embeds: [embed], components });
  }

  async function onApproval(interaction, verdict, idStr) {
    const { guild, user } = interaction;
    const req = store.getApproval(guild.id, Number(idStr));
    const close = (level, title, lines) => ({ embeds: [logEmbed(level, title, lines)], components: [] });
    if (!req) return interaction.update(close('warn', '🔐 İstek Geçersiz', ['Bu onay isteğinin süresi dolmuş ya da zaten sonuçlanmış.']));
    const what = [`**İsteyen:** <@${req.requestedBy}>`, `**İşlem:** ${ACTIONS[req.action].describe(req.payload)}`];

    if (verdict === 'no') {
      store.deleteApproval(req.id);
      return interaction.update(close('critical', '🔐 Reddedildi', [...what, `**Reddeden:** <@${user.id}>`]));
    }
    if (req.requestedBy === user.id && user.id !== guild.ownerId) {
      return interaction.reply({ content: '⛔ Kendi isteğinizi onaylayamazsınız; başka bir Master Admin onaylamalı.', ...EPHEMERAL });
    }
    store.deleteApproval(req.id);
    if (!guard.isMaster(guild, req.requestedBy)) {
      return interaction.update(close('critical', '🔐 İstek Geçersiz', [...what, 'İsteyen kişi artık Master Admin değil.']));
    }
    await interaction.deferUpdate();
    const r = await ACTIONS[req.action].run(guild, req.payload, req.requestedBy);
    return interaction.editReply(close(r.level === 'ok' ? 'ok' : r.level, '🔐 Onaylandı', [...what, `**Onaylayan:** <@${user.id}>`, `**Sonuç:** ${r.text}`]));
  }

  async function onComponent(interaction) {
    const { guild, user } = interaction;
    const [, action, a, b] = interaction.customId.split(':');
    if (!guard.isTrusted(guild, user.id)) return interaction.reply({ content: DENIED_VIEW, ...EPHEMERAL });

    switch (action) {
      case 'panel':
        return interaction.update(panelView(guild, ctx));
      case 'wl':
        return interaction.update(whitelistView(guild, ctx, Number.parseInt(a, 10) || 0));
      case 'logs':
        return interaction.update(incidentsView(guild, ctx));
    }

    // Buradan sonrası yalnızca Master Admin
    if (!guard.isMaster(guild, user.id)) return interaction.reply({ content: DENIED_MANAGE, ...EPHEMERAL });

    switch (action) {
      case 'act':
        return onLogAction(interaction, a, b);
      case 'apr':
        return onApproval(interaction, a, b);
      case 'settings':
        return interaction.update(settingsView(guild, ctx));
      case 'set':
        if (!Object.hasOwn(SETTING_LABELS, a)) return;
        return dispatch(interaction, 'set', { key: a, value: !store.get(guild.id, a) });
      case 'raidcfg':
        return interaction.showModal(raidModal(store.settings(guild.id)));
      case 'lock':
        return interaction.update(confirmView('lock', isLocked(store, guild.id)));
      case 'reset':
        return interaction.update(confirmView('reset'));
      case 'logch': {
        const channelId = interaction.values[0];
        store.set(guild.id, 'logChannelId', channelId);
        const reached = await guard.sendLog(guild, logEmbed('info', '📌 Güvenlik Log Kanalı Ayarlandı', [`**Yetkili:** <@${user.id}>`]));
        if (!reached) {
          return interaction.update(
            notice('warn', 'Log Kanalı', `<#${channelId}> kaydedildi ancak bot bu kanala **yazamıyor**. İzinleri kontrol edin.`),
          );
        }
        return interaction.update(panelView(guild, ctx));
      }
      case 'ok': {
        if (a === 'reset') {
          const n = guard.resetGuild(guild.id);
          await guard.sendLog(guild, logEmbed('warn', '🔄 Sistem Sıfırlandı', [`**Yetkili:** <@${user.id}>`, `Temizlenen sayaç: ${n}`]));
          return interaction.update(notice('ok', '🔄 Sistem Sıfırlandı', `**${n}** sayaç ve işlem önbelleği temizlendi.`));
        }
        if (a === 'lock' && (b === 'on' || b === 'off')) {
          if (config.lockdownPassword) return interaction.showModal(passwordModal(b));
          return dispatch(interaction, 'lock', { mode: b });
        }
      }
    }
  }

  async function onModal(interaction) {
    const { guild, user } = interaction;
    const [, action, mode] = interaction.customId.split(':');
    if (!guard.isMaster(guild, user.id)) return interaction.reply({ content: DENIED_MANAGE, ...EPHEMERAL });

    if (action === 'raidcfg') {
      const read = (id, min, max) => {
        const n = Number(interaction.fields.getTextInputValue(id).trim());
        return Number.isInteger(n) && n >= min && n <= max ? n : null;
      };
      const joins = read('joins', 3, 100);
      const window = read('window', 10, 600);
      const age = read('age', 0, 365);
      if (joins === null || window === null || age === null) {
        return interaction.reply({ content: '⛔ Geçersiz değer. Eşik 3–100, pencere 10–600 sn, hesap yaşı 0–365 gün olmalı.', ...EPHEMERAL });
      }
      store.set(guild.id, 'raidJoins', joins);
      store.set(guild.id, 'raidWindowSec', window);
      store.set(guild.id, 'minAccountAgeDays', age);
      await guard.sendLog(
        guild,
        logEmbed('warn', '⚙️ Raid Eşikleri Değişti', [`${window} sn / ${joins} katılım · hesap yaşı ≥ ${age} gün`, `**Yetkili:** <@${user.id}>`]),
      );
      return finish(interaction, settingsView(guild, ctx));
    }

    if (action !== 'pw' || (mode !== 'on' && mode !== 'off') || !config.lockdownPassword) return;
    if (!passwordMatches(interaction.fields.getTextInputValue('password'), config.lockdownPassword)) {
      await guard.sendLog(guild, logEmbed('warn', '🔑 Hatalı Lockdown Şifresi', [`**Deneyen:** <@${user.id}> (\`${user.id}\`)`]));
      return interaction.reply({ content: '⛔ Şifre hatalı. Deneme loglandı.', ...EPHEMERAL });
    }
    return dispatch(interaction, 'lock', { mode });
  }

  return async function handle(interaction) {
    if (!interaction.inCachedGuild()) return;
    try {
      if (interaction.isChatInputCommand() && interaction.commandName === 'guard') return await onCommand(interaction);
      if (!interaction.customId?.startsWith('sg:')) return;
      if (interaction.isButton() || interaction.isChannelSelectMenu()) return await onComponent(interaction);
      if (interaction.isModalSubmit()) return await onModal(interaction);
    } catch (e) {
      console.error('[interaction]', e);
      const msg = { content: '❌ İşlem sırasında beklenmeyen bir hata oluştu.', ...EPHEMERAL };
      await (interaction.replied || interaction.deferred ? interaction.followUp(msg) : interaction.reply(msg)).catch(() => {});
    }
  };
}
