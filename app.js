/**
 * The page: signs in, reads every device's copy of the library from the
 * "Kiip Library" folder in Drive, and shows it. It only ever reads: nothing
 * here writes to Drive, so devices can't be affected by it.
 */
const CLIENT_ID = "220913567746-at8pnnej1esfl0ulf9s07eim289ptun0.apps.googleusercontent.com";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE = "https://www.googleapis.com/drive/v3";
const FOLDER = "Kiip Library";
const COPY = /^device-.*\.json$/;
const IMAGE_PREFIX = "image-";
const TOKEN_KEY = "kiip-token";
const PAGE_SIZE = 60;
const CARD_WIDTH = 280;
const FEW_FILTERS = 12;

const VIEWS = [
  ["ALL", "All"], ["LINK", "Links"], ["IMAGE", "Images"], ["TEXT", "Text"],
  ["GONE", "Broken links"], ["TRASH", "Trash"],
];

const $ = (id) => document.getElementById(id);

const state = {
  items: [],
  images: new Map(), // Drive's file id for each saved image, by its name
  imageUrls: new Map(), // a loaded image's address in this page, by its name
  shown: [],
  drawn: 0,
  columns: [],
  view: "ALL",
  site: null,
  tag: null,
  allSites: false,
  allTags: false,
};

// ---- Signing in -------------------------------------------------------------

/** The token from an earlier sign-in in this tab, so a reload doesn't ask again. */
function savedToken() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(TOKEN_KEY));
    return saved && saved.expires > Date.now() ? saved.token : null;
  } catch {
    return null;
  }
}

function saveToken(token, seconds) {
  try {
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token, expires: Date.now() + seconds * 1000 }));
  } catch {
    // Without storage, a reload just means signing in again.
  }
  state.token = token;
}

function forgetToken() {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing was saved, then.
  }
  state.token = null;
}

function signIn() {
  if (!window.google?.accounts?.oauth2) {
    showWelcome("Google's sign-in didn't load. Check your connection and any ad blocker, then reload.");
    return;
  }
  google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPE,
    callback: (response) => {
      if (response.error) {
        showWelcome(`Google didn't sign you in (${response.error}).`);
        return;
      }
      saveToken(response.access_token, Number(response.expires_in));
      load();
    },
    error_callback: () => showWelcome("The sign-in window closed before finishing. Try again."),
  }).requestAccessToken();
}

function signOut() {
  forgetToken();
  state.imageUrls.forEach((url) => URL.revokeObjectURL(url));
  state.imageUrls.clear();
  state.items = [];
  $("grid").replaceChildren();
  showWelcome("Signed out.");
}

function showWelcome(message) {
  $("message").textContent = message;
  $("welcome").hidden = false;
  $("library").hidden = true;
  $("tools").hidden = true;
}

// ---- Drive -----------------------------------------------------------------

async function drive(path) {
  const response = await fetch(`${DRIVE}/${path}`, { headers: { Authorization: `Bearer ${state.token}` } });
  if (response.ok) return response;
  if (response.status === 401) throw new SignInNeeded();
  throw new Error(`Drive said ${response.status}: ${(await response.text()).slice(0, 300)}`);
}

class SignInNeeded extends Error {}

async function listFolder(folder) {
  const files = [];
  let page = "";
  do {
    const query = encodeURIComponent(`'${folder}' in parents and trashed = false`);
    const fields = encodeURIComponent("nextPageToken,files(id,name)");
    const response = await drive(`files?q=${query}&fields=${fields}&pageSize=1000${page && `&pageToken=${encodeURIComponent(page)}`}`);
    const json = await response.json();
    files.push(...json.files);
    page = json.nextPageToken || "";
  } while (page);
  return files;
}

async function findFolder() {
  const query = encodeURIComponent(`name = '${FOLDER}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const response = await drive(`files?q=${query}&fields=${encodeURIComponent("files(id)")}`);
  return (await response.json()).files[0]?.id;
}

async function load() {
  $("message").textContent = "Reading your library…";
  $("sign-in").hidden = true;
  try {
    const folder = await findFolder();
    if (!folder) {
      $("sign-in").hidden = false;
      showWelcome(`Couldn't find the "${FOLDER}" folder for this account. Check you chose the account that syncs on your phone.`);
      return;
    }
    const files = await listFolder(folder);
    const copies = files.filter((file) => COPY.test(file.name));
    const read = await Promise.allSettled(copies.map(async (file) => (await drive(`files/${file.id}?alt=media`)).json()));
    const failed = read.find((result) => result.status === "rejected" && result.reason instanceof SignInNeeded);
    if (failed) throw failed.reason;
    const readable = read.filter((result) => result.status === "fulfilled").map((result) => result.value);
    if (readable.length === 0) throw new Error("No device's copy of the library could be read.");

    state.items = KiipData.merged(readable);
    state.images = new Map(files.filter((file) => file.name.startsWith(IMAGE_PREFIX))
      .map((file) => [file.name.slice(IMAGE_PREFIX.length), file.id]));
    $("sign-in").hidden = false;
    $("welcome").hidden = true;
    $("library").hidden = false;
    $("tools").hidden = false;
    show();
  } catch (error) {
    $("sign-in").hidden = false;
    if (error instanceof SignInNeeded) {
      forgetToken();
      showWelcome("Your sign-in has run out. Sign in again to carry on.");
    } else {
      console.error(error);
      showWelcome(`Couldn't read your library. ${error.message}`);
    }
  }
}

/** Fills [element] with a saved image, which has to be fetched from Drive with the sign-in. */
async function loadImage(item, element) {
  try {
    let url = state.imageUrls.get(item.content);
    if (!url) {
      const id = state.images.get(item.content);
      if (!id) return;
      url = URL.createObjectURL(await (await drive(`files/${id}?alt=media`)).blob());
      state.imageUrls.set(item.content, url);
    }
    element.src = url;
  } catch (error) {
    console.warn("Couldn't load an image", error);
  }
}

const imageWatcher = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    imageWatcher.unobserve(entry.target);
    loadImage(entry.target.item, entry.target);
  }
}, { rootMargin: "400px" });

// ---- Building things ---------------------------------------------------------

/** An element. Text only ever goes in as text, as most of it came from web pages. */
function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

function dateOf(item) {
  const date = new Date(item.published || item.time);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: sameYear ? undefined : "numeric" });
}

function fullDate(time) {
  return new Date(time).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function hostOf(item) {
  try {
    return new URL(item.content).hostname.replace(/^www\./, "");
  } catch {
    return item.content;
  }
}

/** A link's preview image, which goes away if the website won't give it. */
function previewImage(item, className) {
  if (!item.imageUrl || !KiipData.webAddress(item.imageUrl)) return null;
  const image = el("img", className);
  image.alt = "";
  image.loading = "lazy";
  image.referrerPolicy = "no-referrer";
  image.addEventListener("error", () => image.remove());
  image.src = item.imageUrl;
  return image;
}

function savedImage(item, className) {
  const image = el("img", className);
  image.alt = item.description || "Saved image";
  image.item = item;
  if (item.width > 0 && item.height > 0) image.style.aspectRatio = `${item.width} / ${item.height}`;
  imageWatcher.observe(image);
  return image;
}

function card(item) {
  const button = el("button", "card");
  button.type = "button";
  button.addEventListener("click", () => openSheet(item));
  const body = el("span", "card-body");

  if (item.type === "LINK") {
    const image = previewImage(item, "card-image");
    if (image) button.append(image);
    body.append(el("span", "card-title clamp clamp-3", item.title || item.content));
    if (item.gone) body.append(el("span", "gone", "Page gone"));
    if (item.description) body.append(el("span", "card-text clamp clamp-3", item.description));
  } else if (item.type === "IMAGE") {
    button.append(savedImage(item, "card-photo"));
    if (item.description) body.append(el("span", "card-text clamp clamp-3", item.description));
  } else {
    body.append(el("span", "clamp clamp-8", item.content));
  }
  if (item.note) body.append(el("span", "card-note clamp clamp-3", item.note));

  const meta = el("span", "card-meta");
  meta.append(el("span", "card-host", item.type === "LINK" ? hostOf(item) : ""), el("span", "card-date", dateOf(item)));
  body.append(meta);
  button.append(body);
  return button;
}

function openSheet(item) {
  const sheet = $("sheet");
  const body = el("div", "sheet-body");
  const address = item.type === "LINK" ? KiipData.webAddress(item.content) : null;

  if (item.type === "LINK") {
    const image = previewImage(item, "sheet-image");
    if (image) sheet.replaceChildren(image);
    else sheet.replaceChildren();
    body.append(el("h2", null, item.title || item.content));
    if (item.gone) body.append(el("p", "gone", "This page seems to have been removed."));
    if (item.description) body.append(el("p", null, item.description));
    if (item.summary) body.append(el("h3", null, "Summary"), el("p", null, item.summary));
  } else if (item.type === "IMAGE") {
    const image = el("img", "sheet-image");
    image.alt = item.description || "Saved image";
    loadImage(item, image);
    sheet.replaceChildren(image);
    if (item.description) body.append(el("p", null, item.description));
  } else {
    sheet.replaceChildren();
    body.append(el("p", null, item.content));
  }
  if (item.note) body.append(el("h3", null, "Your note"), el("p", null, item.note));

  const saved = `Saved ${fullDate(item.time)}`;
  body.append(el("p", "sheet-date", item.published ? `Published ${fullDate(item.published)} · ${saved}` : saved));

  if (item.tags?.length) {
    const tags = el("div", "sheet-tags");
    for (const name of item.tags) {
      const tag = el("button", "tag", `#${name}`);
      tag.type = "button";
      tag.addEventListener("click", () => {
        sheet.close();
        state.tag = name;
        show();
      });
      tags.append(tag);
    }
    body.append(tags);
  }

  const actions = el("div", "sheet-actions");
  const close = el("button", "quiet", "Close");
  close.type = "button";
  close.addEventListener("click", () => sheet.close());
  actions.append(close);
  if (address) {
    if (item.gone) actions.append(linkAction("Archived copy", KiipData.archiveUrl(item)));
    actions.append(linkAction(item.gone ? "Open anyway" : "Open", address));
  }
  sheet.append(body, actions);
  sheet.showModal();
  sheet.scrollTop = 0;
}

function linkAction(text, href) {
  const link = el("a", "action", text);
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

// ---- Showing the library -----------------------------------------------------

function filterButton(entry, pressed, onClick, disabled) {
  const button = el("button", "filter");
  button.type = "button";
  button.setAttribute("aria-pressed", String(pressed));
  button.disabled = Boolean(disabled);
  button.append(el("span", "filter-name", entry.name), el("span", "filter-count", entry.count.toLocaleString()));
  button.addEventListener("click", onClick);
  return button;
}

/** A list of sites or tags: the commonest, or all of them, and always the one that's on. */
function filterList(box, entries, active, all, onPick, onShowAll) {
  const visible = all ? entries : entries.filter((entry, i) => i < FEW_FILTERS || entry.key === active);
  box.replaceChildren(...visible.map((entry) =>
    filterButton(entry, entry.key === active, () => onPick(entry.key === active ? null : entry.key))));
  if (!all && entries.length > visible.length) {
    const more = el("button", "quiet show-all", `Show all ${entries.length.toLocaleString()}`);
    more.type = "button";
    more.addEventListener("click", onShowAll);
    box.append(more);
  }
}

function drawFilters() {
  const { counts, sites, tags } = KiipData.facets(state.items);
  $("views").replaceChildren(...VIEWS.map(([key, name]) => filterButton(
    { name, count: counts[key] },
    state.view === key,
    () => { state.view = key; show(); },
    counts[key] === 0 && key !== "ALL",
  )));
  filterList($("sites"), sites, state.site, state.allSites,
    (site) => { state.site = site; show(); },
    () => { state.allSites = true; drawFilters(); });
  filterList($("tags"), tags, state.tag, state.allTags,
    (tag) => { state.tag = tag; show(); },
    () => { state.allTags = true; drawFilters(); });
  $("sites-box").hidden = sites.length === 0;
  $("tags-box").hidden = tags.length === 0;
}

function columnCount() {
  return Math.max(1, Math.floor(($("grid").clientWidth + 12) / (CARD_WIDTH + 12)));
}

function resetColumns() {
  state.columns = Array.from({ length: columnCount() }, () => el("div", "column"));
  $("grid").replaceChildren(...state.columns);
  state.drawn = 0;
}

/** Adds the next cards, each to the shortest column, as with the phone's masonry grid. */
function drawMore() {
  const end = Math.min(state.drawn + PAGE_SIZE, state.shown.length);
  for (; state.drawn < end; state.drawn++) {
    const shortest = state.columns.reduce((a, b) => (b.offsetHeight < a.offsetHeight ? b : a));
    shortest.append(card(state.shown[state.drawn]));
  }
}

function show() {
  state.shown = KiipData.sorted(
    state.items.filter((item) => KiipData.matches(item, {
      view: state.view,
      site: state.site,
      tag: state.tag,
      query: $("search").value,
    })),
    $("sort").value,
  );
  const count = state.shown.length;
  $("result").textContent = count === 0 ? "Nothing matches." : `${count.toLocaleString()} ${count === 1 ? "item" : "items"}`;
  drawFilters();
  resetColumns();
  drawMore();
  window.scrollTo(0, 0);
}

new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting && state.drawn < state.shown.length) drawMore();
}, { rootMargin: "800px" }).observe($("more"));

let searching;
$("search").addEventListener("input", () => {
  clearTimeout(searching);
  searching = setTimeout(show, 150);
});
$("sort").addEventListener("change", show);
$("sign-in").addEventListener("click", signIn);
$("sign-out").addEventListener("click", signOut);
$("refresh").addEventListener("click", load);
$("sheet").addEventListener("click", (event) => {
  if (event.target === $("sheet")) $("sheet").close();
});

let resizing;
window.addEventListener("resize", () => {
  clearTimeout(resizing);
  resizing = setTimeout(() => {
    if (state.items.length === 0 || columnCount() === state.columns.length) return;
    const drawn = state.drawn;
    resetColumns();
    while (state.drawn < drawn) drawMore();
  }, 200);
});

state.token = savedToken();
if (state.token) load();
