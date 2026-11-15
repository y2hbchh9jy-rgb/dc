// Acil Durum Kilidi: tüm kanallarda @everyone için Kanalı Gör + Mesaj Gönder reddedilir.
// Önceki izin durumu saklanır ve kilit kaldırılınca birebir geri yüklenir.
import { PermissionFlagsBits } from 'discord.js';

const { ViewChannel, SendMessages } = PermissionFlagsBits;
const CONCURRENCY = 4;

const stateOf = (ow, bit) => (ow?.allow.has(bit) ? 1 : ow?.deny.has(bit) ? -1 : 0);
const toValue = (s) => (s === 1 ? true : s === -1 ? false : null);

async function pool(items, worker) {
  let ok = 0;
  const failedItems = [];
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        try {
          await worker(item);
          ok++;
        } catch (e) {
          if (process.env.SG_DEBUG) console.error('[lockdown]', e);
          failedItems.push(item);
        }
      }
    }),
  );
  return { ok, failed: failedItems.length, failedItems };
}

const inProgress = new Set();

export function isLocked(store, guildId) {
  return Boolean(store.get(guildId, 'lockdown'));
}

export async function enableLockdown(guild, store, { by, reason }) {
  if (isLocked(store, guild.id)) return { already: true, ok: 0, failed: 0 };
  if (inProgress.has(guild.id)) return { busy: true, ok: 0, failed: 0 };
  inProgress.add(guild.id);
  try {
    const channels = [...guild.channels.cache.values()].filter((c) => !c.isThread() && c.permissionOverwrites);
    const snapshot = {};
    for (const c of channels) {
      const ow = c.permissionOverwrites.cache.get(guild.id);
      snapshot[c.id] = [stateOf(ow, ViewChannel), stateOf(ow, SendMessages)];
    }
    // Düzenlemelerden ÖNCE kaydet: bot yarıda çökse bile geri yükleme mümkün olsun.
    store.set(guild.id, 'lockdown', { at: Date.now(), by, snapshot });
    const audit = `SentinelGuard Lockdown: ${reason}`.slice(0, 500);
    return await pool(channels, (c) =>
      c.permissionOverwrites.edit(guild.id, { ViewChannel: false, SendMessages: false }, { reason: audit }),
    );
  } finally {
    inProgress.delete(guild.id);
  }
}

export async function disableLockdown(guild, store, { reason }) {
  const state = store.get(guild.id, 'lockdown');
  if (!state) return { already: true, ok: 0, failed: 0 };
  if (inProgress.has(guild.id)) return { busy: true, ok: 0, failed: 0 };
  inProgress.add(guild.id);
  try {
    const audit = `SentinelGuard Lockdown kaldırıldı: ${reason}`.slice(0, 500);
    const entries = Object.entries(state.snapshot).filter(([id]) => guild.channels.cache.has(id));
    const res = await pool(entries, ([id, [view, send]]) =>
      guild.channels.cache
        .get(id)
        .permissionOverwrites.edit(guild.id, { ViewChannel: toValue(view), SendMessages: toValue(send) }, { reason: audit }),
    );
    // Geri yüklenemeyen kanallar kayıtta kalır; kilit "aktif" görünür ve tekrar denenebilir.
    store.set(guild.id, 'lockdown', res.failed ? { ...state, snapshot: Object.fromEntries(res.failedItems) } : null);
    return res;
  } finally {
    inProgress.delete(guild.id);
  }
}
