# Doomsday Player

A tiny Next.js app that plays hotlink-protected videos in any browser, including iOS Safari.

The Telegram bot ([Ibnuard/dd-bot](https://github.com/Ibnuard/dd-bot)) extracts video URLs and signs a link to this player. The player either streams the video directly or proxies it server-side with the right Referer header.

## How it works

```
[Telegram bot]                       [Doomsday Player on Vercel]
  extract                              ┌──────────────────┐
    │                                  │  /play           │  ← React + hls.js
    │   sign(u, ref, exp) ──────────►  │       │          │
    │                                  │       ▼          │
    │                                  │  /api/stream     │  ← Verify HMAC,
    │                                  │       │          │     fetch w/ Referer,
    └─► reply: /play?u=&r=&e=&s=       │       ▼          │     pipe to client
                                       │  upstream CDN    │
                                       └──────────────────┘
```

Direct streams (no Referer needed) skip the proxy and play straight from the CDN. Proxy is only used when the bot tags the link with a `ref`.

For HLS, the manifest is rewritten so every segment routes back through `/api/stream` with its own signature.

## Local dev

```bash
cp .env.example .env.local
# fill STREAM_SECRET — must match the bot's env

npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Deploy on Vercel

1. Push this repo to GitHub.
2. Import in Vercel → keep defaults.
3. Add env vars under Project Settings → Environment Variables:
   - `STREAM_SECRET` — same value as the bot
   - `NEXT_PUBLIC_BOT_URL` — optional, your `t.me/...` link
4. Deploy.

The `/api/stream` route runs on Node runtime (`maxDuration: 300`) which is fine on the Vercel Hobby plan.

## Security notes

- Direct visits to `/api/stream` without a valid `sig` get 403, so the proxy can't be used as an open relay.
- Signature is HMAC-SHA256 over `u=<url>&r=<ref>&e=<exp>` — tampering any field invalidates the link.
- Default link expiry is up to the bot to set (recommend 6–24 hours).
- Landing page is `noindex`, the player route is also marked.
