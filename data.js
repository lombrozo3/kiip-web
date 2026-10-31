/**
 * The library's data, with no page or network in it: merging the copies each
 * device keeps in Drive, making changes to it, and working out what to show.
 * The merge follows Changes.kt in the Android app, so the site acts as one
 * more device, and items are written in the same form as Library.kt's.
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
  const SNAPSHOT_VERSION = 1;
  const MAX_TEXT = 200000;
  // Speech in browsers can stop partway through long pieces, and short ones resume closer to where they stopped.
  const CHUNK_LENGTH = 180;

  /** The name a field's changes are recorded under. One differs from how the field is stored. */
  const timeKey = (field) => (field === "archiveChecked" ? "archiveTried" : field);

  /** [mine], taking each field from whichever of it and [theirs] changed it last. */
  function mergedItem(mine, theirs) {
    const merged = { ...mine };
    const myTimes = mine.fieldTimes || {};
    const theirTimes = theirs.fieldTimes || {};
    for (const field of FIELDS) {
      const myTime = myTimes[timeKey(field)] || 0;
      const theirTime = theirTimes[timeKey(field)] || 0;
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
    return {
      items: [...items.values()].filter((item) => !deletions.has(item.id)).sort((a, b) => b.time - a.time),
      deletions: [...deletions].map(([id, time]) => ({ id, time })),
    };
  }

  /** The library as a device's copy in Drive holds it. */
  function snapshot(library) {
    return { version: SNAPSHOT_VERSION, items: library.items, deletions: library.deletions };
  }

  /** [item] with [changes] made to it, each changed field noted as changed at [now]. */
  function edited(item, changes, now) {
    const fieldTimes = { ...item.fieldTimes };
    for (const [field, value] of Object.entries(changes)) {
      if (JSON.stringify(item[field]) !== JSON.stringify(value)) fieldTimes[timeKey(field)] = now;
    }
    return { ...item, ...changes, fieldTimes };
  }

  /**
   * A new link or text item, with every field a device's copy has. A link's title
   * and preview come later from the phone, as a web page can't fetch other sites.
   */
  function newItem(text, tags, note, now, id) {
    const content = text.trim();
    const link = !/\s/.test(content) && webAddress(content) !== null;
    const blank = {
      id, type: link ? "LINK" : "TEXT", content: "", time: 0, title: "", description: "", imageUrl: "",
      width: 0, height: 0, previewTried: false, collection: "", tags: [], published: 0, dateTried: false,
      trashedAt: 0, note: "", linkChecked: false, gone: false, siteName: "", archiveChecked: 0,
      summary: "", kept: 0, summarized: 0, language: "", fieldTimes: {},
    };
    return edited(blank, { content: link ? content : content.slice(0, MAX_TEXT), time: now, tags, note: note.trim() }, now);
  }

  /** Tags typed with commas between them, using the library's spelling where only the case differs. */
  function parseTags(text, libraryTags) {
    const tags = [];
    for (const typed of text.split(/[,\n]/)) {
      const tag = typed.trim().replace(/^#+/, "").trim();
      if (!tag) continue;
      const spelled = libraryTags.find((known) => known.toLowerCase() === tag.toLowerCase()) || tag;
      if (!tags.some((known) => known.toLowerCase() === spelled.toLowerCase())) tags.push(spelled);
    }
    return tags;
  }

  /** The item already holding this link or text, if there is one. */
  function saved(items, text) {
    const content = text.trim();
    return items.find((item) => item.type !== "IMAGE" && item.content === content);
  }

  function sentences(text) {
    if (typeof Intl.Segmenter === "function") {
      return [...new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(text)].map((part) => part.segment);
    }
    return text.match(/[^.!?]+[.!?]*\s*/g) || [];
  }

  /** Splits an overlong sentence at spaces. */
  function pieces(sentence) {
    const parts = [];
    let rest = sentence;
    while (rest.length > CHUNK_LENGTH) {
      const space = rest.lastIndexOf(" ", CHUNK_LENGTH);
      const cut = space > 0 ? space : CHUNK_LENGTH;
      parts.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) parts.push(rest);
    return parts;
  }

  /** [text] in short pieces along its sentences, for speaking one at a time. */
  function chunks(text) {
    const parts = [];
    let current = "";
    for (const sentence of sentences(text.replace(/\s+/g, " ").trim())) {
      for (const piece of pieces(sentence.trim())) {
        if (current && current.length + piece.length + 1 > CHUNK_LENGTH) {
          parts.push(current);
          current = "";
        }
        current = current ? `${current} ${piece}` : piece;
      }
    }
    if (current) parts.push(current);
    return parts;
  }

  /**
   * What to read aloud for [item], given its [kept] article text if there is any,
   * and whether that's the [whole] of it or only a summary of some kind.
   */
  function reading(item, kept) {
    if (item.type === "TEXT") return { text: item.content, whole: true };
    if (kept) return { text: item.title ? `${item.title}. ${kept}` : kept, whole: true };
    const short = item.summary || item.description;
    const text = [item.title, short].filter(Boolean).join(". ");
    return { text, whole: false };
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

  return { merged, snapshot, edited, newItem, parseTags, saved, chunks, reading, siteOf, webAddress, archiveUrl, matches, sorted, facets };
})();

if (typeof module !== "undefined") module.exports = KiipData;
