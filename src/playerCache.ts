import { crypto } from "@std/crypto";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { cacheSize, playerScriptFetches } from "./metrics.ts";
import { extractPlayerId, getTimestamp } from "./utils.ts";

const ignorePlayerScriptRegion = Deno.env.get("IGNORE_SCRIPT_REGION") === "true";

function getCachePrefix(): string {
    // Windows
    if (Deno.build.os === "windows") {
        const localAppData = Deno.env.get("LOCALAPPDATA");
        const TMP = Deno.env.get("TMP");
        const TEMP = Deno.env.get("TEMP");

        if (localAppData) {
            return join(localAppData, "yt-cipher");
        } else if (TEMP) {
            return join(TEMP, "yt-cipher");
        } else if (TMP) {
            return join(TMP, "yt-cipher");
        }

        throw new Error("Unable to determine cache directory");
    }

    // XDG standard (Linux, optional on others)
    const XDG_CACHE_HOME = Deno.env.get("XDG_CACHE_HOME");

    // macOS / Linux fallback
    const HOME = Deno.env.get("HOME");

    if (XDG_CACHE_HOME) {
        return join(XDG_CACHE_HOME, "yt-cipher");
    } else if (HOME) {
        return join(HOME, ".cache", "yt-cipher");
    }

    return Deno.cwd();
}

export const CACHE_DIR = join(getCachePrefix(), "player_cache");

export async function getPlayerFilePath(playerUrl: string): Promise<string> {
    let cacheKey: string;
    if (ignorePlayerScriptRegion) {
        // I have not seen any scripts that differ between regions so this should be safe
        const playerId = extractPlayerId(playerUrl);
        // If we can't reliably extract an id, fall back to hashing the full URL to avoid cache key collisions.
        if (!playerId || playerId === "unknown") {
            const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(playerUrl));
            cacheKey = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
        } else {
            cacheKey = playerId;
        }
    } else {
        // This hash of the player script url will mean that diff region scripts are treated as unequals, even for the same version #
        // I dont think I have ever seen 2 scripts of the same version differ between regions but if they ever do this will catch it
        // As far as player script access, I haven't ever heard about YT ratelimiting those either so ehh
        const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(playerUrl));
        cacheKey = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    const safeKey = cacheKey.replace(/[^a-zA-Z0-9_\-]/g, '_');
    const filePath = join(CACHE_DIR, `${safeKey}.js`);

    try {
        const stat = await Deno.stat(filePath);
        // updated time on file mark it as recently used.
        await Deno.utime(filePath, new Date(), stat.mtime ?? new Date());
        return filePath;
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            console.log(`[${getTimestamp()}] Cache miss for player: ${playerUrl}. Fetching...`);
            const response = await fetch(playerUrl);
            playerScriptFetches.labels({
                player_url: playerUrl,
                status: response.statusText,
            }).inc();
            if (!response.ok) {
                throw new Error(
                    `Failed to fetch player from ${playerUrl}: ${response.statusText}`,
                );
            }
            const playerContent = await response.text();
            await Deno.writeTextFile(filePath, playerContent);

            // Update cache size for metrics
            let fileCount = 0;
            for await (const _ of Deno.readDir(CACHE_DIR)) {
                fileCount++;
            }
            cacheSize.labels({ cache_name: "player" }).set(fileCount);

            console.log(`[${getTimestamp()}] Saved player to cache: ${filePath}`);
            return filePath;
        }
        throw error;
    }
}

export async function initializeCache() {
    await ensureDir(CACHE_DIR);

    // Since these accumulate over time just cleanout 14 day unused ones
    let fileCount = 0;
    const twoWeeks = 14 * 24 * 60 * 60 * 1000;
    console.log(`[${getTimestamp()}] Cleaning up player cache directory: ${CACHE_DIR}`);
    for await (const dirEntry of Deno.readDir(CACHE_DIR)) {
        if (dirEntry.isFile) {
            const filePath = join(CACHE_DIR, dirEntry.name);
            const stat = await Deno.stat(filePath);
            const lastAccessed = stat.atime?.getTime() ??
                stat.mtime?.getTime() ?? stat.birthtime?.getTime();
            if (lastAccessed && (Date.now() - lastAccessed > twoWeeks)) {
                console.log(`[${getTimestamp()}] Deleting stale player cache file: ${filePath}`);
                await Deno.remove(filePath);
            } else {
                fileCount++;
            }
        }
    }
    cacheSize.labels({ cache_name: "player" }).set(fileCount);
    console.log(`[${getTimestamp()}] Player cache directory ensured at: ${CACHE_DIR}`);
}
