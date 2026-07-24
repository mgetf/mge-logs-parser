import type {
  ParsedMatch,
  MatchMeta,
  PlayerRecord,
  PlayerStats,
  KillEvent,
  DamageEvent,
  ChatMessage,
  WeaponStats,
  Gamemode,
} from "./types.ts";

const LINE_RE = /^L (\d{2})\/(\d{2})\/(\d{4}) - (\d{2}):(\d{2}):(\d{2}): (.+)$/;
const KV_RE = /\((\w+)\s+"([^"]*)"\)/g;
const ROLE_RE = /^"([^<]*)<\d+><(\[U:1:\d+\])><(Red|Blue)>" changed role to "([^"]+)"/;
const KILL_RE = /^"[^<]*<\d+><(\[U:1:\d+\])><(?:Red|Blue)>" killed "[^<]*<\d+><(\[U:1:\d+\])><(?:Red|Blue)>" with "([^"]+)"/;
const DAMAGE_RE = /^"[^<]*<\d+><(\[U:1:\d+\])><(?:Red|Blue)>" triggered "damage" against "[^<]*<\d+><(\[U:1:\d+\])><(?:Red|Blue)>"/;
const SHOT_FIRED_RE = /^"[^<]*<\d+><(\[U:1:\d+\])><(?:Red|Blue)>" triggered "shot_fired"/;
const SHOT_HIT_RE = /^"[^<]*<\d+><(\[U:1:\d+\])><(?:Red|Blue)>" triggered "shot_hit"/;
const SPAWN_RE = /^"[^<]*<\d+><(\[U:1:\d+\])><(?:Red|Blue)>" spawned as "([^"]+)"/;
const SAY_RE = /^"[^<]*<\d+><(\[U:1:\d+\])><(?:Red|Blue)>" (say|say_team) "(.*)"/;

function makeTs(mm: string, dd: string, yyyy: string, hh: string, min: string, ss: string): string {
  return `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}Z`;
}

function extractKVs(msg: string): Record<string, string> {
  const out: Record<string, string> = {};
  KV_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = KV_RE.exec(msg)) !== null) {
    out[m[1]!] = m[2]!;
  }
  return out;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function ensureWeapon(stats: PlayerStats, weapon: string): WeaponStats {
  if (!stats.weaponBreakdown[weapon]) {
    stats.weaponBreakdown[weapon] = { kills: 0, damage: 0, shotsFired: 0, shotsHit: 0 };
  }
  return stats.weaponBreakdown[weapon]!;
}

function zeroStats(): PlayerStats {
  return {
    kills: 0,
    deaths: 0,
    damageDone: 0,
    damageReceived: 0,
    dpm: 0,
    shotsFired: 0,
    shotsHit: 0,
    accuracy: null,
    airshots: 0,
    headshotKills: 0,
    weaponBreakdown: {},
    medicStats: null,
  };
}

export function parse(logText: string): ParsedMatch {
  const lines = logText.replace(/\r\n/g, "\n").split("\n");

  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let lastTs = "";

  let matchId = "";
  let map = "";
  let arena = "";
  let gamemode: Gamemode = "mge";
  let fragLimit = 0;
  let aborted = false;
  let abortReason: MatchMeta["abortReason"] = null;

  const playerMap = new Map<string, PlayerRecord>();
  const currentClass = new Map<string, string>();
  const events: (KillEvent | DamageEvent)[] = [];
  const chat: ChatMessage[] = [];

  for (const line of lines) {
    const lm = LINE_RE.exec(line);
    if (!lm) continue;

    const [, mm, dd, yyyy, hh, min, ss, msg] = lm as unknown as [
      string, string, string, string, string, string, string, string,
    ];
    const ts = makeTs(mm, dd, yyyy, hh, min, ss);
    if (!startedAt) startedAt = ts;
    lastTs = ts;

    if (msg.includes('"meta_data"') && !matchId) {
      const kv = extractKVs(msg);
      matchId = kv["matchid"] ?? "";
      map = kv["map"] ?? "";
      arena = kv["arena"] ?? "";
      gamemode = (kv["gamemode"] ?? "mge") as Gamemode;
      fragLimit = parseInt(kv["fraglimit"] ?? "0", 10);
      continue;
    }

    if (msg.includes('"mge_match_end"')) {
      endedAt = ts;
      const kv = extractKVs(msg);

      if (kv["winner"]) {
        const winnerId = kv["winner"]!;
        const loserId = kv["loser"];
        const winScore = parseInt(kv["winner_score"] ?? "0", 10);
        const loseScore = parseInt(kv["loser_score"] ?? "0", 10);
        for (const [id, p] of playerMap) {
          if (id === winnerId) {
            p.won = true;
            p.score = winScore;
          } else if (!loserId || id === loserId) {
            p.won = false;
            p.score = loseScore;
          }
        }
      } else if (kv["winning_team"]) {
        const winScore = parseInt(kv["winning_score"] ?? "0", 10);
        const loseScore = parseInt(kv["losing_score"] ?? "0", 10);
        const winners = new Set([kv["winner_p1"], kv["winner_p2"]]);
        for (const [id, p] of playerMap) {
          if (winners.has(id)) {
            p.won = true;
            p.score = winScore;
          } else {
            p.won = false;
            p.score = loseScore;
          }
        }
      }
      continue;
    }

    if (msg.includes('"mge_elo_delta"')) {
      const kv = extractKVs(msg);
      const pid = kv["player"];
      if (pid) {
        const p = playerMap.get(pid);
        if (p) {
          const before = parseInt(kv["old_elo"] ?? "0", 10);
          const after = parseInt(kv["new_elo"] ?? "0", 10);
          p.elo = { before, after, delta: after - before };
        }
      }
      continue;
    }

    if (msg.includes('"mge_match_aborted"')) {
      aborted = true;
      endedAt = ts;
      const kv = extractKVs(msg);
      abortReason = (kv["reason"] ?? null) as MatchMeta["abortReason"];
      continue;
    }

    const rm = ROLE_RE.exec(msg);
    if (rm) {
      const [, rawName, steamId, team, startClass] = rm as unknown as [string, string, string, string, string];
      const name = rawName.replace(/"$/, "");
      if (!playerMap.has(steamId)) {
        playerMap.set(steamId, {
          steamId,
          name,
          team: team as "Red" | "Blue",
          startClass,
          won: false,
          score: 0,
          elo: null,
          stats: zeroStats(),
        });
      }
      continue;
    }

    const km = KILL_RE.exec(msg);
    if (km) {
      const [, attackerSteamId, victimSteamId, weapon] = km as unknown as [string, string, string, string];
      const kv = extractKVs(msg);
      const headshot = kv["customkill"] === "headshot";
      const airshot = kv["airshot"] === "1";

      events.push({ type: "kill", timestamp: ts, attackerSteamId, victimSteamId, weapon, headshot, airshot });

      const attacker = playerMap.get(attackerSteamId);
      if (attacker) {
        attacker.stats.kills++;
        if (headshot) attacker.stats.headshotKills++;
        ensureWeapon(attacker.stats, weapon).kills++;
      }
      const victim = playerMap.get(victimSteamId);
      if (victim) victim.stats.deaths++;
      continue;
    }

    const dm = DAMAGE_RE.exec(msg);
    if (dm) {
      const [, attackerSteamId, victimSteamId] = dm as unknown as [string, string, string];
      const kv = extractKVs(msg);
      const damage = parseInt(kv["damage"] ?? "0", 10);
      const realDamage = parseInt(kv["realdamage"] ?? "0", 10);
      const weapon = kv["weapon"] ?? "unknown";
      const headshot = kv["headshot"] === "1";
      const airshot = kv["airshot"] === "1";

      events.push({ type: "damage", timestamp: ts, attackerSteamId, victimSteamId, damage, realDamage, weapon, headshot, airshot });

      const attacker = playerMap.get(attackerSteamId);
      if (attacker) {
        attacker.stats.damageDone += damage;
        if (airshot) attacker.stats.airshots++;
        const wb = ensureWeapon(attacker.stats, weapon);
        wb.damage += damage;
      }
      const victim2 = playerMap.get(victimSteamId);
      if (victim2) victim2.stats.damageReceived += damage;
      continue;
    }

    const sfm = SHOT_FIRED_RE.exec(msg);
    if (sfm) {
      const [, steamId] = sfm as unknown as [string, string];
      const kv = extractKVs(msg);
      const weapon = kv["weapon"] ?? "unknown";
      const p = playerMap.get(steamId);
      if (p) {
        p.stats.shotsFired++;
        ensureWeapon(p.stats, weapon).shotsFired++;
      }
      continue;
    }

    const shm = SHOT_HIT_RE.exec(msg);
    if (shm) {
      const [, steamId] = shm as unknown as [string, string];
      const kv = extractKVs(msg);
      const weapon = kv["weapon"] ?? "unknown";
      const p = playerMap.get(steamId);
      if (p) {
        p.stats.shotsHit++;
        ensureWeapon(p.stats, weapon).shotsHit++;
      }
      continue;
    }

    const spm = SPAWN_RE.exec(msg);
    if (spm) {
      const [, steamId, cls] = spm as unknown as [string, string, string];
      currentClass.set(steamId, cls);
      continue;
    }

    const saym = SAY_RE.exec(msg);
    if (saym) {
      const [, steamId, verb, message] = saym as unknown as [string, string, string, string];
      chat.push({
        timestamp: ts,
        steamId,
        scope: verb === "say_team" ? "team" : "all",
        message,
      });
      continue;
    }
  }

  const resolvedStart = startedAt ?? new Date(0).toISOString();
  const resolvedEnd = endedAt ?? lastTs ?? resolvedStart;
  const durationSeconds =
    (new Date(resolvedEnd).getTime() - new Date(resolvedStart).getTime()) / 1000;

  const minutes = durationSeconds / 60;
  for (const p of playerMap.values()) {
    p.stats.dpm = round1(p.stats.damageDone / minutes);
    p.stats.accuracy =
      p.stats.shotsFired > 0
        ? round1((p.stats.shotsHit / p.stats.shotsFired) * 100)
        : null;
  }

  const players = Array.from(playerMap.values());
  const format = players.length <= 2 ? "1v1" : "2v2";

  if (aborted) {
    if (format === "2v2" && players.length === 4) {
      const red = players.filter((p) => p.team === "Red");
      const blue = players.filter((p) => p.team === "Blue");
      const redKills = red.reduce((sum, p) => sum + p.stats.kills, 0);
      const blueKills = blue.reduce((sum, p) => sum + p.stats.kills, 0);
      const winners = redKills >= blueKills ? red : blue;
      const losers = redKills >= blueKills ? blue : red;
      for (const p of winners) { p.won = true; p.score = p.stats.kills; }
      for (const p of losers) { p.score = p.stats.kills; }
    } else {
      const sorted = [...players].sort((a, b) => b.stats.kills - a.stats.kills);
      if (sorted.length > 0) sorted[0]!.won = true;
      for (const p of players) { p.score = p.stats.kills; }
    }
  }

  const meta: MatchMeta = {
    matchId,
    map,
    arena,
    gamemode,
    fragLimit,
    format,
    startedAt: resolvedStart,
    endedAt: resolvedEnd,
    durationSeconds,
    aborted,
    abortReason,
  };

  return { meta, players, events, chat };
}
