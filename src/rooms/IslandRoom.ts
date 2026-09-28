import { Room, Client, CloseCode } from "colyseus";
import type { Delayed } from "@colyseus/timer";
import { IslandState, PlayerState, BridgeTileState } from "./schema/IslandState.js";
import {
  LEADERBOARD_REFRESH_MS,
  LEADERBOARD_QUERY_LIMIT,
  FREE_SPIN_INTERVAL_MS,
  SPINS_MAX,
  BRIDGE_COLUMNS,
  BRIDGE_LANES,
  BRIDGE_UNSAFE_RESET_DELAY_MS,
  BRIDGE_RESHUFFLE_AFTER_FAILS,
} from "../constants.js";
import { getPlayers, type PlayerDoc } from "../db.js";

// The 3 stats client store/useGameStore.js tracks and an in-world
// leaderboard would rank by, one board per stat. "speed" is the client's
// internal field name for the Age stat (see data/progression.js).
const LEADERBOARD_STATS = ["speed", "coins", "rebirth"] as const;
type LeaderboardStat = (typeof LEADERBOARD_STATS)[number];
type LeaderboardRow = { id: string; name: string; value: number };
type LeaderboardPayload = Record<LeaderboardStat, LeaderboardRow[]>;
type OnlineRow = { sessionId: string; userId: string | null; username: string; speed: number; coins: number; rebirth: number };

// Defense-in-depth alongside IslandRoom.setUserId()'s eviction of a superseded
// session: collapse any online rows that still share a userId (e.g. a
// leave/join racing the same tick) down to one, keeping the higher value for
// whichever stat is being ranked. Anonymous (guest) rows have no id to key
// on and are never collapsed against each other.
function dedupeOnline(rows: OnlineRow[], stat: LeaderboardStat): OnlineRow[] {
  const byUserId = new Map<string, OnlineRow>();
  const anonymous: OnlineRow[] = [];
  for (const row of rows) {
    if (!row.userId) {
      anonymous.push(row);
      continue;
    }
    const existing = byUserId.get(row.userId);
    if (!existing || row[stat] > existing[stat]) byUserId.set(row.userId, row);
  }
  return [...byUserId.values(), ...anonymous];
}

// See loadProgress()'s own comment -- the value sent for tutorialStep when a
// doc predates that field's existence. Comfortably past client
// systems/tutorial.js's current STEPS.length (7) so it still reads as
// "finished" there even if that array grows later.
const LEGACY_TUTORIAL_DONE_STEP = 1000;

// Mirrors client systems/tutorial.js's STEPS thresholds (5/18/100 Age,
// owning Age Machine index 0, any rebirth) -- kept in sync by comment
// cross-reference, not a shared import, since the two projects don't share
// code. loadProgress() below takes the larger of this and the doc's own
// stored tutorialStep, so a saved step that undercounts the player's ACTUAL
// progress (a doc saved before tutorialStep was tracked reliably, a manual
// stat edit, or any other drift between the two) never leaves them looking
// at a step they've clearly already blown past. Never used to regress a
// stored step that's already ahead of what these stats alone can prove --
// step 3's real gate is finishing an obby, which isn't in the doc at all, so
// this only infers up through "step 3 or later" from speed, not exactly 3.
function inferMinTutorialStep(doc: PlayerDoc): number {
  if ((doc.rebirth ?? 0) > 0) return LEGACY_TUTORIAL_DONE_STEP; // past step 6 (first rebirth)
  const speed = doc.speed ?? 0;
  if (speed >= 100) return 6; // past step 5 -- only the rebirth step is left
  if ((doc.ownedAgeMachines ?? []).includes(0)) return 5; // past step 4 -- Basic Age Machine bought
  if (speed >= 18) return 3; // past step 2
  if (speed >= 5) return 2; // past step 1
  if (speed > 0) return 1; // past step 0 -- they've clicked at least once
  return 0;
}

// What loadProgress() actually sends down as tutorialStep -- pulled out into
// its own pure function so test/IslandRoom.test.ts can exercise the legacy-
// default and stats-override rules directly, without racing the async
// Mongo-lookup-then-`progress`-message flow a full room/client round trip
// would require.
export function resolveTutorialStep(doc: PlayerDoc): number {
  const stored = typeof doc.tutorialStep === "number" ? doc.tutorialStep : LEGACY_TUTORIAL_DONE_STEP;
  return Math.max(stored, inferMinTutorialStep(doc));
}

// Cap on the JSON avatar blob (see IslandState.ts PlayerState.avatar). A full
// equipped set + proportions serialises to a few hundred bytes; 4 KB is
// generous headroom and still bounds a misbehaving client.
const AVATAR_MAX_LEN = 4096;

function sanitizeAvatar(raw: unknown): string {
  return typeof raw === "string" && raw.length <= AVATAR_MAX_LEN ? raw : "";
}

// Builds the room's one shared Impossible Bridge layout -- see
// BridgeTileState's own comment for why this happens exactly once, at room
// startup, never per-player or per-attempt. Column/lane order matches
// client systems/bonusBridge.js's own tiles.push() loop exactly (index =
// column * BRIDGE_LANES + lane), so client index i and this array's index i
// are always the same physical tile. The last column is the fixed
// green-arrow (lane 0) / red-X (lane 1) pair, same fixed rule the client
// itself hardcodes.
function buildBridgeLayout(): InstanceType<typeof BridgeTileState>[] {
  const out: InstanceType<typeof BridgeTileState>[] = [];
  for (let c = 0; c < BRIDGE_COLUMNS; c++) {
    const last = c === BRIDGE_COLUMNS - 1;
    const safeLane = last ? 0 : Math.random() < 0.5 ? 0 : 1;
    for (let lane = 0; lane < BRIDGE_LANES; lane++) {
      const t = new BridgeTileState();
      t.safe = lane === safeLane;
      out.push(t);
    }
  }
  return out;
}

// Generous cap on an owned-tier list (client data/hexPowerPad.js /
// data/aura.js / data/island.js AGE_MACHINES each ship well under this many
// tiers today).
const OWNED_LIST_MAX = 64;

// Same client-trusted model as every other message here (move/username/
// avatar/stats) -- no server-side game-logic validation. What IS enforced:
// shape and bounds, so a malformed/hostile payload can never corrupt this
// player's own Mongo document. A forged number can only ever affect the
// sender's own save -- there is no cross-player read here.
function sanitizeProgress(raw: unknown): Partial<PlayerDoc> | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  const out: Partial<PlayerDoc> = {};

  for (const key of ["speed", "rebirth", "coins"] as const) {
    const v = src[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = Math.max(0, v);
  }
  for (const key of ["ownedHexPads", "ownedAuras", "ownedAgeMachines"] as const) {
    const v = src[key];
    if (Array.isArray(v)) {
      out[key] = v
        .filter((n): n is number => typeof n === "number" && Number.isFinite(n))
        .slice(0, OWNED_LIST_MAX);
    }
  }
  for (const key of ["spins", "wheelSpins"] as const) {
    const v = src[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = Math.min(SPINS_MAX, Math.max(0, Math.floor(v)));
  }
  // No upper bound -- client systems/tutorial.js's own STEPS length may grow,
  // and a stray large value just reads as "onboarding finished" there anyway.
  if (typeof src.tutorialStep === "number" && Number.isFinite(src.tutorialStep)) {
    out.tutorialStep = Math.max(0, Math.floor(src.tutorialStep));
  }
  if (typeof src.speedCoil === "boolean") out.speedCoil = src.speedCoil;
  if (typeof src.equippedHexPad === "number" && Number.isFinite(src.equippedHexPad)) {
    out.equippedHexPad = src.equippedHexPad;
  }
  if (src.equippedAura === null || (typeof src.equippedAura === "number" && Number.isFinite(src.equippedAura))) {
    out.equippedAura = src.equippedAura as number | null;
  }
  return out;
}

/**
 * Single global room every client joins via `client.joinOrCreate("island")`.
 * No server-side gameplay validation -- clients report events (as they
 * already do locally against store/useGameStore.js), this room just relays/
 * stores them so other clients see them too.
 */
export class IslandRoom extends Room<{ state: IslandState }> {
  state = new IslandState();

  // sessionId -> Bloxity user id, for whichever connected clients are signed
  // in. Deliberately NOT part of IslandState: unlike username/avatar this has
  // no reason to be broadcast to other players, it only gates this room's own
  // Mongo reads/writes for the owning connection.
  userIds = new Map<string, string>();

  // userIds with a `claimFreeSpin` read-check-write already in flight, so a
  // double-click can't pass the cooldown check twice before the first write lands.
  private claimingFreeSpin = new Set<string>();

  // Impossible Bridge shared puzzle bookkeeping -- deliberately NOT part of
  // IslandState, same reasoning as userIds above: neither has any reason to
  // be broadcast, they only drive this room's own logic.
  // tileIndex -> its pending re-arm Delayed, so reshuffleBridge() can cancel
  // one that's still counting down instead of leaving it to later fire and
  // stomp a tile a fresh layout already reset.
  private bridgeBreakTimers = new Map<number, Delayed>();
  // Total falls/timeouts reported since the last reshuffle (or room start) --
  // see BRIDGE_RESHUFFLE_AFTER_FAILS's own comment.
  private bridgeFailCount = 0;
  // Set once BRIDGE_RESHUFFLE_AFTER_FAILS has been reached but at least one
  // player was still on the bridge at that moment -- reshuffling out from
  // under someone mid-crossing would flip tiles they've already relied on
  // (or are currently standing on) with no warning. maybeReshuffleBridge()
  // (called from setScene and onLeave, wherever the "who's on the bridge"
  // set can shrink) actually performs the deferred reshuffle the instant
  // nobody's left on it.
  private bridgeReshuffleDue = false;

  messages = {
    // Throttled client-side -- not sent every physics frame.
    move: (client: Client, msg: any) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      p.x = msg.x;
      p.y = msg.y;
      p.z = msg.z;
      p.yaw = msg.yaw;
      p.moveBlend = msg.moveBlend;
    },
    // The player's Bloxity avatar (equipped cosmetics + proportions) as a JSON
    // string. Sent once on connect and again whenever the portal reports the
    // avatar changed -- a human-speed event, not a per-frame one. Stored as-is
    // so every other client can build the real character; never parsed here.
    setAvatar: (client: Client, msg: { avatar?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const avatar = sanitizeAvatar(msg?.avatar);
      if (avatar) p.avatar = avatar;
    },
    // The player's own live stats (client store/useGameStore.js speed/coins/
    // rebirth), so an in-world leaderboard can rank currently-connected
    // players. Sent debounced on change, not per frame -- same "human-speed
    // event" cadence as setAvatar above. No validation beyond finite/
    // non-negative, same trust model as every other message here.
    stats: (client: Client, msg: { speed?: number; coins?: number; rebirth?: number }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (typeof msg?.speed === "number" && Number.isFinite(msg.speed)) {
        p.speed = Math.max(0, msg.speed);
      }
      if (typeof msg?.coins === "number" && Number.isFinite(msg.coins)) {
        p.coins = Math.max(0, msg.coins);
      }
      if (typeof msg?.rebirth === "number" && Number.isFinite(msg.rebirth)) {
        p.rebirth = Math.max(0, msg.rebirth);
      }
    },
    // Client's debounced push of the durable half of store/useGameStore.js
    // (speed/rebirth/coins/owned+equipped hex pads/auras/owned age machines) --
    // a human-speed event, same cadence family as `stats`/`setAvatar`. Only a
    // signed-in client has a userId (see onJoin); a guest's progress has
    // nowhere durable to live and this simply no-ops. Upserts, so a
    // brand-new player's first save creates their document.
    saveProgress: async (client: Client, msg: unknown) => {
      const userId = this.userIds.get(client.sessionId);
      if (!userId) return;
      const players = getPlayers();
      if (!players) return; // Mongo unset/unreachable -- degrade silently
      const patch = sanitizeProgress(msg);
      if (!patch) return;
      // Read off this connection's own PlayerState rather than trust a
      // username in `msg` -- refreshLeaderboard() below needs a display name
      // for players who are offline by the time it queries Mongo, and this is
      // the same already-sanitized value onJoin/identify put on the schema.
      const p = this.state.players.get(client.sessionId);
      try {
        await players.updateOne(
          { _id: userId },
          {
            $set: { ...patch, username: p?.username || "Player", updatedAt: new Date() },
            $setOnInsert: { version: 1 },
          },
          { upsert: true },
        );
      } catch (err) {
        console.warn("[IslandRoom] saveProgress failed", err);
      }
    },
    // Lucky Wheel's daily free spin. The cooldown is checked and stamped here,
    // on the server clock, and saved outside saveProgress (which can't touch
    // lastFreeSpinAt), so neither a wrong device clock nor a forged save can
    // skip it. Replies `freeSpin` { ok, nextInMs, reason? } -- nextInMs is a
    // duration rather than a timestamp so client clock skew doesn't matter.
    // reason "unavailable" = guest or Mongo down: nothing durable to check
    // against, so the client falls back to its own local timer.
    claimFreeSpin: async (client: Client) => {
      const userId = this.userIds.get(client.sessionId);
      const players = getPlayers();
      if (!userId || !players) {
        client.send("freeSpin", { ok: false, reason: "unavailable", nextInMs: 0 });
        return;
      }
      if (this.claimingFreeSpin.has(userId)) return;
      this.claimingFreeSpin.add(userId);
      try {
        const now = Date.now();
        const doc = await players.findOne({ _id: userId });
        const remaining = Math.min(FREE_SPIN_INTERVAL_MS, (doc?.lastFreeSpinAt ?? 0) + FREE_SPIN_INTERVAL_MS - now);
        if (remaining > 0) {
          client.send("freeSpin", { ok: false, reason: "cooldown", nextInMs: remaining });
          return;
        }
        const p = this.state.players.get(client.sessionId);
        await players.updateOne(
          { _id: userId },
          { $set: { lastFreeSpinAt: now, username: p?.username || "Player", updatedAt: new Date() }, $setOnInsert: { version: 1 } },
          { upsert: true },
        );
        client.send("freeSpin", { ok: true, nextInMs: FREE_SPIN_INTERVAL_MS });
      } catch (err) {
        console.warn("[IslandRoom] claimFreeSpin failed", err);
        client.send("freeSpin", { ok: false, reason: "error", nextInMs: 0 });
      } finally {
        this.claimingFreeSpin.delete(userId);
      }
    },
    // Re-states this connection's identity after a login/logout/account
    // switch that happens AFTER join (the common case -- a guest who signs in
    // mid-session, or a signed-in player who logs out without reloading).
    // `onJoin` only ever sees whatever was true the instant the socket opened;
    // without this, a player who logs in after joining as a guest would keep
    // `this.userIds` empty forever and `saveProgress` would silently no-op
    // for their whole session.
    identify: (client: Client, msg: { username?: string; userId?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (typeof msg?.username === "string") p.username = msg.username.slice(0, 64);
      this.setUserId(client, p, typeof msg?.userId === "string" ? msg.userId : "");
    },
    // Which scene/instance this connection is currently in (client
    // store/useGameStore.js's currentScene) -- see PlayerState.scene's own
    // comment. Sent once on connect and again on every scene change, not per
    // frame -- same human-speed cadence as setAvatar/identify.
    setScene: (client: Client, msg: { scene?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (typeof msg?.scene === "string") p.scene = msg.scene.slice(0, 32);
      // A scene change is the common way the bridge empties out (finishing,
      // falling back to the island, or just leaving) -- see
      // maybeReshuffleBridge()'s own comment for why this can't just
      // reshuffle unconditionally on every change.
      this.maybeReshuffleBridge();
    },
    // A client's foot lands on Impossible Bridge tile `tileIndex` (client
    // systems/bonusBridge.js's stepBonusBridge()). The room is the sole
    // authority on whether that lane is actually the safe one
    // (BridgeTileState.safe, set once in buildBridgeLayout()) -- this
    // message only ever reports "something touched down here", never the
    // outcome; every client (including the sender) learns the outcome back
    // over the synced state. No position validation, same trust model as
    // every other message here -- a forged index can only ever flip a
    // shared cosmetic/collision tile, it has no path to Mongo or another
    // player's saved progress.
    bridgeStep: (client: Client, msg: { tileIndex?: number }) => {
      const i = msg?.tileIndex;
      if (!Number.isInteger(i) || i < 0 || i >= this.state.bridgeTiles.length) return;
      const index = i as number;
      const t = this.state.bridgeTiles[index];
      if (t.safe) {
        t.bounced = true; // one-shot -- see BridgeTileState's own comment, never reset
        return;
      }
      if (t.broken) return; // already sprung -- a re-trigger mid-trap must not restart the re-arm clock
      t.broken = true;
      const timer = this.clock.setTimeout(() => {
        t.broken = false;
        this.bridgeBreakTimers.delete(index);
      }, BRIDGE_UNSAFE_RESET_DELAY_MS);
      this.bridgeBreakTimers.set(index, timer);
    },
    // A client fell off or timed out on the Impossible Bridge (client
    // systems/bonusBridge.js's respawnAtStart()) -- purely a "someone
    // failed" signal, no need to know who. Once BRIDGE_RESHUFFLE_AFTER_FAILS
    // failures have piled up across the whole group since the last
    // reshuffle, a brand new shared layout is due for everyone -- see
    // BRIDGE_RESHUFFLE_AFTER_FAILS's own comment for why this can't just be
    // "reset on any one fall", and bridgeReshuffleDue's for why it may not
    // actually reroll the instant this fires.
    bridgeFail: (client: Client) => {
      this.bridgeFailCount += 1;
      if (this.bridgeFailCount < BRIDGE_RESHUFFLE_AFTER_FAILS) return;
      this.bridgeFailCount = 0;
      // Don't reroll out from under whoever's still on the bridge right now
      // (almost always including the very client that just reported this
      // fail, since failing requires being there) -- flag it and let
      // maybeReshuffleBridge() fire the instant the bridge is actually empty.
      this.bridgeReshuffleDue = true;
      this.maybeReshuffleBridge();
    },
  };

  // Whether any currently-connected player is on the Impossible Bridge right
  // now (client store/useGameStore.js's currentScene === 'bonus', relayed via
  // setScene). The bridge is a single shared instance with no finer-grained
  // "standing on tile X" tracking, so this is the room's whole notion of
  // "someone's mid-attempt" for reshuffleBridge()'s sake.
  private anyPlayerOnBridge(): boolean {
    let found = false;
    this.state.players.forEach((p) => {
      if (p.scene === "bonus") found = true;
    });
    return found;
  }

  // Performs the reshuffle a bridgeFail deferred (bridgeReshuffleDue), but
  // only once nobody's left on the bridge to have it change under them --
  // see bridgeReshuffleDue's own comment. A cheap no-op call otherwise, so
  // every place the "who's on the bridge" set can shrink (setScene, onLeave)
  // can just call this unconditionally rather than duplicate the check.
  private maybeReshuffleBridge() {
    if (!this.bridgeReshuffleDue || this.anyPlayerOnBridge()) return;
    this.bridgeReshuffleDue = false;
    this.reshuffleBridge();
  }

  // Rerolls the shared Impossible Bridge layout in place -- mutates the
  // existing BridgeTileState instances (rather than replacing the array) so
  // client index i stays the same physical tile across a reshuffle, and
  // resets every tile's live state too, same as a fresh room start. Only
  // ever called via maybeReshuffleBridge() once the bridge is confirmed
  // empty, so there's no one mid-attempt left to have this change under
  // them. Cancels any pending re-arm timer first so it can't later fire and
  // flip a tile the fresh layout already set back to false.
  private reshuffleBridge() {
    for (const timer of this.bridgeBreakTimers.values()) timer.clear();
    this.bridgeBreakTimers.clear();
    const fresh = buildBridgeLayout();
    this.state.bridgeTiles.forEach((t, index) => {
      t.safe = fresh[index].safe;
      t.broken = false;
      t.bounced = false;
    });
  }

  // Kicks off the periodic global-leaderboard broadcast (see
  // refreshLeaderboard() below). Runs once immediately -- a fresh room
  // shouldn't sit on an empty board for a full LEADERBOARD_REFRESH_MS before
  // its first broadcast -- then on a timer. `this.clock` is colyseus's own
  // per-room clock, wrapped to swallow a callback's thrown/rejected error per
  // tick so one bad refresh (e.g. a transient Mongo hiccup) can't take the
  // room down.
  onCreate() {
    void this.refreshLeaderboard();
    this.clock.setInterval(() => {
      void this.refreshLeaderboard();
    }, LEADERBOARD_REFRESH_MS);
    // The Impossible Bridge's one shared layout, built once for this room's
    // whole lifetime -- see buildBridgeLayout()'s own comment.
    for (const t of buildBridgeLayout()) this.state.bridgeTiles.push(t);
  }

  onJoin(client: Client, options?: { username?: string; avatar?: string; userId?: string }) {
    // No spawn assignment -- the client already hardcodes its spawn position
    // and reports its real position in its first "move" message.
    const p = new PlayerState();
    p.username = typeof options?.username === "string" ? options.username.slice(0, 64) : "";
    // Seed the avatar from the join options too, so a client that joins is
    // rendered as the right character even before its first `setAvatar`.
    p.avatar = sanitizeAvatar(options?.avatar);
    this.state.players.set(client.sessionId, p);

    this.setUserId(client, p, options?.userId ?? "");
    // A guest join never changes this.userIds (setUserId's own early return
    // skips its refresh call in that case), but the roster still just
    // changed -- same "don't wait up to 15s" reasoning as setUserId's own
    // trigger.
    void this.refreshLeaderboard();
  }

  // Bloxity user id (client systems/bloxity.js getStableUserId()) --
  // client-trusted, same model as username/avatar. A forged id can only ever
  // read/overwrite the SENDER's own save (there is no cross-player read in
  // `saveProgress`), so this carries no more risk than every other
  // client-trusted field this room already relays. Called from both onJoin
  // and the `identify` message so a login/logout that happens mid-session is
  // handled exactly like one that happened before join.
  private setUserId(client: Client, p: PlayerState, raw: string) {
    const userId = typeof raw === "string" ? raw.slice(0, 128) : "";
    const prev = this.userIds.get(client.sessionId) || "";
    if (userId === prev) return; // no change -- e.g. a username-only identify

    if (userId) {
      // Evict any OTHER live session already claiming this account. Two
      // sessions sharing one userId would otherwise show up as two
      // leaderboard rows (refreshLeaderboard() below) and two racing Mongo
      // writers -- a hard refresh/crash leaves the old session alive for up
      // to 20s via allowReconnection (onLeave below), and a genuinely new
      // join in that window must supersede it outright rather than coexist.
      for (const [sid, uid] of this.userIds) {
        if (sid === client.sessionId || uid !== userId) continue;
        this.state.players.delete(sid);
        this.userIds.delete(sid);
        const stale = this.clients.find((c) => c.sessionId === sid);
        if (stale) {
          try {
            stale.leave(CloseCode.CONSENTED);
          } catch {
            // Already gone -- nothing to clean up.
          }
        }
      }
      this.userIds.set(client.sessionId, userId);
      this.loadProgress(client, userId, p);
    } else {
      // Logged out: stop persisting for this connection. The client flushes
      // a final saveProgress under the OLD id before sending this, so
      // nothing made while signed in is lost.
      this.userIds.delete(client.sessionId);
    }

    // Don't leave the broadcast leaderboard showing a stale/duplicate row
    // for up to LEADERBOARD_REFRESH_MS (15s) after an eviction or a fresh
    // sign-in -- the periodic timer in onCreate() would otherwise be the only
    // thing that ever corrects it, and a player who refreshes and checks the
    // board immediately can catch it mid-window.
    void this.refreshLeaderboard();
  }

  // Seeds this player's own leaderboard row immediately (rather than waiting
  // on their next `stats` packet) and sends the full saved doc back to just
  // this client, so the client can hydrate the fields IslandState doesn't
  // carry (owned/equipped hex pads, auras, owned age machines -- nobody else
  // needs to see those). A missing doc (brand-new player) or unreachable
  // Mongo both just leave the client on its own defaults.
  private async loadProgress(client: Client, userId: string, p: PlayerState) {
    const players = getPlayers();
    if (!players) return;
    try {
      const doc = await players.findOne({ _id: userId });
      if (!doc) return;
      p.speed = doc.speed ?? 0;
      p.coins = doc.coins ?? 0;
      p.rebirth = doc.rebirth ?? 0;
      // See resolveTutorialStep()'s and inferMinTutorialStep()'s own comments
      // -- corrects for a doc predating tutorialStep entirely, and for a
      // stored step that undercounts progress the doc's own stats prove.
      const tutorialStep = resolveTutorialStep(doc);
      client.send("progress", {
        speed: doc.speed ?? 0,
        rebirth: doc.rebirth ?? 0,
        coins: doc.coins ?? 0,
        ownedHexPads: doc.ownedHexPads ?? [0],
        equippedHexPad: doc.equippedHexPad ?? 0,
        ownedAuras: doc.ownedAuras ?? [],
        equippedAura: doc.equippedAura ?? null,
        ownedAgeMachines: doc.ownedAgeMachines ?? [],
        spins: doc.spins ?? 0,
        speedCoil: doc.speedCoil ?? false,
        wheelSpins: doc.wheelSpins ?? 0,
        tutorialStep,
        // Time left on the free-spin cooldown, as a duration (see claimFreeSpin).
        freeSpinInMs: Math.max(0, Math.min(FREE_SPIN_INTERVAL_MS, (doc.lastFreeSpinAt ?? 0) + FREE_SPIN_INTERVAL_MS - Date.now())),
      });
    } catch (err) {
      console.warn("[IslandRoom] loadProgress failed", err);
    }
  }

  // A deliberate `room.leave()` (client teardown()) closes with CONSENTED --
  // drop that player immediately. Anything else (WiFi blip, backgrounded tab,
  // mobile network switch) rides out via the SDK's built-in Room
  // reconnection, but that reconnection can only succeed if THIS room still
  // recognises the old session when the client comes back. Without
  // allowReconnection, every abnormal drop looked consented to the room: the
  // PlayerState was deleted on the spot, so a client reconnecting moments
  // later re-joined as a brand new player. 20s matches a generous client
  // retry-backoff ceiling.
  async onLeave(client: Client, code?: number) {
    if (code === CloseCode.CONSENTED) {
      this.state.players.delete(client.sessionId);
      this.userIds.delete(client.sessionId);
      // A disconnecting player who was on the bridge just freed it -- same
      // deferred-reshuffle check as setScene, see maybeReshuffleBridge().
      this.maybeReshuffleBridge();
      return;
    }
    try {
      await this.allowReconnection(client, 20);
      // Reconnected within the window -- same sessionId, PlayerState (and
      // userIds entry) untouched.
    } catch {
      this.state.players.delete(client.sessionId);
      this.userIds.delete(client.sessionId);
      this.maybeReshuffleBridge();
    }
  }

  // Builds and broadcasts the merged "all-time saved + currently online"
  // leaderboard. Only the server can compute this: it alone has both the
  // live roster (this.state.players) AND the sessionId->Bloxity-userId map
  // (this.userIds, deliberately NOT part of the synced schema) needed to
  // tell "this online player already IS one of the saved accounts" apart
  // from "this saved account is offline right now".
  //
  // A private, standalone method (rather than inlined in the onCreate timer)
  // so tests can call and await it directly without waiting on the interval.
  private async refreshLeaderboard() {
    // One pass over the live roster, reused for all 3 stats below, rather
    // than re-walking this.state.players per stat.
    const onlineRows: OnlineRow[] = [];
    const onlineUserIds = new Set<string>();
    this.state.players.forEach((p, sessionId) => {
      const userId = this.userIds.get(sessionId) ?? null;
      if (userId) onlineUserIds.add(userId);
      onlineRows.push({
        sessionId,
        userId,
        username: p.username || "Player",
        speed: p.speed,
        coins: p.coins,
        rebirth: p.rebirth,
      });
    });

    const players = getPlayers();
    const payload = { speed: [], coins: [], rebirth: [] } as LeaderboardPayload;

    for (const stat of LEADERBOARD_STATS) {
      // Online rows first: a currently-connected player's live value is
      // always more current than whatever their last debounced saveProgress
      // wrote to Mongo, whether they're signed in or just a guest.
      const merged: LeaderboardRow[] = dedupeOnline(onlineRows, stat).map((row) => ({
        id: row.sessionId,
        name: row.username,
        value: row[stat],
      }));

      // Then everyone who has EVER saved, minus accounts already represented
      // live above -- Mongo unreachable just means this half is skipped, same
      // degrade-to-online-only posture as every other Mongo path in this room.
      if (players) {
        try {
          const docs = await players
            .find({}, { projection: { _id: 1, username: 1, [stat]: 1 } })
            .sort({ [stat]: -1 })
            .limit(LEADERBOARD_QUERY_LIMIT)
            .toArray();

          let offlineIndex = 0;
          for (const doc of docs) {
            if (onlineUserIds.has(doc._id)) continue; // already added live, above
            // A synthetic id, not the real Bloxity _id -- there's no reader-
            // facing need to broadcast another account's raw id to every
            // client, and the client never needs an offline row's real
            // identity: a viewer is online by definition, so their own row
            // always comes from `onlineRows` above.
            merged.push({
              id: `offline:${stat}:${offlineIndex++}`,
              name: doc.username || "Player",
              value: (doc[stat] as number | undefined) ?? 0,
            });
          }
        } catch (err) {
          console.warn(`[IslandRoom] leaderboard query failed for stat=${stat}`, err);
        }
      }

      // Collapse rows sharing a display name down to one. userId-based
      // dedup above only catches a duplicate when both rows agree on the
      // SAME id; it can't catch the same Bloxity account resolving to a
      // DIFFERENT id across sessions, which would otherwise leave an
      // orphaned Mongo doc under the old id sitting alongside a fresh one
      // under the new id, both saved with the same username. Keep the
      // higher value (this account's true best-known score, wherever it's
      // actually stored) but prefer an online row's id so the client can
      // still recognise its own row via selfId.
      const byName = new Map<string, LeaderboardRow>();
      for (const row of merged) {
        const key = row.name || "Player";
        const existing = byName.get(key);
        if (!existing) {
          byName.set(key, row);
          continue;
        }
        const preferId = existing.id.startsWith("offline:") && !row.id.startsWith("offline:") ? row.id : existing.id;
        byName.set(key, { id: preferId, name: key, value: Math.max(existing.value, row.value) });
      }
      const deduped = [...byName.values()];

      deduped.sort((a, b) => b.value - a.value);
      payload[stat] = deduped.slice(0, LEADERBOARD_QUERY_LIMIT);
    }

    this.broadcast("leaderboard", payload);
  }
}
