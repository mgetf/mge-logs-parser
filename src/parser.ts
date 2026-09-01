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
  Team,
} from "./types.ts";

const LINE_RE = /^L (\d{2})\/(\d{2})\/(\d{4}) - (\d{2}):(\d{2}):(\d{2}): (.+)$/;
const KV_RE = /\((\w+)\s+"([^"]*)"\)/g;
const PLAYER_SUFFIX_RE = /<(\d+)><(\[U:1:\d+\])><(Red|Blue)>"/g;

const KILLED_MID = " killed ";
const DAMAGE_MID = ' triggered "damage" against ';
const SHOT_FIRED_MID = ' triggered "shot_fired"';
const SHOT_HIT_MID = ' triggered "shot_hit"';

type LogPlayer = {
  name: string;
  steamId: string;
  team: Team;
  end: number;
};

function parsePlayerAt(msg: string, start: number): LogPlayer | null {
  if (start < 0 || start >= msg.length || msg[start] !== '"') return null;

  const bodyStart = start + 1;
  const suffixRe = new RegExp(PLAYER_SUFFIX_RE.source, "g");
  suffixRe.lastIndex = bodyStart;

  let m: RegExpExecArray | null;
  while ((m = suffixRe.exec(msg)) !== null) {
    const tokenEnd = m.index + m[0].length;
    const next = msg[tokenEnd];
    if (next === undefined || next === " ") {
      return {
        name: msg.slice(bodyStart, m.index),
        steamId: m[2]!,
        team: m[3] as Team,
        end: tokenEnd,
      };
    }
  }

  return null;
}

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

function oppositeTeam(team: Team): Team {
  return team === "Red" ? "Blue" : "Red";
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
  let abortRedScore: number | null = null;
  let abortBluScore: number | null = null;

  const playerMap = new Map<string, PlayerRecord>();
  const currentClass = new Map<string, string>();
  const events: (KillEvent | DamageEvent)[] = [];
  const chat: ChatMessage[] = [];

  function ensurePlayer(p: LogPlayer, startClass = "unknown"): PlayerRecord {
    let rec = playerMap.get(p.steamId);
    if (!rec) {
      rec = {
        steamId: p.steamId,
        name: p.name,
        team: p.team,
        startClass,
        won: false,
        score: 0,
        elo: null,
        stats: zeroStats(),
      };
      playerMap.set(p.steamId, rec);
    }
    return rec;
  }

  function ensureStub(steamId: string, team: Team): PlayerRecord {
    let rec = playerMap.get(steamId);
    if (!rec) {
      rec = {
        steamId,
        name: steamId,
        team,
        startClass: currentClass.get(steamId) ?? "unknown",
        won: false,
        score: 0,
        elo: null,
        stats: zeroStats(),
      };
      playerMap.set(steamId, rec);
    }
    return rec;
  }

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

        if (!playerMap.has(winnerId)) {
          const loser = loserId ? playerMap.get(loserId) : undefined;
          ensureStub(winnerId, loser ? oppositeTeam(loser.team) : "Blue");
        }
        if (loserId && !playerMap.has(loserId)) {
          const winner = playerMap.get(winnerId);
          ensureStub(loserId, winner ? oppositeTeam(winner.team) : "Red");
        }

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
      if (kv["red_score"] !== undefined && kv["blu_score"] !== undefined) {
        abortRedScore = parseInt(kv["red_score"], 10);
        abortBluScore = parseInt(kv["blu_score"], 10);
      }
      continue;
    }

    const actor = parsePlayerAt(msg, 0);
    if (!actor) continue;

    const rest = msg.slice(actor.end);

    const roleM = /^ changed role to "([^"]+)"/.exec(rest);
    if (roleM) {
      const rec = ensurePlayer(actor, roleM[1]!);
      rec.name = actor.name;
      rec.team = actor.team;
      rec.startClass = roleM[1]!;
      continue;
    }

    if (rest.startsWith(KILLED_MID)) {
      const victim = parsePlayerAt(msg, actor.end + KILLED_MID.length);
      if (victim) {
        const weaponM = /^ with "([^"]+)"/.exec(msg.slice(victim.end));
        if (weaponM) {
          const attackerSteamId = actor.steamId;
          const victimSteamId = victim.steamId;
          const weapon = weaponM[1]!;
          const kv = extractKVs(msg);
          const headshot = kv["customkill"] === "headshot";
          const airshot = kv["airshot"] === "1";

          events.push({
            type: "kill",
            timestamp: ts,
            attackerSteamId,
            victimSteamId,
            weapon,
            headshot,
            airshot,
          });

          const attacker = ensurePlayer(actor, currentClass.get(attackerSteamId) ?? "unknown");
          attacker.stats.kills++;
          if (headshot) attacker.stats.headshotKills++;
          ensureWeapon(attacker.stats, weapon).kills++;

          const victimRec = ensurePlayer(victim, currentClass.get(victimSteamId) ?? "unknown");
          victimRec.stats.deaths++;
        }
      }
      continue;
    }

    if (rest.startsWith(DAMAGE_MID)) {
      const victim = parsePlayerAt(msg, actor.end + DAMAGE_MID.length);
      if (victim) {
        const kv = extractKVs(msg);
        const damage = parseInt(kv["damage"] ?? "0", 10);
        const realDamage = parseInt(kv["realdamage"] ?? "0", 10);
        const weapon = kv["weapon"] ?? "unknown";
        const headshot = kv["headshot"] === "1";
        const airshot = kv["airshot"] === "1";

        events.push({
          type: "damage",
          timestamp: ts,
          attackerSteamId: actor.steamId,
          victimSteamId: victim.steamId,
          damage,
          realDamage,
          weapon,
          headshot,
          airshot,
        });

        const attacker = ensurePlayer(actor, currentClass.get(actor.steamId) ?? "unknown");
        attacker.stats.damageDone += damage;
        if (airshot) attacker.stats.airshots++;
        const wb = ensureWeapon(attacker.stats, weapon);
        wb.damage += damage;

        const victimRec = ensurePlayer(victim, currentClass.get(victim.steamId) ?? "unknown");
        victimRec.stats.damageReceived += damage;
      }
      continue;
    }

    if (rest.startsWith(SHOT_FIRED_MID)) {
      const kv = extractKVs(msg);
      const weapon = kv["weapon"] ?? "unknown";
      const p = ensurePlayer(actor, currentClass.get(actor.steamId) ?? "unknown");
      p.stats.shotsFired++;
      ensureWeapon(p.stats, weapon).shotsFired++;
      continue;
    }

    if (rest.startsWith(SHOT_HIT_MID)) {
      const kv = extractKVs(msg);
      const weapon = kv["weapon"] ?? "unknown";
      const p = ensurePlayer(actor, currentClass.get(actor.steamId) ?? "unknown");
      p.stats.shotsHit++;
      ensureWeapon(p.stats, weapon).shotsHit++;
      continue;
    }

    const spawnM = /^ spawned as "([^"]+)"/.exec(rest);
    if (spawnM) {
      currentClass.set(actor.steamId, spawnM[1]!);
      continue;
    }

    const sayM = /^ (say_team|say) "(.*)"/.exec(rest);
    if (sayM) {
      chat.push({
        timestamp: ts,
        steamId: actor.steamId,
        scope: sayM[1] === "say_team" ? "team" : "all",
        message: sayM[2]!,
      });
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
    for (const p of players) {
      p.won = false;
      if (abortRedScore !== null && abortBluScore !== null) {
        p.score = p.team === "Red" ? abortRedScore : abortBluScore;
      }
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
