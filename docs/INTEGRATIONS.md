# Connecting Google Workspace and Slack

Monarch reads and acts on your mail, calendar and Slack through your own credentials. Nothing goes through a Monarch server: the core on your machine (`127.0.0.1:7717`) talks to Google and Slack directly, and every token is stored in `~/.monarch-ai/secrets.json` (file mode `600`), which is never sent to the UI.

Both integrations are set up in **Config → Accounts**.

- [Google (Gmail + Calendar)](#google-gmail--calendar)
- [Slack](#slack)
- [Troubleshooting](#troubleshooting)

---

## Google (Gmail + Calendar)

Monarch uses an OAuth client that **you** own. That means one-time setup in Google Cloud (about 5 minutes); after that you can connect as many Google accounts as you like with a normal browser sign-in.

### What Monarch asks for

| Scope | Used for |
|---|---|
| `openid`, `email`, `profile` | Identify which account was connected |
| `gmail.modify` | Search, read and label/archive mail (it cannot permanently delete) |
| `gmail.send` | Send mail and save drafts (every send needs your approval) |
| `calendar` | Read and create/edit calendar events |

### 1. Create a Google Cloud project

1. Open the [Google Cloud console](https://console.cloud.google.com/).
2. Use the project picker at the top → **New project** → give it a name such as `Monarch` → **Create**, then select it.

### 2. Enable the APIs

1. Go to **APIs & Services → Library**.
2. Search for **Gmail API** → **Enable**.
3. Search for **Google Calendar API** → **Enable**.

### 3. Configure the consent screen

Google calls this **OAuth consent screen**, or in the newer console **Google Auth Platform**, with its **Branding**, **Audience** and **Data access** pages.

1. Click **Get started** (or **Configure consent screen**) and fill in an app name (e.g. `Monarch`), your email as support email and developer contact.
2. **Audience / User type**: pick one.
   - **Internal**: only available if you're using a company Google Workspace and the project belongs to that organization. All accounts in your organization can connect, tokens don't expire weekly, and there are no test users to manage. **Recommended for work accounts.**
   - **External**: for personal Gmail accounts, or accounts from several organizations. Leave the publishing status as **Testing** and, under **Test users**, add **every Google address you will connect**.
3. **Data access / Scopes**: you can skip this. Monarch requests its scopes during sign-in.

### 4. Create the OAuth client

1. Go to **APIs & Services → Credentials** (or **Google Auth Platform → Clients**) → **Create credentials → OAuth client ID**.
2. Application type: **Desktop app**. Name it `Monarch desktop`.
3. Click **Create** and copy the **Client ID** (`…apps.googleusercontent.com`) and **Client secret** (`GOCSPX-…`).

You do **not** need to register a redirect URI. Desktop-app clients accept loopback redirects, and Monarch uses `http://127.0.0.1:7717/oauth/google/callback` (with PKCE).

### 5. Connect in Monarch

1. Open **Config → Accounts**.
2. In the Google client panel, paste the **Client ID** and **Client secret** → **Save client**.
3. In **Google accounts**, click **Connect**. Your browser opens Google's sign-in page.
4. Choose the account and allow access. With an *External* app in *Testing* you'll see "Google hasn't verified this app". That's expected for your own client: click **Continue**.
5. The browser shows a confirmation page and the account appears in Monarch as **linked**.

Repeat step 3 for each additional account (personal + work, etc.). Mail shows all accounts merged, or one at a time; Agenda shows every connected calendar.

### Things to know

- **Weekly re-connect (External + Testing only).** Google expires refresh tokens for apps in *Testing* after **7 days**. To avoid this:
  - use **Internal** (Workspace accounts); or
  - on the Audience page click **Publish app**. For personal use you can keep using it unverified; Google just shows the warning screen at sign-in.
- **Company Workspace restrictions.** Some admins block third-party OAuth apps. If sign-in says the app is blocked, ask your admin to allow the client ID, or use an *Internal* app created inside your organization's own Cloud project.
- **The core must be running on port 7717** during sign-in, since that's where Google redirects back.
- **Disconnect** an account from **Config → Accounts**. To revoke it on Google's side as well, use [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

---

## Slack

Monarch uses a Slack app that you install into your own workspace, then talks to Slack with its token. Use a **user token** (`xoxp-…`): Monarch reads what *you* can see, searches and posts as you. A bot token (`xoxb-…`) works too, but bots can only see channels they've been invited to and **cannot search**.

### What Monarch asks for (user token scopes)

| Scope | Used for |
|---|---|
| `channels:read`, `groups:read`, `im:read`, `mpim:read` | List public/private channels, DMs and group DMs |
| `channels:history`, `groups:history`, `im:history`, `mpim:history` | Read messages and threads in them |
| `users:read` | Show names instead of user IDs |
| `search:read` | Search messages (user tokens only) |
| `chat:write` | Post, reply in threads, edit, delete and schedule messages as you (each needs your approval) |
| `channels:write`, `groups:write`, `im:write`, `mpim:write` | Mark conversations as read, and open a DM with someone new |
| `reactions:read`, `reactions:write` | Add and remove emoji reactions |
| `users:read.email` | Find people by email (optional) |

### 1. Create the Slack app

1. Go to <https://api.slack.com/apps> → **Create New App** → **From scratch**.
2. Name it (e.g. `Monarch`) and pick the workspace → **Create App**.

### 2. Add the scopes

1. In the app's sidebar, open **OAuth & Permissions**.
2. Scroll to **Scopes → User Token Scopes** (not *Bot Token Scopes*) and add each of:

   ```
   channels:history  channels:read  groups:history  groups:read
   im:history  im:read  mpim:history  mpim:read
   users:read  search:read  chat:write
   channels:write  groups:write  im:write  mpim:write
   reactions:read  reactions:write  users:read.email
   ```

   Already connected before these were added? Add the new scopes, **Reinstall to Workspace** and paste the new token; until then Monarch tells you which scope a refused action needs.

   The same list is shown in Monarch under **Config → Accounts → Slack → show scopes**.

### 3. Install and copy the token

1. At the top of **OAuth & Permissions**, click **Install to Workspace** (or **Request to Install** if your workspace requires admin approval) and **Allow**.
2. Copy the **User OAuth Token**. It starts with `xoxp-`.

### 4. Connect in Monarch

1. Open **Config → Accounts → Slack**.
2. Paste the token into **Add workspace token** and confirm.
3. Monarch checks it with Slack (`auth.test`) and the workspace appears as **linked**, showing the token type and your user.

Repeat with a token from each workspace you want to connect. Each workspace needs its own app installed (or one app distributed to several workspaces).

### Things to know

- **Changed scopes need a reinstall.** If you add scopes later, click **Reinstall to Workspace**. The token may change; paste the new one.
- **Admin approval.** On managed workspaces an admin may need to approve the app before you get a token.
- **Not supported:** browser session tokens (`xoxc-…` / `xoxd-…`). Monarch rejects them, because they're tied to a browser session and break unpredictably.
- **Disconnect** from **Config → Accounts**. To revoke the token entirely, open the app at api.slack.com/apps → **OAuth & Permissions → Revoke tokens**, or remove the app from the workspace.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Google: *"Access blocked: app has not completed the Google verification process"* / `access_denied` | The account isn't a **test user**. Add it under Audience → Test users (External apps), or use an Internal app. |
| Google: *`redirect_uri_mismatch`* | The client isn't a **Desktop app**. Create a new OAuth client of type *Desktop app* and paste its ID and secret. |
| Google: the account worked, then stopped after a week | The app is External + Testing (7-day token expiry). Reconnect, or publish the app / use Internal. |
| Google: *"…API has not been used in project … or it is disabled"* | Enable the **Gmail API** and **Google Calendar API** in that same project. |
| Google: the browser page never loads after sign-in | The core isn't reachable on `127.0.0.1:7717`. Make sure Monarch is running, then retry **Connect**. |
| Google: connected, but a warning lists missing scopes | You unticked a permission on Google's consent page. Disconnect and connect again, allowing everything. |
| Slack: *"Slack rejected the token (invalid_auth)"* | The token was copied incompletely, or it's from another app or workspace. Copy the full `xoxp-…` value again. |
| Slack: *"token is missing a scope … add "X" … and reinstall"* | Add the named scope under **User Token Scopes**, **Reinstall to Workspace**, and paste the new token. |
| Slack: search doesn't work | You're using a bot token (`xoxb-`). Search needs a user token (`xoxp-`) with `search:read`. |
| Slack: *"channel not found"* | With a bot token, invite the bot to the channel. With a user token, you must be a member of that private channel. |
| Slack: *"token was revoked/expired"* | The app was uninstalled or the token rotated. Reinstall and paste the new token. |
