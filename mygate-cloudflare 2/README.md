# SocietyApp — Cloudflare deployment

A working visitor-management prototype, deployable for free on Cloudflare Pages with a D1 database.

## What's inside

```
mygate-cloudflare/
├── public/                    # Static frontend (served by Cloudflare Pages)
│   ├── index.html             # Login picker
│   ├── resident.html          # Resident dashboard
│   ├── guard.html             # Security dashboard
│   ├── styles.css
│   └── js/{common,resident,guard}.js
├── functions/
│   └── api/[[path]].js        # Single Pages Function — handles all /api/* routes
├── schema.sql                 # D1 schema + seed (run once in D1 console)
└── wrangler.toml              # Reference config (for CLI users)
```

## How it differs from the local Node version

| Local (Node) version           | Cloudflare version                                   |
| ------------------------------ | ----------------------------------------------------- |
| Express + better-sqlite3       | Cloudflare Pages Functions + D1                       |
| WebSockets for real-time push  | Client polls every 3 seconds (negligible UX delay)    |
| QR generated on the server     | QR rendered on the client via `qrcode` CDN library    |
| `npm install` + `node server.js` | `git push` → Cloudflare auto-deploys              |

Behavior, schema, and API surface are identical.

## Deploying (rough outline — Claude will drive these in Chrome)

1. **GitHub** — push this folder to a repo (drag-drop into the GitHub web UI works).
2. **Cloudflare → D1** — create a database called `mygate-d1`, paste `schema.sql` into its Console tab, Execute.
3. **Cloudflare → Workers & Pages → Pages** — Create a project → Connect to Git → select the repo. Build settings: leave most as default, **build output directory = `public`**.
4. **Cloudflare → Pages project → Settings → Functions → D1 database bindings** — add binding:
   - Variable name: `DB`
   - D1 database: `mygate-d1`
5. Trigger a redeploy (Deployments tab → "Retry deployment" or push any commit).
6. Open the `*.pages.dev` URL on your phone and laptop, sign in as different roles, and walk through the demo.

## Notes

- Free Cloudflare plan limits: 100,000 D1 reads + 50,000 writes per day, 100,000 Pages Function invocations per day. Generous for a prototype.
- The polling interval is 3 s. Walk-in approval requests appear in ≤ 3 s — close enough to "real-time" for users.
- D1 is SQLite under the hood, so the existing schema works as-is.
- Photo blobs (base64 JPEG, < 100 KB after client-side resize) are stored in D1. For production you'd move them to R2 (Cloudflare's object storage).

## Next iteration ideas

- True Web Push notifications (need a service worker + VAPID keys)
- Multi-use passes for frequent visitors
- Phone-number+OTP login (Twilio or Cloudflare Email Routing)
- Admin role + audit log
- Move photos to R2; store only the key in D1
