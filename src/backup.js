// Kanal ve rollerin sürekli anlık görüntüsü + silinenlerin geri yüklenmesi.
// Görüntüler gateway olaylarıyla güncel tutulur; silinen bir nesnenin son hali saklanır.
import { ChannelType } from 'discord.js';

const RESTORE_WINDOW_MS = 24 * 3_600_000;
const MAX_ROLE_MEMBERS = 1000;
const CREATABLE = new Set([
  ChannelType.GuildText,
  ChannelType.GuildVoice,
  ChannelType.GuildCategory,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildStageVoice,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
]);

const channelData = (c) => ({
  name: c.name,
  type: c.type,
  parentId: c.parentId ?? null,
  position: c.rawPosition ?? 0,
  topic: c.topic ?? null,
  nsfw: c.nsfw ?? false,
  rateLimitPerUser: c.rateLimitPerUser ?? 0,
  bitrate: c.bitrate ?? null,
  userLimit: c.userLimit ?? null,
  overwrites: c.permissionOverwrites.cache.map((o) => ({
    id: o.id,
    type: o.type,
    allow: o.allow.bitfield.toString(),
    deny: o.deny.bitfield.toString(),
  })),
});

const roleData = (r) => ({
  name: r.name,
  color: r.color,
  hoist: r.hoist,
  mentionable: r.mentionable,
  permissions: r.permissions.bitfield.toString(),
  position: r.position,
});

export function createBackup({ store }) {
  const snapChannel = (c) => {
    if (c.guild && !c.isThread() && c.permissionOverwrites) store.upsertSnapshot(c.guild.id, 'channel', c.id, channelData(c));
  };
  const snapRole = (r) => {
    if (!r.managed && r.id !== r.guild.id) store.upsertSnapshot(r.guild.id, 'role', r.id, roleData(r));
  };

  /** Açılışta tam eşitleme; bot kapalıyken silinenler "silindi" olarak işaretlenir. */
  function syncGuild(guild) {
    for (const c of guild.channels.cache.values()) snapChannel(c);
    for (const r of guild.roles.cache.values()) snapRole(r);
    for (const id of store.liveSnapshotIds(guild.id, 'channel')) if (!guild.channels.cache.has(id)) store.markDeleted(guild.id, 'channel', id);
    for (const id of store.liveSnapshotIds(guild.id, 'role')) if (!guild.roles.cache.has(id)) store.markDeleted(guild.id, 'role', id);
  }

  function onChannelDelete(c) {
    if (c.guild) store.markDeleted(c.guild.id, 'channel', c.id);
  }

  /** Rol silinince o role sahip üyeleri de kaydet (geri yüklemede rol yeniden dağıtılır). */
  function onRoleDelete(role) {
    const members = [];
    for (const m of role.guild.members.cache.values()) {
      if (m._roles?.includes(role.id)) members.push(m.id);
      if (members.length >= MAX_ROLE_MEMBERS) break;
    }
    store.patchSnapshot(role.guild.id, 'role', role.id, { members });
    store.markDeleted(role.guild.id, 'role', role.id);
  }

  const restorableCount = (guildId, by) => store.countRestorable(guildId, by, Date.now() - RESTORE_WINDOW_MS);

  /** Belirli bir kullanıcının son 24 saatte sildiği kanal ve rolleri yeniden oluşturur. */
  async function restoreDeletedBy(guild, by) {
    const rows = store.listRestorable(guild.id, by, Date.now() - RESTORE_WINDOW_MS);
    const reason = `SentinelGuard: ${by} tarafından silinenlerin geri yüklenmesi`;
    const idmap = store.restoredMap(guild.id); // eski kimlik -> yeni kimlik
    const res = { roles: 0, channels: 0, failed: 0, members: 0 };
    const topPos = guild.members.me?.roles.highest.position ?? 1;

    // 1) Roller (alttan üste), 2) kategoriler, 3) diğer kanallar
    const roles = rows.filter((r) => r.kind === 'role').sort((a, b) => a.data.position - b.data.position);
    for (const { id, data } of roles) {
      try {
        const role = await guild.roles.create({
          name: data.name,
          color: data.color,
          hoist: data.hoist,
          mentionable: data.mentionable,
          permissions: BigInt(data.permissions),
          position: Math.max(1, Math.min(data.position, topPos - 1)),
          reason,
        });
        store.setRestored(guild.id, 'role', id, role.id);
        idmap.set(id, role.id);
        res.roles++;
        const members = data.members ?? [];
        res.members += members.length;
        // Üyelere rolün yeniden verilmesi uzun sürebilir; arka planda yürür.
        (async () => {
          for (const uid of members) await guild.members.addRole({ user: uid, role: role.id, reason }).catch(() => {});
        })();
      } catch (e) {
        console.error(`[restore] rol ${data.name}: ${e.message}`);
        res.failed++;
      }
    }

    const channels = rows
      .filter((r) => r.kind === 'channel')
      .sort(
        (a, b) =>
          (b.data.type === ChannelType.GuildCategory) - (a.data.type === ChannelType.GuildCategory) || a.data.position - b.data.position,
      );
    for (const { id, data } of channels) {
      try {
        if (!CREATABLE.has(data.type)) throw new Error('bu kanal türü yeniden oluşturulamaz');
        const parent = data.parentId && (idmap.get(data.parentId) ?? data.parentId);
        const ch = await guild.channels.create({
          name: data.name,
          type: data.type,
          parent: parent && guild.channels.cache.has(parent) ? parent : undefined,
          topic: data.topic ?? undefined,
          nsfw: data.nsfw,
          rateLimitPerUser: data.rateLimitPerUser || undefined,
          bitrate: data.bitrate ? Math.min(data.bitrate, guild.maximumBitrate ?? data.bitrate) : undefined,
          userLimit: data.userLimit ?? undefined,
          position: data.position,
          permissionOverwrites: data.overwrites
            .map((o) => ({ id: idmap.get(o.id) ?? o.id, type: o.type, allow: BigInt(o.allow), deny: BigInt(o.deny) }))
            .filter((o) => o.type === 1 || guild.roles.cache.has(o.id)),
          reason,
        });
        store.setRestored(guild.id, 'channel', id, ch.id);
        idmap.set(id, ch.id);
        res.channels++;
      } catch (e) {
        console.error(`[restore] kanal ${data.name}: ${e.message}`);
        res.failed++;
      }
    }
    return res;
  }

  return { snapChannel, snapRole, syncGuild, onChannelDelete, onRoleDelete, restorableCount, restoreDeletedBy };
}
