# Duck Role Counter

A Discord bot that keeps a message in a configured text channel showing how many server members currently have the Duck role. The message updates when members join or leave, or gain or lose the role.

## Setup

1. Create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Enable **Server Members Intent** on the bot's **Bot** page so it can fetch the server's members and track membership and role changes.
3. Invite the bot with the `bot` and `applications.commands` scopes. Give it **View Channel**, **Read Message History**, and **Send Messages** permissions in the channel where the counter should appear, plus **Connect**, **Speak**, and **Use Soundboard** permissions in voice channels where it should play the sound. For sounds from another server, also grant **Use External Sounds**.
4. Copy the bot token, server ID, Duck role ID, and counter channel ID. Keep the bot token private.
5. Fill in those values in the `.env` file in the project folder.
6. Add the soundboard sound ID to `.env` as `SOUNDBOARD_SOUND_ID=your_sound_id`. If the sound comes from a different server, also set `SOUNDBOARD_SOURCE_GUILD_ID=source_server_id`.
7. Use Node.js 22.12 or newer, then install dependencies and start the bot:

   ```powershell
   npm install
   npm start
   ```

On startup, the bot counts current role members and updates its existing counter message if it appears among the channel's 100 most recent messages. Otherwise, it posts a new one, so the counter is restored after a restart even if the channel was cleared while the bot was offline. If the counter is deleted by itself or as part of a bulk channel purge while the bot is running, it posts a replacement. This restores only the counter message, not other deleted channel messages.

When a member with the Duck role joins or moves into a voice channel, the bot waits one second, joins without self-deafening, asks Discord to play the configured Soundboard sound, waits one second, then disconnects. If the member leaves or changes channels during the initial delay, the queued sound is skipped. Installations with an existing `node_modules` folder should run `npm install` again after dependency changes. The bot prints a dependency report and voice connection state changes to help diagnose setup.

Use `/soundboard-on` and `/soundboard-off` in Discord to enable or disable automatic sounds. Use `/soundboard-test` while in a voice channel to play the configured sound immediately, even when automatic sounds are disabled. Set `SOUNDBOARD_COMMAND_ROLE_ID` in `.env` to the ID of the role allowed to use these commands. The setting is saved in `soundboard-settings.json` and persists across restarts; if no setting has been saved yet, sounds are enabled by default. Nodemon watches only `index.js`, so toggling the commands does not restart the bot.
