# Age Every Click Server

Colyseus multiplayer server for [Age-every-click](../Age-every-click), structured
after the sibling project's own backend, `Ice-skate-backend` — same stack
(`colyseus` + `@colyseus/schema` + Mongo persistence + Bloxity Legion deploy),
adapted to Age Every Click's actual game state: Age (the client's internal
`speed` field), Coins, Rebirth, and each player's owned/equipped upgrades.

## :video_game: Usage

```
npm install
npm start
```

Then open http://localhost:2567 for the playground, or /monitor for the monitor.

## Structure

- `src/index.ts`: entry point — leave it alone if you plan to deploy to Colyseus Cloud
- `src/app.config.ts`: server configuration — rooms, HTTP routes, express middleware
- `src/rooms/IslandRoom.ts`: the single global room every client joins (`client.joinOrCreate("island")`)
- `src/rooms/schema/IslandState.ts`: the state synchronized to every client in the room
- `src/db.ts`: Mongo-backed player-progress persistence (degrades to no-op if `MONGODB_URI` is unset/unreachable)
- `test/IslandRoom.test.ts`: boots the real server and connects real clients
- `loadtest/example.ts`: scriptable client for `npm run loadtest`
- `ecosystem.config.cjs`: pm2 configuration, used when deploying to Colyseus Cloud

## Scripts

- `npm start`: run the server in watch mode (`tsx watch src/index.ts`)
- `npm test`: run the mocha test suite
- `npm run build`: compile to `build/`
- `npm run loadtest`: connect N simulated clients with [`@colyseus/loadtest`](https://github.com/colyseus/colyseus-loadtest/)

## Wire protocol

The client's `src/systems/net.js` is currently a stub (no server configured) —
wiring it up to this contract, mirroring how `Ice-Skate/src/systems/net.js`
talks to its own server, is the next step once this backend is deployed.
Every field name below matches `Age-every-click/src/store/useGameStore.js`
exactly.

Join with `client.joinOrCreate("island", { username, avatar, userId })`.
`userId` is the stable Bloxity user id (`systems/bloxity.js`'s
`getStableUserId()`) — omit it for a guest, whose progress simply isn't
persisted.

### Client → server messages

| Message | Payload | Cadence |
|---|---|---|
| `move` | `{ x, y, z, yaw, moveBlend }` | throttled, not per physics frame |
| `setAvatar` | `{ avatar }` (JSON string, same shape `systems/avatarLoader.js` consumes) | on connect + whenever the portal reports the avatar changed |
| `stats` | `{ speed, coins, rebirth }` | debounced on change |
| `saveProgress` | `{ speed, rebirth, coins, ownedHexPads, equippedHexPad, ownedAuras, equippedAura, ownedAgeMachines }` | debounced on change; no-ops for a guest (no `userId`) |
| `identify` | `{ username, userId }` | whenever sign-in state changes after join |

`speed` is Age's raw click-earned total (client `data/progression.js`), the
same field name `store/useGameStore.js` uses internally — not to be confused
with `PLAYER_MOVE_SPEED`.

### Server → client messages

| Message | Payload | When |
|---|---|---|
| `progress` | full saved `PlayerDoc` (see `src/db.ts`) | once, right after a signed-in join/identify, if a saved doc exists |
| `leaderboard` | `{ speed: Row[], coins: Row[], rebirth: Row[] }`, `Row = { id, name, value }` | every 15s, merging the live roster with all-time Mongo top scorers |

`IslandState.players` (keyed by `sessionId`) carries `username`, `x/y/z/yaw`,
`moveBlend`, `avatar`, `speed`, `coins`, `rebirth` for every connected player.

## Environment

- `MONGODB_URI` — injected per game+channel by Bloxity Legion hosting; unset locally (persistence degrades to a no-op, same posture as every other external dependency in the client).
- `CLIENT_ORIGIN` — injected in deployed environments; CORS falls back to `*` locally.
- `PORT` — injected by Legion; falls back to 2567.

## Deploy

`.github/workflows/deploy.yml` builds a Docker image, pushes it to GHCR, and
calls the Bloxity Legion deploy API on every push to `dev` (→ `dev` channel)
or `main` (→ `prod` channel). It needs, per-repo:

- **Variable** `BLOXITY_GAME_ID` — the lowercase game ID from the Bloxity "My Games" dashboard (Settings → Secrets and variables → Actions → Variables).
- **Secret** `LEGION_DEPLOY_TOKEN` — the Legion deploy token (Settings → Secrets and variables → Actions → Secrets).

`GITHUB_TOKEN` (for the GHCR push) is provided automatically.
