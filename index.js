require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const {
  entersState,
  generateDependencyReport,
  joinVoiceChannel,
  VoiceConnectionStatus,
} = require("@discordjs/voice");
const {
  ChannelType,
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  SlashCommandBuilder,
} = require("discord.js");
const {
  DISCORD_TOKEN,
  GUILD_ID,
  DUCK_ROLE_ID,
  SOUNDBOARD_COMMAND_ROLE_ID,
  COUNTER_CHANNEL_ID,
  SOUNDBOARD_SOUND_ID,
  SOUNDBOARD_SOURCE_GUILD_ID,
} = process.env;

for (const [name, value] of Object.entries({
  DISCORD_TOKEN,
  GUILD_ID,
  DUCK_ROLE_ID,
  SOUNDBOARD_COMMAND_ROLE_ID,
  COUNTER_CHANNEL_ID,
  SOUNDBOARD_SOUND_ID,
})) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

if (!/^\d+$/.test(SOUNDBOARD_SOUND_ID)) {
  throw new Error("SOUNDBOARD_SOUND_ID must be the numeric ID of a Discord Soundboard sound.");
}
if (!/^\d+$/.test(SOUNDBOARD_COMMAND_ROLE_ID)) {
  throw new Error("SOUNDBOARD_COMMAND_ROLE_ID must be the numeric ID of a Discord role.");
}
if (SOUNDBOARD_SOURCE_GUILD_ID && !/^\d+$/.test(SOUNDBOARD_SOURCE_GUILD_ID)) {
  throw new Error("SOUNDBOARD_SOURCE_GUILD_ID must be the numeric ID of the server that owns the sound.");
}

const COUNTER_PREFIX = "🐣 Duck role count:";
const SOUND_SETTINGS_PATH = path.join(__dirname, "soundboard-settings.json");
const SOUNDBOARD_COMMANDS = [
  new SlashCommandBuilder()
    .setName("soundboard-on")
    .setDescription("Enable automatic Soundboard sounds when Duck-role members join voice."),
  new SlashCommandBuilder()
    .setName("soundboard-off")
    .setDescription("Disable automatic Soundboard sounds when Duck-role members join voice."),
  new SlashCommandBuilder()
    .setName("soundboard-test")
    .setDescription("Play the configured Soundboard sound in your current voice channel."),
];
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

let memberCount;
let counterMessage;
let updateTimeout;
let queuedEdits = Promise.resolve();
let queuedDuckSounds = Promise.resolve();
let soundboardEnabled = loadSoundboardSetting();

function loadSoundboardSetting() {
  if (!fs.existsSync(SOUND_SETTINGS_PATH)) {
    return true;
  }

  const settings = JSON.parse(fs.readFileSync(SOUND_SETTINGS_PATH, "utf8"));
  if (typeof settings.enabled !== "boolean") {
    throw new Error(`Invalid enabled setting in ${SOUND_SETTINGS_PATH}.`);
  }
  return settings.enabled;
}

function saveSoundboardSetting(enabled) {
  fs.writeFileSync(SOUND_SETTINGS_PATH, JSON.stringify({ enabled }, null, 2));
}

function queueSoundboardPlayback(playback) {
  const result = queuedDuckSounds.then(playback);
  queuedDuckSounds = result.catch(() => {});
  return result;
}

async function registerSoundboardCommands(guild) {
  const existingCommands = await guild.commands.fetch();

  for (const command of SOUNDBOARD_COMMANDS) {
    const data = command.toJSON();
    const existing = existingCommands.find((item) => item.name === data.name);
    if (existing) {
      await guild.commands.edit(existing.id, data);
    } else {
      await guild.commands.create(data);
    }
  }
}

function queueCounterUpdate(change) {
  if (memberCount === undefined) {
    return;
  }

  memberCount += change;
  clearTimeout(updateTimeout);
  updateTimeout = setTimeout(() => {
    if (!counterMessage) {
      return;
    }

    queuedEdits = queuedEdits
      .then(() => counterMessage.edit(`${COUNTER_PREFIX} ${memberCount}`))
      .catch((error) => {
        console.error("Could not update the Duck-role counter message:", error);
      });
  }, 1000);
}

function hasDuckRole(member) {
  return member.roles.cache.has(DUCK_ROLE_ID);
}

async function repostCounter(channel) {
  if (channel.type !== ChannelType.GuildText) {
    console.error(`Could not repost the counter: channel ${COUNTER_CHANNEL_ID} is not a text channel.`);
    return;
  }

  try {
    counterMessage = await channel.send(`${COUNTER_PREFIX} ${memberCount}`);
    console.log(`The deleted Duck-role counter was reposted in channel ${COUNTER_CHANNEL_ID}.`);
  } catch (error) {
    console.error("Could not repost the deleted Duck-role counter message:", error);
  }
}

async function playSoundboardSound(channel) {
  const botMember = channel.guild.members.me;
  if (!botMember) {
    throw new Error("Could not find the bot's server member to check voice permissions.");
  }

  const permissions = channel.permissionsFor(botMember);
  const requiredPermissions = [
    ["Connect", PermissionsBitField.Flags.Connect],
    ["Speak", PermissionsBitField.Flags.Speak],
    ["Use Soundboard", PermissionsBitField.Flags.UseSoundboard],
  ];
  if (SOUNDBOARD_SOURCE_GUILD_ID && SOUNDBOARD_SOURCE_GUILD_ID !== channel.guild.id) {
    requiredPermissions.push([
      "Use External Sounds",
      PermissionsBitField.Flags.UseExternalSounds,
    ]);
  }
  const missingPermissions = requiredPermissions
    .filter(([, permission]) => !permissions?.has(permission))
    .map(([name]) => name);
  if (missingPermissions.length > 0) {
    throw new Error(
      `The bot is missing voice channel permissions: ${missingPermissions.join(", ")}.`,
    );
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });
  connection.on("stateChange", (oldState, newState) => {
    console.log(`Soundboard voice connection: ${oldState.status} -> ${newState.status}.`);
  });
  connection.on("error", (error) => {
    console.error("Soundboard voice connection error:", error);
  });

  try {
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (error) {
      throw new Error(
        `Voice connection did not become ready within 20 seconds (status: ${connection.state.status}). Check the bot's Connect permission and network access.`,
        { cause: error },
      );
    }

    const body = { sound_id: SOUNDBOARD_SOUND_ID };
    if (SOUNDBOARD_SOURCE_GUILD_ID) {
      body.source_guild_id = SOUNDBOARD_SOURCE_GUILD_ID;
    }

    try {
      await client.rest.post(`/channels/${channel.id}/send-soundboard-sound`, { body });
    } catch (error) {
      if (error.code === 50013) {
        throw new Error(
          "Discord denied Soundboard playback. Verify Use Soundboard and Speak permissions, and Use External Sounds for sounds from another server.",
          { cause: error },
        );
      }
      if (error.code === 10062 || error.code === 10008) {
        throw new Error(
          `Discord could not find or use Soundboard sound ${SOUNDBOARD_SOUND_ID}. Check the sound ID and source server ID.`,
          { cause: error },
        );
      }
      throw error;
    }
    console.log(`Played Soundboard sound ${SOUNDBOARD_SOUND_ID} in voice channel ${channel.id}.`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } finally {
    connection.destroy();
  }
}

client.on("guildMemberAdd", (member) => {
  if (member.guild.id === GUILD_ID && hasDuckRole(member)) {
    queueCounterUpdate(1);
  }
});

client.on("guildMemberRemove", (member) => {
  if (member.guild.id === GUILD_ID && hasDuckRole(member)) {
    queueCounterUpdate(-1);
  }
});

client.on("guildMemberUpdate", (oldMember, newMember) => {
  if (newMember.guild.id !== GUILD_ID) {
    return;
  }

  const change = Number(hasDuckRole(newMember)) - Number(hasDuckRole(oldMember));
  if (change !== 0) {
    queueCounterUpdate(change);
  }
});

client.on("messageDelete", async (message) => {
  if (
    !counterMessage ||
    message.id !== counterMessage.id ||
    message.channelId !== COUNTER_CHANNEL_ID
  ) {
    return;
  }

  counterMessage = undefined;
  await repostCounter(message.channel);
});

client.on("messageDeleteBulk", async (messages, channel) => {
  if (
    !counterMessage ||
    channel.id !== COUNTER_CHANNEL_ID ||
    !messages.has(counterMessage.id)
  ) {
    return;
  }

  counterMessage = undefined;
  await repostCounter(channel);
});

client.on("voiceStateUpdate", (oldState, newState) => {
  const member = newState.member;
  if (
    !soundboardEnabled ||
    !member ||
    member.guild.id !== GUILD_ID ||
    member.user.bot ||
    !hasDuckRole(member) ||
    !newState.channel ||
    newState.channel.type !== ChannelType.GuildVoice ||
    oldState.channelId === newState.channelId
  ) {
    return;
  }

  queueSoundboardPlayback(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (soundboardEnabled && member.voice.channelId === newState.channelId) {
      await playSoundboardSound(newState.channel);
    }
  }).catch((error) => {
    console.error("Could not play the Duck-role Soundboard sound:", error);
  });
});

client.on("interactionCreate", async (interaction) => {
  if (
    !interaction.isChatInputCommand() ||
    !["soundboard-on", "soundboard-off", "soundboard-test"].includes(interaction.commandName)
  ) {
    return;
  }

  if (interaction.guildId !== GUILD_ID || !interaction.inGuild()) {
    await interaction.reply({
      content: "These commands are only available in the configured server.",
      ephemeral: true,
    });
    return;
  }

  const memberRoles = interaction.member.roles;
  const canControlSoundboard = Array.isArray(memberRoles)
    ? memberRoles.includes(SOUNDBOARD_COMMAND_ROLE_ID)
    : memberRoles.cache.has(SOUNDBOARD_COMMAND_ROLE_ID);
  if (!canControlSoundboard) {
    await interaction.reply({
      content: "You do not have the role required to use Soundboard commands.",
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === "soundboard-test") {
    await interaction.deferReply({ ephemeral: true });
    try {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const channel = member.voice.channel;
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        await interaction.editReply("Join a voice channel before testing the Soundboard.");
        return;
      }

      await queueSoundboardPlayback(() => playSoundboardSound(channel));
      await interaction.editReply(`Played the configured Soundboard sound in ${channel}.`);
    } catch (error) {
      console.error("Could not play the test Soundboard sound:", error);
      const message = error instanceof Error ? error.message : String(error);
      await interaction.editReply(`Could not play the Soundboard test: ${message}`);
    }
    return;
  }

  const enabled = interaction.commandName === "soundboard-on";
  if (soundboardEnabled === enabled) {
    await interaction.reply({
      content: `Automatic Soundboard sounds are already ${enabled ? "on" : "off"}.`,
      ephemeral: true,
    });
    return;
  }

  try {
    saveSoundboardSetting(enabled);
    soundboardEnabled = enabled;
    await interaction.reply({
      content: `Automatic Soundboard sounds are now ${enabled ? "on" : "off"}.`,
      ephemeral: true,
    });
  } catch (error) {
    console.error("Could not save the Soundboard setting:", error);
    await interaction.reply({
      content: "Could not save the Soundboard setting. Check the bot's file permissions.",
      ephemeral: true,
    });
  }
});

client.once("clientReady", async () => {
  console.log(generateDependencyReport());

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    await registerSoundboardCommands(guild);
    const role = await guild.roles.fetch(DUCK_ROLE_ID);
    if (!role) {
      throw new Error(`Could not find Duck role ${DUCK_ROLE_ID} in server ${GUILD_ID}.`);
    }

    await guild.members.fetch();
    memberCount = role.members.size;

    const channel = await client.channels.fetch(COUNTER_CHANNEL_ID);
    if (
      !channel ||
      channel.type !== ChannelType.GuildText ||
      channel.guildId !== GUILD_ID
    ) {
      throw new Error(`Counter channel ${COUNTER_CHANNEL_ID} must be a text channel in server ${GUILD_ID}.`);
    }

    let recentMessages;
    try {
      recentMessages = await channel.messages.fetch({ limit: 100 });
    } catch (error) {
      if (error.code === 50001 || error.code === 50013) {
        throw new Error(
          `The bot cannot read messages in channel ${COUNTER_CHANNEL_ID}. Grant it View Channel and Read Message History there, and verify COUNTER_CHANNEL_ID.`,
        );
      }
      throw error;
    }

    counterMessage = recentMessages.find(
      (message) => message.author.id === client.user.id && message.content.startsWith(COUNTER_PREFIX),
    );

    if (counterMessage) {
      await counterMessage.edit(`${COUNTER_PREFIX} ${memberCount}`);
    } else {
      counterMessage = await channel.send(`${COUNTER_PREFIX} ${memberCount}`);
    }

    console.log(`Ready as ${client.user.tag}. Counter is posted in channel ${COUNTER_CHANNEL_ID}.`);
  } catch (error) {
    console.error("Could not start the Duck-role counter:", error);
    process.exitCode = 1;
    client.destroy();
  }
});

client.login(DISCORD_TOKEN).catch((error) => {
  console.error("Could not log in to Discord:", error);
  process.exitCode = 1;
});
