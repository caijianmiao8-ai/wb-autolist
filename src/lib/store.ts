import fs from "node:fs";
import { LISTINGS_PATH, atomicWrite, quarantineCorrupt } from "./paths";
import type { Listing } from "./types";

// Simple file-backed store. Single-process, fine for a self-hosted client tool.
function readAll(): Listing[] {
  try {
    if (!fs.existsSync(LISTINGS_PATH)) return [];
    return JSON.parse(fs.readFileSync(LISTINGS_PATH, "utf8"));
  } catch {
    // parse error on an existing file → move it aside, don't overwrite history
    quarantineCorrupt(LISTINGS_PATH);
    return [];
  }
}

function writeAll(listings: Listing[]) {
  atomicWrite(LISTINGS_PATH, JSON.stringify(listings, null, 2));
}

export function listListings(): Listing[] {
  return readAll().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getListing(id: string): Listing | undefined {
  return readAll().find((l) => l.id === id);
}

export function saveListing(listing: Listing): Listing {
  const all = readAll();
  const idx = all.findIndex((l) => l.id === listing.id);
  listing.updatedAt = new Date().toISOString();
  if (idx >= 0) all[idx] = listing;
  else all.push(listing);
  writeAll(all);
  return listing;
}

export function updateListing(
  id: string,
  patch: Partial<Listing>
): Listing | undefined {
  const all = readAll();
  const idx = all.findIndex((l) => l.id === id);
  if (idx < 0) return undefined;
  all[idx] = { ...all[idx], ...patch, updatedAt: new Date().toISOString() };
  writeAll(all);
  return all[idx];
}

export function deleteListing(id: string): boolean {
  const all = readAll();
  const next = all.filter((l) => l.id !== id);
  if (next.length === all.length) return false;
  writeAll(next);
  return true;
}
