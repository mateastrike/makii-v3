const fs = require('fs');
const { Client, GatewayIntentBits, Partials, PermissionsBitField, ChannelType, EmbedBuilder, Events } = require('discord.js');

const config = require('./config.json');
const prefix = config.prefix || '.';
const modRoleId = config.modRoleId || null;
const requireModRoleOnly = !!config.requireModRoleOnly;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction]
});

// Autorole memorija
let autoroles = []; // { messageId, emoji, roleId }

client.once('ready', () => {
  console.log(`${client.user.tag} je online.`);
});

// --- Provera permisija ---
function hasDiscordPerms(member) {
  return member.permissions.has(PermissionsBitField.Flags.BanMembers) ||
         member.permissions.has(PermissionsBitField.Flags.KickMembers) ||
         member.permissions.has(PermissionsBitField.Flags.ManageRoles) ||
         member.permissions.has(PermissionsBitField.Flags.ModerateMembers);
}

function hasModPerms(member) {
  if (requireModRoleOnly) {
    return modRoleId ? member.roles.cache.has(modRoleId) : false;
  }
  return modRoleId && member.roles.cache.has(modRoleId) ? true : hasDiscordPerms(member);
}

// --- Muted role ---
async function ensureMutedRole(guild) {
  let role = guild.roles.cache.find(r => r.name === 'Muted');
  if (role) return role;
  try {
    role = await guild.roles.create({ name: 'Muted', reason: 'Needed for mute command' });
    for (const [, channel] of guild.channels.cache) {
      try {
        await channel.permissionOverwrites.edit(role, {
          SendMessages: false,
          AddReactions: false,
          Speak: false,
        });
      } catch {}
    }
    return role;
  } catch (err) {
    console.error('Failed creating Muted role:', err);
    return null;
  }
}

// --- Fancy Welcome Embed ---
client.on(Events.GuildMemberAdd, async (member) => {
  const welcomeChannelId = config.welcomeChannelId; // Dodaj u config.json
  if (!welcomeChannelId) return;

  const channel = member.guild.channels.cache.get(welcomeChannelId);
  if (!channel || channel.type !== ChannelType.GuildText) return;

  const embed = new EmbedBuilder()
    .setTitle('🎉 Dobrodošli na Balkan Mods™ 🎉')
    .setDescription(`Pozdrav, <@${member.id}>! Dobrodošli na naš server.\n\nPročitajte pravila i uživajte u zajednici! Molimo vas da poštujete pravila servera i ponašate se primjereno. Ako imate pitanja ili trebate pomoć, otvorite ticket!`)
    .setColor('Blue')
    .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
    .setFooter({ text: `Član od: ${member.joinedAt?.toLocaleDateString() || 'Nepoznat datum'}` });

  channel.send({ embeds: [embed] });
});

// --- Komande ---
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild || !message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const cmd = args.shift().toLowerCase();

  if (!hasModPerms(message.member)) return message.reply('Nemate dozvolu za ovu komandu.');

  // ----- KICK -----
  if (cmd === 'kick') {
    const target = message.mentions.members.first();
    const reason = args.slice(1).join(' ') || 'Nema razloga';
    if (!target) return message.reply('Oznaci korisnika kojeg zelis kick-ovati: `.kick @user razlog`');
    if (!target.kickable) return message.reply('Ne mogu kick-ovati tog korisnika.');
    await target.kick(reason).catch(console.error);
    return message.reply(`Korisnik ${target} (${target.id}) je kick-ovan sa servera.\nRazlog: ${reason}`);
  }

  // ----- BAN -----
  if (cmd === 'ban') {
    const target = message.mentions.members.first();
    let deleteDays = 0;
    if (args[0] && !isNaN(parseInt(args[0], 10))) deleteDays = Math.min(parseInt(args.shift(), 10), 7);
    const reason = args.join(' ') || 'Nema razloga';
    if (!target) return message.reply('Oznaci korisnika kojeg zelis ban-ovati: `.ban @user [deleteDays] razlog`');
    if (!target.bannable) return message.reply('Ne mogu ban-ovati tog korisnika.');
    await target.ban({ days: deleteDays, reason }).catch(console.error);
    return message.reply(`Korisnik ${target} (${target.id}) je banovan sa Discorda.\nRazlog: ${reason}`);
  }

  // ----- UNBAN -----
  if (cmd === 'unban') {
    const id = args[0];
    if (!id) return message.reply('Navedi ID korisnika kojeg zelis unban-ovati: `.unban USER_ID`');
    const bans = await message.guild.bans.fetch();
    const found = bans.find(b => b.user.id === id || b.user.tag === id);
    if (!found) return message.reply('Taj korisnik nije banovan ili ID/tag nije tacan.');
    await message.guild.members.unban(found.user.id).catch(console.error);
    return message.reply(`Korisnik <@${found.user.id}> (${found.user.id}) je unban-ovan.`);
  }

  // ----- MUTE -----
  if (cmd === 'mute') {
    const target = message.mentions.members.first();
    if (!target) return message.reply('Oznaci korisnika kojeg zelis mute-ovati: `.mute @user [minutes] [razlog]`');

    let durationMin = parseInt(args[0], 10);
    if (isNaN(durationMin) || durationMin <= 0) durationMin = 10; 
    const reason = args.slice(1).join(' ') || 'Nema razloga';

    try {
      await target.timeout(durationMin * 60 * 1000, `Muted by ${message.author.tag} | Razlog: ${reason}`);
      return message.reply(`Korisnik ${target} (${target.id}) je muted na ${durationMin} minuta.\nRazlog: ${reason}`);
    } catch {
      const role = await ensureMutedRole(message.guild);
      await target.roles.add(role, `Muted by ${message.author.tag} | Razlog: ${reason}`).catch(console.error);
      return message.reply(`Korisnik ${target} (${target.id}) je muted (role) na ${durationMin} minuta.\nRazlog: ${reason}`);
    }
  }

  // ----- UNMUTE -----
  if (cmd === 'unmute') {
    const target = message.mentions.members.first();
    if (!target) return message.reply('Oznaci korisnika kojeg zelis unmute-ovati: `.unmute @user`');
    await target.timeout(null, `Unmuted by ${message.author.tag}`).catch(() => null);
    const role = message.guild.roles.cache.find(r => r.name === 'Muted');
    if (role && target.roles.cache.has(role.id)) await target.roles.remove(role, `Unmuted by ${message.author.tag}`).catch(console.error);
    return message.reply(`Korisnik ${target} (${target.id}) je unmuted.`);
  }

  // ----- SAY -----
  if (cmd === 'say') {
    message.reply('Unesi **ID kanala** gde zelis da posaljem poruku.').then(() => {
      const filter = m => m.author.id === message.author.id;
      message.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] })
        .then(async collected => {
          const channelId = collected.first().content.trim();
          try {
            const targetChannel = await message.guild.channels.fetch(channelId);
            if (!targetChannel || targetChannel.type !== ChannelType.GuildText) 
              return message.reply('Nevalidan ID kanala.');
            message.reply('Unesi **poruku** koju zelis da bot posalje.').then(() => {
              message.channel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] })
                .then(collectedMsg => {
                  const text = collectedMsg.first().content;
                  targetChannel.send(text).catch(console.error);
                  message.reply(`Poruka je poslana u <#${channelId}>.`);
                })
                .catch(() => message.reply('Nisi napisao poruku na vreme.'));
            });
          } catch {
            return message.reply('Nevalidan ID kanala.');
          }
        })
        .catch(() => message.reply('Nisi unio ID kanala na vreme.'));
    });
    return;
  }

  // ----- AUTOROLE -----
  if (cmd === 'autorole') {
    const channel = message.mentions.channels.first();
    if (!channel) return message.reply('Oznaci kanal: `.autorole #kanal emoji1 @role1 emoji2 @role2 ...`');
    const roles = Array.from(message.mentions.roles.values());
    if (roles.length === 0) return message.reply('Morate oznaciti barem jedan role.');
    args.shift(); // ukloni kanal
    if (args.length < 2 || args.length / 2 !== roles.length) return message.reply('Morate uneti parove emoji + role.');
    const embed = new EmbedBuilder().setTitle('🎮 Uzmi svoj rol!').setColor('Blue');
    const addedReactions = [];
    for (let i = 0; i < roles.length; i++) {
      const emoji = args[i * 2];
      const role = roles[i];
      embed.addFields({ name: emoji, value: `<@&${role.id}>`, inline: true });
      addedReactions.push({ emoji, roleId: role.id });
    }
    const msg = await channel.send({ embeds: [embed] });
    for (const r of addedReactions) await msg.react(r.emoji);
    autoroles.push(...addedReactions.map(r => ({ messageId: msg.id, ...r })));
    return message.reply('Autorole postavljen!');
  }
});

// --- Autorole reakcije ---
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) await reaction.fetch();
  const data = autoroles.find(r => r.messageId === reaction.message.id && r.emoji === reaction.emoji.name);
  if (!data) return;
  const member = reaction.message.guild.members.cache.get(user.id);
  if (!member) return;
  await member.roles.add(data.roleId).catch(console.error);
});

client.on(Events.MessageReactionRemove, async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) await reaction.fetch();
  const data = autoroles.find(r => r.messageId === reaction.message.id && r.emoji === reaction.emoji.name);
  if (!data) return;
  const member = reaction.message.guild.members.cache.get(user.id);
  if (!member) return;
  await member.roles.remove(data.roleId).catch(console.error);
});

// --- Login ---
client.login(process.env.TOKEN || config.token);
