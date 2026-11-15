// Tüm embed ve bileşen (buton / menü / modal) tasarımları. Koyu, minimalist tema.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { isLocked } from './lockdown.js';
import { SCOPES } from './store.js';

const COLORS = { base: 0x2b2d31, info: 0x1f2a44, warn: 0x8a6d1a, critical: 0x7a1f1f, ok: 0x1f4d3a };
const FOOTER = { text: 'SentinelGuard v3.0' };
const PAGE_SIZE = 10;

const embed = (color, title) => new EmbedBuilder().setColor(color).setTitle(title.slice(0, 256)).setFooter(FOOTER).setTimestamp();
const ts = (ms) => `<t:${Math.floor(ms / 1000)}:R>`;
const btn = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const row = (...components) => new ActionRowBuilder().addComponents(...components);
const backRow = () => row(btn('sg:panel', '◀ Panele Dön'));
const onOff = (v) => (v ? '🟢 Açık' : '⚫ Kapalı');

export function logEmbed(level, title, lines) {
  return embed(COLORS[level] ?? COLORS.base, title).setDescription(lines.filter(Boolean).join('\n').slice(0, 4000));
}

export function notice(level, title, text) {
  return { embeds: [embed(COLORS[level] ?? COLORS.base, title).setDescription(text)], components: [backRow()] };
}

/** Log mesajlarının altındaki karar butonları. */
export function actionRow({ uid, kind = null, restorable = false, monitor = false }) {
  const b = [];
  if (monitor) b.push(btn(`sg:act:wl:${uid}`, "➕ Whitelist'e Ekle"));
  if (kind === 'quarantine') b.push(btn(`sg:act:forgive:${uid}`, '✅ Affet', ButtonStyle.Success), btn(`sg:act:ban:${uid}`, '🔨 Banla', ButtonStyle.Danger));
  if (kind === 'ban') b.push(btn(`sg:act:unban:${uid}`, '↩️ Banı Kaldır'));
  if (restorable) b.push(btn(`sg:act:restore:${uid}`, '♻️ Silinenleri Geri Yükle', ButtonStyle.Primary));
  return b.length ? [row(...b)] : [];
}

export const raidRow = () => [row(btn('sg:act:raidend:0', '✅ Raid Modunu Bitir', ButtonStyle.Success))];

function uptime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 86400)}g ${Math.floor((s % 86400) / 3600)}s ${Math.floor((s % 3600) / 60)}d`;
}

export function panelView(guild, { client, store, counter, config, guard }) {
  const s = store.settings(guild.id);
  const locked = isLocked(store, guild.id);
  const h = guard.health(guild);
  const last = store.recentIncidents(guild.id, 1)[0];
  const status = [
    s.monitor
      ? '👁️ **İZLEME MODU** — ihlaller yalnızca loglanıyor, **ceza verilmiyor**. Korumayı ⚙️ Ayarlar\'dan etkinleştirin.'
      : '🟢 **Koruma aktif**',
    locked ? `🔒 **SUNUCU KİLİTLİ** — ${ts(s.lockdown.at)} <@${s.lockdown.by}> tarafından` : null,
    s.raidState ? `🚨 **RAID MODU** — ${ts(s.raidState.since)} başladı, ${s.raidState.kicked} hesap atıldı` : null,
  ];

  const e = embed(locked || s.raidState ? COLORS.critical : s.monitor ? COLORS.warn : COLORS.base, '🛡️ SentinelGuard — Güvenlik Paneli')
    .setDescription(status.filter(Boolean).join('\n'))
    .addFields(
      { name: 'Whitelist', value: `\`${store.listWhitelist(guild.id).length}\` kişi`, inline: true },
      { name: 'Master Admin', value: `\`${guard.masterIds(guild).size}\` kişi`, inline: true },
      { name: 'Log Kanalı', value: s.logChannelId ? `<#${s.logChannelId}>` : '⚠️ Ayarlanmadı', inline: true },
      {
        name: 'Devre Kesici',
        value: `\`${Math.round(config.breakerWindowMs / 60_000)} dk\` · silme \`${config.breakerLimit}\` · ban/kick \`${config.memberBreakerLimit}\``,
        inline: true,
      },
      { name: 'Raid Koruması', value: s.raid ? `\`${s.raidJoins}\` katılım / \`${s.raidWindowSec} sn\`` : '⚫ Kapalı', inline: true },
      { name: 'Son Olay', value: last ? `${last.type.slice(0, 60)} · ${ts(last.t)}` : 'Kayıt yok', inline: true },
      {
        name: 'Sistem Sağlığı',
        value: [
          `Gecikme \`${Math.max(0, Math.round(client.ws.ping))} ms\` · Çalışma \`${uptime(client.uptime ?? 0)}\` · Bellek \`${Math.round(process.memoryUsage().rss / 1048576)} MB\` · Sayaç \`${counter.size}\``,
          h?.admin ? '✅ Bot yetkileri tam (Yönetici)' : '❌ Botta **Yönetici** yetkisi yok — koruma ve kilit güvenilir çalışmaz',
          h?.above ? `⚠️ Botun rolünün üstünde **${h.above}** yetkili rol var — bu rollerdekiler banlanamaz` : '✅ Bot rolü en üstte',
        ].join('\n'),
      },
    );

  const buttons = row(
    btn('sg:wl:0', '🛡️ Whitelist'),
    btn('sg:logs', '📊 Loglar'),
    locked ? btn('sg:lock', '🔓 Kilidi Kaldır', ButtonStyle.Success) : btn('sg:lock', '🚨 Acil Kilit', ButtonStyle.Danger),
    btn('sg:reset', '🔄 Sıfırla'),
    btn('sg:settings', '⚙️ Ayarlar'),
  );
  const logSelect = row(
    new ChannelSelectMenuBuilder().setCustomId('sg:logch').setPlaceholder('Güvenlik log kanalını seç…').setChannelTypes(ChannelType.GuildText),
  );
  return { embeds: [e], components: [buttons, logSelect] };
}

export function settingsView(guild, { store }) {
  const s = store.settings(guild.id);
  const e = embed(COLORS.info, '⚙️ Koruma Ayarları').addFields(
    {
      name: `İzleme Modu — ${onOff(s.monitor)}`,
      value: 'Açıkken ihlaller yalnızca loglanır; ban, karantina ve geri alma **yapılmaz**. Kurulumdan sonra whitelist oturunca kapatın.',
    },
    {
      name: `Kademeli Ceza — ${onOff(s.graded)}`,
      value: 'Açıkken tekil ihlalde ban yerine **karantina** (roller sökülür, log mesajından Affet/Banla). Devre kesici her zaman banlar.',
    },
    {
      name: `Çift Onay — ${onOff(s.dual)}`,
      value: "Whitelist'e ekleme, kilidi kaldırma ve korumayı zayıflatan ayarlar için ikinci bir Master Admin onayı. Sunucu sahibi muaftır.",
    },
    {
      name: `Raid Koruması — ${onOff(s.raid)}`,
      value: `\`${s.raidWindowSec} sn\` içinde \`${s.raidJoins}\` katılım → raid modu · En az hesap yaşı: \`${s.minAccountAgeDays || 'kapalı'}\`${s.minAccountAgeDays ? ' gün' : ''}`,
    },
  );
  const toggle = (key, label, on) => btn(`sg:set:${key}`, `${label}: ${on ? 'Kapat' : 'Aç'}`, on ? ButtonStyle.Secondary : ButtonStyle.Primary);
  return {
    embeds: [e],
    components: [
      row(toggle('monitor', 'İzleme', s.monitor), toggle('graded', 'Kademeli', s.graded), toggle('dual', 'Çift Onay', s.dual), toggle('raid', 'Raid', s.raid)),
      row(btn('sg:raidcfg', '🎚️ Raid Eşikleri'), btn('sg:panel', '◀ Panele Dön')),
    ],
  };
}

export function raidModal(s) {
  const input = (id, label, value) =>
    row(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setValue(String(value)).setRequired(true).setMaxLength(4));
  return new ModalBuilder()
    .setCustomId('sg:raidcfg')
    .setTitle('Raid Eşikleri')
    .addComponents(
      input('joins', 'Katılım eşiği (3–100)', s.raidJoins),
      input('window', 'Zaman penceresi, saniye (10–600)', s.raidWindowSec),
      input('age', 'En az hesap yaşı, gün (0 = kapalı)', s.minAccountAgeDays),
    );
}

const scopeText = (scopes) => scopes.map((k) => SCOPES[k] ?? k).join(', ');

export function whitelistView(guild, { store, guard }, page = 0) {
  const list = store.listWhitelist(guild.id);
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const rows = list
    .slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE)
    .map(
      (w, i) =>
        `\`${p * PAGE_SIZE + i + 1}.\` <@${w.id}> · ${scopeText(w.scopes)} · ${w.expiresAt ? `⏳ ${ts(w.expiresAt)} biter` : 'kalıcı'} · ekleyen <@${w.addedBy}>`,
    );
  const masters = [...guard.masterIds(guild)].map((id) => `<@${id}>`).join(' ');

  const e = embed(COLORS.info, '🛡️ Whitelist — Güvenli Liste')
    .setDescription(rows.join('\n') || '*Liste boş.*')
    .addFields({ name: 'Master Adminler', value: masters.slice(0, 1024) })
    .setFooter({ text: `Sayfa ${p + 1}/${pages} · ${list.length} kayıt · SentinelGuard v3.0` });
  const nav = row(
    btn(`sg:wl:${p - 1}`, '◀').setDisabled(p === 0),
    btn(`sg:wl:${p + 1}`, '▶').setDisabled(p >= pages - 1),
    btn('sg:panel', 'Panele Dön'),
  );
  return { embeds: [e], components: [nav] };
}

export function incidentsView(guild, { store }) {
  const items = store.recentIncidents(guild.id, 5);
  const e = embed(COLORS.info, '📊 Güvenlik Logları — Son 5 Olay');
  if (!items.length) e.setDescription('*Henüz kayıtlı bir olay yok.*');
  for (const it of items) {
    e.addFields({
      name: `${it.type} · ${ts(it.t)}`.slice(0, 256),
      value:
        [
          it.executorId && `**Kullanıcı:** <@${it.executorId}> \`${it.executorId}\``,
          it.targetId && `**Hedef:** \`${it.targetId}\``,
          it.detail && `**Detay:** ${it.detail}`,
          it.result,
        ]
          .filter(Boolean)
          .join('\n')
          .slice(0, 1024) || '—',
    });
  }
  return { embeds: [e], components: [backRow()] };
}

export function confirmView(action, locked) {
  const text =
    action === 'reset'
      ? 'Bu sunucunun **devre kesici sayaçları ve işlem önbelleği** temizlenecek. Whitelist ve loglar korunur.'
      : locked
        ? 'Kilit kaldırılacak; tüm kanalların `@everyone` izinleri **kilit öncesi haline** geri yüklenecek.'
        : 'Tüm kanallarda `@everyone` için **Kanalı Gör** ve **Mesaj Gönder** izinleri kapatılacak.';
  const id = action === 'reset' ? 'sg:ok:reset' : `sg:ok:lock:${locked ? 'off' : 'on'}`;
  return {
    embeds: [embed(COLORS.warn, '⚠️ Onay Gerekli').setDescription(text)],
    components: [row(btn(id, 'Onayla', ButtonStyle.Danger), btn('sg:panel', 'Vazgeç'))],
  };
}

/** Çift onay: log kanalına düşen, ikinci Master Admin'in yanıtladığı istek. */
export function approvalMessage(id, requesterId, description) {
  return {
    embeds: [
      embed(COLORS.warn, '🔐 İkinci Onay Bekleniyor').setDescription(
        [`**İsteyen:** <@${requesterId}>`, `**İşlem:** ${description}`, '', 'Başka bir Master Admin onaylamalı. İstek 10 dakika geçerlidir.'].join('\n'),
      ),
    ],
    components: [row(btn(`sg:apr:ok:${id}`, 'Onayla', ButtonStyle.Success), btn(`sg:apr:no:${id}`, 'Reddet', ButtonStyle.Danger))],
    allowedMentions: { parse: [] },
  };
}

export function passwordModal(mode) {
  return new ModalBuilder()
    .setCustomId(`sg:pw:${mode}`)
    .setTitle('Lockdown Onayı')
    .addComponents(
      row(new TextInputBuilder().setCustomId('password').setLabel('Lockdown şifresi').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(128)),
    );
}
