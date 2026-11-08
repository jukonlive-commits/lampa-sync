# Lampa Sync — experimental prototype

Encrypted manual export/import of selected Lampa localStorage settings on LG webOS, using a Cloudflare Worker and Telegram archive.

**Status: untested on LG C3. Do not delete your existing Lampa data.** This is not a complete or independently audited backup tool. Some Lampa state is outside localStorage; plugin tokens and keys with sensitive-looking names are excluded. Other sensitive values may still be present in the snapshot. Use a strong unique passphrase.

## Deployment

1. Create a Telegram bot using @BotFather. Keep its token private. Send the bot a message and obtain your numeric chat ID using Telegram's getUpdates endpoint (do not share bot token or chat ID publicly).
2. Create a free Cloudflare account and a Worker named `lampa-sync`. Deploy the code from `worker/src/index.js` (via the Cloudflare editor or Wrangler).
3. Create a Cloudflare KV namespace and bind it to the Worker as `BACKUPS`.
4. In Worker Settings > Variables and Secrets add **secret** values: `BOT_TOKEN`, `CHAT_ID`, and `API_KEY` (long random string). Do not commit these values to GitHub.
5. Deploy Worker and note the HTTPS `*.workers.dev` URL.
6. In GitHub repository Settings > Pages choose **Deploy from a branch**, branch `main`, folder `/ (root)`. Wait for Pages publication.
7. Add `https://jukonlive-commits.github.io/lampa-sync/plugin.js` in Lampa > Settings > Plugins.
8. In Lampa Sync settings, enter Worker URL, an arbitrary ID of 4–64 letters/digits/underscores/dashes, and the same API_KEY. Use **Export** on LG C3. On the second device, install the plugin, enter the same configuration, and choose **Import** using the same passphrase.

## Security notes

- Data is encrypted in the browser using AES-GCM with a PBKDF2-derived key before transmission. The passphrase is not sent to the Worker.
- Worker stores the latest encrypted backup in KV and sends an encrypted archive to the specified Telegram chat.
- API_KEY is stored locally on each Lampa device; treat it as sensitive. A publicly hosted JS plugin must never contain the Telegram bot token.
- Current Worker uses wildcard CORS for device compatibility; access is controlled by API_KEY. Do not share API_KEY.
- Telegram archives are not yet available through the plugin's import UI; import retrieves the latest copy from KV.
- This version has no automatic sync, device pairing, rollback, or conflict resolution.
- Import overwrites matching localStorage keys after confirmation; create a separate backup before testing.
- WebOS WebCrypto and Lampa SettingsApi compatibility have not yet been verified on the user's TV.


## Public multi-user deployment (planned; NOT implemented)

The current v1 Worker uses a single shared API key and chat ID. **Do not publish that key or offer v1 as a multi-user service.** It has no per-user authentication or ownership enforcement.

For v2, implement Telegram webhook authentication with one-time device pairing, per-user sessions and storage authorization, server-side rate limiting, encryption before upload, and a recovery strategy. Do not send all users' backups into a shared chat. Existing v1 code must be replaced and security-tested before public rollout.
