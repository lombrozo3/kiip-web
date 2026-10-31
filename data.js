/**
 * The library's data, with no page or network in it: merging the copies each
 * device keeps in Drive, and working out what to show. The merge follows
 * Changes.kt in the Android app, so the site shows what a device would.
 */
const KiipData = (() => {
  const FIELDS = [
    "content", "time", "title", "description", "imageUrl", "width", "height",
    "previewTried", "collection", "tags", "published", "dateTried", "trashedAt",
    "note", "linkChecked", "gone", "siteName", "archiveChecked", "summary",
    "summarized", "language",
  ];
  const HOST_PREFIX = /^(www\d?|m|mobile|amp|old|new|np)\./;
  const MIN_SITE_ITEMS = 2;

  /** [mine], taking each field from whichever of it and [theirs] changed it last. */
  function mergedItem(mine, theirs) {
    const merged = { ...mine };
    const myTimes = mine.fieldTimes || {};
    const theirTimes = theirs.fieldTimes || {};
    for (const field of FIELDS) {
      const myTime = myTimes[field] || 0;
      const theirTime = theirTimes[field] || 0;
      const theirsWins = theirTime > myTime ||
        (theirTime === myTime && String(theirs[field]) > String(mine[field]));
      if (theirsWins) merged[field] = theirs[field];
    }
    merged.fieldTimes = { ...myTimes };
    for (const [field, time] of Object.entries(theirTimes)) {
      merged.fieldTimes[field] = Math.max(merged.fieldTimes[field] || 0, time);
    }
    return merged;
  }

  /** Everything in [copies] as one library. Only a recorded deletion takes an item away. */
  function merged(copies) {
    const deletions = new Map();
    const items = new Map();
    for (const copy of copies) {
      for (const { id, time } of copy.deletions || []) {
        deletions.set(id, Math.max(deletions.get(id) || 0, time));
      }
      const incoming = [];
      for (const item of copy.items) {
        const mine = items.get(item.id);
        if (!mine) incoming.push(item);
        items.set(item.id, mine ? mergedItem(mine, item) : item);
      }
      // The same link or text saved on two devices has two ids; both keep the lower one.
      for (const item of incoming) {
        if (item.type === "IMAGE") continue;
        const current = items.get(item.id);
        if (!current) continue;
        const twin = [...items.values()].find((other) =>
          other.id !== item.id && other.type === item.type && other.content === item.content);
        if (!twin) continue;
        const [keep, drop] = current.id < twin.id ? [current, twin] : [twin, current];
        items.set(keep.id, {
          ...mergedItem(keep, drop),
          tags: [...new Set([...(keep.tags || []), ...(drop.tags || [])])],
        });
        items.delete(drop.id);
        deletions.set(drop.id, Math.max(deletions.get(drop.id) || 0, ...Object.values(drop.fieldTimes || {}), 0));
      }
    }
    return [...items.values()].filter((item) => !deletions.has(item.id));
  }

  /** Which website a link is from, as "theguardian.com", or null for others. */
  function siteOf(item) {
    if (item.type !== "LINK") return null;
    try {
      const site = new URL(item.content).hostname.toLowerCase().replace(HOST_PREFIX, "");
      return site === "redd.it" ? "reddit.com" : site;
    } catch {
      return null;
    }
  }

  /** [text] if it is a web address that is safe to link to, otherwise null. */
  function webAddress(text) {
    try {
      const { protocol } = new URL(text);
      return protocol === "http:" || protocol === "https:" ? text : null;
    } catch {
      return null;
    }
  }

  /** The Internet Archive's copy of a link from around the day it was saved. */
  function archiveUrl(item) {
    const day = new Date(item.time).toISOString().slice(0, 10).replaceAll("-", "");
    return `https://web.archive.org/web/${day}/${item.content}`;
  }

  /** All of an item's words, for searching. */
  function searchText(item) {
    return [item.title, item.description, item.summary, item.note, item.content, item.siteName, ...(item.tags || [])]
      .filter(Boolean).join(" ").toLowerCase();
  }

  /** Whether [item] passes [filter]: its view, site, tag and search words. */
  function matches(item, filter) {
    if (filter.view === "TRASH") {
      if (!item.trashedAt) return false;
    } else {
      if (item.trashedAt) return false;
      if (filter.view === "GONE" && !item.gone) return false;
      if (["LINK", "IMAGE", "TEXT"].includes(filter.view) && item.type !== filter.view) return false;
    }
    if (filter.site && siteOf(item) !== filter.site) return false;
    if (filter.tag && !(item.tags || []).includes(filter.tag)) return false;
    const text = searchText(item);
    return (filter.query || "").toLowerCase().split(/\s+/).filter(Boolean).every((word) => text.includes(word));
  }

  /** [items] in the order [sort] names: newest or oldest, by saved or published date. */
  function sorted(items, sort) {
    const [order, by] = sort.split("-");
    const date = by === "published" ? (item) => item.published || item.time : (item) => item.time;
    const direction = order === "newest" ? -1 : 1;
    return [...items].sort((a, b) => direction * (date(a) - date(b)));
  }

  /** How many of [items] are of each kind, and on each site and tag, most used first. */
  function facets(items) {
    const live = items.filter((item) => !item.trashedAt);
    const sites = new Map();
    const tags = new Map();
    for (const item of live) {
      const site = siteOf(item);
      if (site) {
        const entry = sites.get(site) || { key: site, count: 0, names: new Map() };
        entry.count++;
        if (item.siteName) entry.names.set(item.siteName, (entry.names.get(item.siteName) || 0) + 1);
        sites.set(site, entry);
      }
      for (const tag of item.tags || []) tags.set(tag, (tags.get(tag) || 0) + 1);
    }
    const byCount = (a, b) => b.count - a.count || a.key.localeCompare(b.key);
    return {
      counts: {
        ALL: live.length,
        LINK: live.filter((item) => item.type === "LINK").length,
        IMAGE: live.filter((item) => item.type === "IMAGE").length,
        TEXT: live.filter((item) => item.type === "TEXT").length,
        GONE: live.filter((item) => item.gone).length,
        TRASH: items.length - live.length,
      },
      sites: [...sites.values()].filter((site) => site.count >= MIN_SITE_ITEMS).map((site) => {
        const name = [...site.names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        return { key: site.key, count: site.count, name: name || (site.key === "reddit.com" ? "Reddit" : site.key) };
      }).sort(byCount),
      tags: [...tags.entries()].map(([key, count]) => ({ key, count, name: `#${key}` })).sort(byCount),
    };
  }

  return { merged, siteOf, webAddress, archiveUrl, matches, sorted, facets };
})();

if (typeof module !== "undefined") module.exports = KiipData;
