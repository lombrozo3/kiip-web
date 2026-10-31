const test = require("node:test");
const assert = require("node:assert");
const KiipData = require("../data.js");

const link = (id, content, extra = {}) => ({ id, type: "LINK", content, time: 100, tags: [], fieldTimes: {}, ...extra });

test("takes each field from the device that changed it last", () => {
  const phone = link("a", "https://a.com", { title: "New", note: "Old", fieldTimes: { title: 5, note: 1 } });
  const tablet = link("a", "https://a.com", { title: "Old", note: "New", fieldTimes: { title: 1, note: 5 } });
  const [item] = KiipData.merged([{ items: [phone] }, { items: [tablet] }]).items;
  assert.equal(item.title, "New");
  assert.equal(item.note, "New");
  assert.deepEqual(item.fieldTimes, { title: 5, note: 5 });
});

test("merging either way round gives the same fields", () => {
  const one = link("a", "https://a.com", { title: "One" });
  const two = link("a", "https://a.com", { title: "Two" });
  assert.equal(KiipData.merged([{ items: [one] }, { items: [two] }]).items[0].title,
    KiipData.merged([{ items: [two] }, { items: [one] }]).items[0].title);
});

test("the archive field's changes are read from the name the app records them under", () => {
  const phone = link("a", "https://a.com", { archiveChecked: 5, fieldTimes: { archiveTried: 9 } });
  const other = link("a", "https://a.com", { archiveChecked: 0, fieldTimes: { archiveTried: 1 } });
  assert.equal(KiipData.merged([{ items: [other] }, { items: [phone] }]).items[0].archiveChecked, 5);
  assert.equal(KiipData.merged([{ items: [phone] }, { items: [other] }]).items[0].archiveChecked, 5);
});

test("recorded deletions are kept, for writing back", () => {
  const { deletions } = KiipData.merged([
    { items: [], deletions: [{ id: "a", time: 3 }] },
    { items: [], deletions: [{ id: "a", time: 9 }, { id: "b", time: 1 }] },
  ]);
  assert.deepEqual(deletions, [{ id: "a", time: 9 }, { id: "b", time: 1 }]);
});

test("a new link has every field a device's copy has, and notes what was set", () => {
  const item = KiipData.newItem("  https://a.com/x  ", ["x"], " Mine ", 50, "id1");
  assert.equal(item.type, "LINK");
  assert.equal(item.content, "https://a.com/x");
  assert.equal(item.note, "Mine");
  assert.equal(item.previewTried, false);
  assert.deepEqual(item.fieldTimes, { content: 50, time: 50, tags: 50, note: 50 });
  assert.deepEqual(Object.keys(item).sort(), [
    "archiveChecked", "collection", "content", "dateTried", "description", "fieldTimes", "gone", "height", "id",
    "imageUrl", "kept", "language", "linkChecked", "note", "previewTried", "published", "siteName", "summarized",
    "summary", "tags", "time", "title", "trashedAt", "type", "width",
  ]);
});

test("anything that isn't a single web address is saved as text", () => {
  assert.equal(KiipData.newItem("Some words", [], "", 1, "a").type, "TEXT");
  assert.equal(KiipData.newItem("see https://a.com", [], "", 1, "a").type, "TEXT");
  assert.equal(KiipData.newItem("javascript:alert(1)", [], "", 1, "a").type, "TEXT");
});

test("an edit only marks the fields that changed", () => {
  const item = link("a", "https://a.com", { note: "Old", tags: ["x"], fieldTimes: { note: 1, title: 2 } });
  const changed = KiipData.edited(item, { note: "New", tags: ["x"] }, 50);
  assert.equal(changed.note, "New");
  assert.deepEqual(changed.fieldTimes, { note: 50, title: 2 });
  assert.equal(item.note, "Old");
});

test("an edit on the site wins over the older value on a device", () => {
  const phone = link("a", "https://a.com", { note: "Phone", fieldTimes: { note: 5 } });
  const web = KiipData.edited(phone, { note: "Web" }, 9);
  assert.equal(KiipData.merged([{ items: [phone] }, { items: [web] }]).items[0].note, "Web");
});

test("tags are tidied and use the library's spelling", () => {
  assert.deepEqual(KiipData.parseTags(" #bangkok, Food,, food ,##New", ["Bangkok"]), ["Bangkok", "Food", "New"]);
});

test("what is already saved is found, but not among images", () => {
  const items = [link("a", "https://a.com"), { id: "b", type: "IMAGE", content: "p.jpg" }];
  assert.equal(KiipData.saved(items, " https://a.com ").id, "a");
  assert.equal(KiipData.saved(items, "p.jpg"), undefined);
});

test("only a recorded deletion removes an item", () => {
  const items = [link("a", "https://a.com"), link("b", "https://b.com")];
  assert.equal(KiipData.merged([{ items }, { items: [] }]).items.length, 2);
  assert.deepEqual(KiipData.merged([{ items }, { items: [], deletions: [{ id: "a", time: 9 }] }]).items.map((i) => i.id), ["b"]);
});

test("the same link on two devices becomes one, with both sets of tags", () => {
  const first = link("b", "https://a.com", { tags: ["x"], fieldTimes: { content: 3 } });
  const second = link("a", "https://a.com", { tags: ["y"], fieldTimes: { content: 4 } });
  const { items } = KiipData.merged([{ items: [first] }, { items: [second] }]);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "a");
  assert.deepEqual(items[0].tags.sort(), ["x", "y"]);
});

test("the same image on two devices stays two", () => {
  const image = (id) => ({ id, type: "IMAGE", content: "photo.jpg", time: 1, tags: [], fieldTimes: {} });
  assert.equal(KiipData.merged([{ items: [image("a")] }, { items: [image("b")] }]).items.length, 2);
});

test("sites ignore www and the like, and redd.it counts as Reddit", () => {
  assert.equal(KiipData.siteOf(link("a", "https://www.theguardian.com/x")), "theguardian.com");
  assert.equal(KiipData.siteOf(link("a", "https://old.reddit.com/r")), "reddit.com");
  assert.equal(KiipData.siteOf(link("a", "https://redd.it/abc")), "reddit.com");
  assert.equal(KiipData.siteOf(link("a", "not a link")), null);
});

test("only web addresses can be linked to", () => {
  assert.equal(KiipData.webAddress("https://a.com/x"), "https://a.com/x");
  assert.equal(KiipData.webAddress("javascript:alert(1)"), null);
  assert.equal(KiipData.webAddress("data:text/html,hi"), null);
  assert.equal(KiipData.webAddress("not a link"), null);
});

test("search needs every word, in any field", () => {
  const item = link("a", "https://a.com", { title: "Sourdough bread", note: "Try it", tags: ["Recipes"] });
  assert.ok(KiipData.matches(item, { view: "ALL", query: "bread RECIPES try" }));
  assert.ok(!KiipData.matches(item, { view: "ALL", query: "bread cake" }));
});

test("trashed items only show in the trash", () => {
  const item = link("a", "https://a.com", { trashedAt: 5 });
  assert.ok(!KiipData.matches(item, { view: "ALL" }));
  assert.ok(KiipData.matches(item, { view: "TRASH" }));
  assert.ok(!KiipData.matches(link("b", "https://b.com"), { view: "TRASH" }));
});

test("filters by kind, broken links, site and tag together", () => {
  const item = link("a", "https://a.com", { gone: true, tags: ["x"] });
  assert.ok(KiipData.matches(item, { view: "GONE", site: "a.com", tag: "x" }));
  assert.ok(!KiipData.matches(item, { view: "TEXT" }));
  assert.ok(!KiipData.matches(item, { view: "LINK", site: "b.com" }));
  assert.ok(!KiipData.matches(item, { view: "LINK", tag: "y" }));
});

test("published sort falls back to the saved date", () => {
  const old = link("a", "https://a.com", { time: 10, published: 1 });
  const saved = link("b", "https://b.com", { time: 5 });
  assert.deepEqual(KiipData.sorted([old, saved], "newest-published").map((i) => i.id), ["b", "a"]);
  assert.deepEqual(KiipData.sorted([old, saved], "newest-saved").map((i) => i.id), ["a", "b"]);
  assert.deepEqual(KiipData.sorted([old, saved], "oldest-saved").map((i) => i.id), ["b", "a"]);
});

test("facets leave out the trash and one-off sites, and name sites by their commonest name", () => {
  const { counts, sites, tags } = KiipData.facets([
    link("a", "https://a.com/1", { siteName: "Site A", tags: ["x"] }),
    link("b", "https://a.com/2", { siteName: "Site A", tags: ["x", "y"] }),
    link("c", "https://b.com/1"),
    link("d", "https://a.com/3", { trashedAt: 1, tags: ["z"] }),
  ]);
  assert.equal(counts.ALL, 3);
  assert.equal(counts.TRASH, 1);
  assert.deepEqual(sites, [{ key: "a.com", count: 2, name: "Site A" }]);
  assert.deepEqual(tags.map((tag) => tag.key), ["x", "y"]);
});
