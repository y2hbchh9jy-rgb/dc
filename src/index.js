import { Client, Events, GatewayIntentBits } from 'discord.js';
import { createBackup } from './backup.js';
import { config } from './config.js';
import { SlidingWindowCounter } from './counter.js';
import { createGuard } from './guard.js';
import { commands, createInteractionHandler } from './interactions.js';
import { createRaid } from './raid.js';
import { Store } from './store.js';

if (!config.token) {
  console.error('DISCORD_TOKEN tanımlı değil. .env.example dosyasını .env olarak kopyalayıp doldurun.');
  process.exit(1);
}
if (!config.masterAdmins.size) {
  console.warn("UYARI: MASTER_ADMINS boş — whitelist'i yalnızca sunucu sahibi yönetebilir.");
}

const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildModeration];
if (config.membersIntent) intents.push(GatewayIntentBits.GuildMembers);
else console.warn('UYARI: MEMBERS_INTENT kapalı — raid koruması ve silinen rollerin üyelere geri verilmesi çalışmaz.');

const client = new Client({ intents });
const store = new Store(config.dataFile);
const counter = new SlidingWindowCounter(config.breakerWindowMs);
const backup = createBackup({ store });
const guard = createGuard({ client, store, counter, config, backup });
const raid = createRaid({ store, guard });
const handleInteraction = createInteractionHandler({ client, store, counter, config, guard, backup, raid });

const safe =
  (label, fn) =>
  (...args) => {
    try {
      Promise.resolve(fn(...args)).catch((e) => console.error(`[${label}]`, e));
    } catch (e) {
      console.error(`[${label}]`, e);
    }
  };

/** Sunucu hazırlığı: üye önbelleği, anlık görüntü, kaçan kayıtların telafisi, sağlık. */
async function prepareGuild(guild) {
  if (config.membersIntent) await guild.members.fetch().catch((e) => console.error(`[members] ${guild.id}: ${e.message}`));
  backup.syncGuild(guild);
  await guard.catchUp(guild).catch((e) => console.error(`[catchup] ${guild.id}: ${e.message}`));
  await guard.checkHealth(guild);
  if (store.get(guild.id, 'monitor')) console.warn(`UYARI: ${guild.name} İZLEME MODUNDA — ceza verilmiyor (/guard panel → Ayarlar).`);
}

client.once(Events.ClientReady, async (c) => {
  console.log(`SentinelGuard v3.0 hazır: ${c.user.tag} · ${c.guilds.cache.size} sunucu`);
  try {
    if (config.devGuildId) await c.application.commands.set(commands, config.devGuildId);
    else await c.application.commands.set(commands);
    console.log(`/guard komutu kaydedildi (${config.devGuildId ? 'sunucu' : 'global'}).`);
  } catch (e) {
    console.error('Komut kaydı başarısız:', e);
  }
  for (const guild of c.guilds.cache.values()) await prepareGuild(guild).catch((e) => console.error('[prepare]', e));

  const guilds = () => [...c.guilds.cache.values()];
  setInterval(safe('raid', () => raid.tick(guilds())), 30_000).unref();
  setInterval(safe('health', () => Promise.all(guilds().map((g) => guard.checkHealth(g)))), 5 * 60_000).unref();
  setInterval(
    safe('report', async () => {
      store.prune();
      for (const g of guilds()) await guard.weeklyReport(g);
    }),
    3_600_000,
  ).unref();
  await raid.tick(guilds());
  for (const g of guilds()) await guard.weeklyReport(g);
});

// Gateway oturumu sürdürülemeyip yeniden kurulduysa aradaki kayıtları telafi et.
client.on(
  Events.ShardReady,
  safe('reconnect', async () => {
    if (!client.isReady()) return;
    for (const guild of client.guilds.cache.values()) await guard.catchUp(guild).catch(() => {});
  }),
);

client.on(Events.GuildAuditLogEntryCreate, safe('guard', (entry, guild) => guard.handleAuditEntry(entry, guild)));
client.on(Events.InteractionCreate, handleInteraction);
client.on(Events.GuildMemberAdd, safe('raid', (member) => raid.onJoin(member)));

// Anlık görüntüler
client.on(Events.ChannelCreate, safe('backup', (c) => backup.snapChannel(c)));
client.on(Events.ChannelUpdate, safe('backup', (_old, c) => backup.snapChannel(c)));
client.on(Events.ChannelDelete, safe('backup', (c) => backup.onChannelDelete(c)));
client.on(Events.GuildRoleCreate, safe('backup', (r) => backup.snapRole(r)));
client.on(Events.GuildRoleDelete, safe('backup', (r) => backup.onRoleDelete(r)));
client.on(
  Events.GuildRoleUpdate,
  safe('backup', (_old, r) => {
    backup.snapRole(r);
    guard.scheduleHealthCheck(r.guild); // rol sırası / izin değişimi botu etkilemiş olabilir
  }),
);

// Botun kendini koruması
client.on(
  Events.GuildMemberUpdate,
  safe('health', (_old, m) => {
    if (m.id === client.user.id) guard.scheduleHealthCheck(m.guild);
  }),
);
client.on(Events.GuildCreate, safe('prepare', (guild) => prepareGuild(guild)));
client.on(
  Events.GuildDelete,
  safe('removed', (guild) => {
    if (guild.available !== false) return guard.onRemoved(guild);
  }),
);
client.on(Events.Error, (e) => console.error('[client]', e));

// Bot asla çökmemeli: beklenmeyen hatalar loglanır, süreç ayakta kalır.
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    client.destroy();
    process.exit(0);
  });
}

client.login(config.token).catch((e) => {
  console.error(`Discord girişi başarısız: ${e.message}`);
  process.exit(1);
});
