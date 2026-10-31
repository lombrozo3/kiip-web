/**
 * The page: signs in, reads every device's copy of the library from the
 * "Kiip Library" folder in Drive, and shows it. It is one more device: its
 * changes go in its own copy, which the others merge in. Only a recorded
 * deletion removes an item, and it never records one of its own.
 */
const CLIENT_ID = "220913567746-at8pnnej1esfl0ulf9s07eim289ptun0.apps.googleusercontent.com";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER = "Kiip Library";
const COPY = /^device-.*\.json$/;
const WEB_COPY = "device-web.json";
const SAVE_DELAY_MS = 1000;
const TOAST_MS = 6000;
const IMAGE_PREFIX = "image-";
const TEXT_FILE = /^text-(.+)\.txt$/;
const TOKEN_KEY = "kiip-token";
const SPEED_KEY = "kiip-speed";
const VOICE_KEY = "kiip-voice";
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
  deletions: [],
  folder: null,
  webCopy: null, // Drive's file id for this site's own copy, once it has one
  dirty: false, // there are changes here that aren't in Drive yet
  saving: false,
  saveAgain: false,
  images: new Map(), // Drive's file id for each saved image, by its name
  texts: new Map(), // Drive's file id for each article's kept text, by the item's id
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
  if (state.dirty && !window.confirm("Some changes haven't been saved yet. Sign out and lose them?")) return;
  stopReading();
  state.dirty = false;
  setSaveStatus("");
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

async function request(url, options = {}) {
  const headers = { ...options.headers, Authorization: `Bearer ${state.token}` };
  const response = await fetch(url, { ...options, headers });
  if (response.ok) return response;
  if (response.status === 401) throw new SignInNeeded();
  throw new DriveError(response.status, `Drive said ${response.status}: ${(await response.text()).slice(0, 300)}`);
}

const drive = (path) => request(`${DRIVE}/${path}`);

class SignInNeeded extends Error {}

class DriveError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

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

/** Every device's copy from Drive, as they are now, and all the files in the folder. */
async function readCopies() {
  const files = await listFolder(state.folder);
  const copies = files.filter((file) => COPY.test(file.name));
  const read = await Promise.allSettled(copies.map(async (file) => (await drive(`files/${file.id}?alt=media`)).json()));
  const failed = read.find((result) => result.status === "rejected" && result.reason instanceof SignInNeeded);
  if (failed) throw failed.reason;
  const readable = read.filter((result) => result.status === "fulfilled").map((result) => result.value);
  if (readable.length === 0) throw new Error("No device's copy of the library could be read.");
  state.webCopy = files.find((file) => file.name === WEB_COPY)?.id || null;
  return { files, copies: readable };
}

/** What Drive has, with any changes here that it hasn't got yet. */
function brought(copies) {
  const library = KiipData.merged(state.dirty ? [...copies, { items: state.items, deletions: state.deletions }] : copies);
  state.items = library.items;
  state.deletions = library.deletions;
  return library;
}

async function load() {
  $("message").textContent = "Reading your library…";
  $("sign-in").hidden = true;
  try {
    state.folder = await findFolder();
    if (!state.folder) {
      $("sign-in").hidden = false;
      showWelcome(`Couldn't find the "${FOLDER}" folder for this account. Check you chose the account that syncs on your phone.`);
      return;
    }
    const { files, copies } = await readCopies();
    brought(copies);
    state.images = new Map(files.filter((file) => file.name.startsWith(IMAGE_PREFIX))
      .map((file) => [file.name.slice(IMAGE_PREFIX.length), file.id]));
    state.texts = new Map(files.filter((file) => TEXT_FILE.test(file.name))
      .map((file) => [TEXT_FILE.exec(file.name)[1], file.id]));
    $("sign-in").hidden = false;
    $("welcome").hidden = true;
    $("library").hidden = false;
    $("tools").hidden = false;
    show();
    if (state.dirty) save();
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

/** Puts [library] in this site's own copy in Drive, making that the first time. */
async function writeCopy(library) {
  const body = JSON.stringify(KiipData.snapshot(library));
  const json = { "Content-Type": "application/json" };
  if (state.webCopy) {
    try {
      await request(`${UPLOAD}/files/${state.webCopy}?uploadType=media&fields=id`, { method: "PATCH", headers: json, body });
      return;
    } catch (error) {
      if (!(error instanceof DriveError) || error.code !== 404) throw error;
    }
  }
  const boundary = crypto.randomUUID();
  const metadata = JSON.stringify({ name: WEB_COPY, parents: [state.folder] });
  const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--\r\n`;
  const response = await request(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body: multipart,
  });
  state.webCopy = (await response.json()).id;
}

/**
 * Sends what has changed here to Drive. The other devices' copies are read again first,
 * so what this writes has everything in it, and it can't undo their newer changes.
 */
async function save() {
  clearTimeout(saveTimer);
  if (state.saving) {
    state.saveAgain = true;
    return;
  }
  state.saving = true;
  setSaveStatus("Saving…");
  try {
    do {
      state.saveAgain = false;
      const { copies } = await readCopies();
      const library = brought(copies);
      state.dirty = false;
      await writeCopy(library);
    } while (state.saveAgain);
    setSaveStatus("Saved");
  } catch (error) {
    state.dirty = true;
    console.error(error);
    if (error instanceof SignInNeeded) {
      forgetToken();
      setSaveStatus("Sign in again to save your changes", "Sign in", signIn);
    } else {
      setSaveStatus("Couldn't save your changes", "Try again", save);
    }
  } finally {
    state.saving = false;
  }
}

let saveTimer;

/** Notes that something changed here, and saves soon, gathering quick changes into one save. */
function changed() {
  state.dirty = true;
  state.saveAgain = state.saving;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_DELAY_MS);
  setSaveStatus("Saving…");
}

function setSaveStatus(text, action, onAction) {
  const status = $("save-status");
  status.textContent = text;
  status.classList.toggle("problem", Boolean(action));
  const button = $("save-action");
  button.hidden = !action;
  button.textContent = action || "";
  button.onclick = onAction || null;
}

function replaceItem(id, changes) {
  const item = state.items.find((other) => other.id === id);
  if (!item) return null;
  const updated = KiipData.edited(item, changes, Date.now());
  state.items = state.items.map((other) => (other.id === id ? updated : other));
  changed();
  return updated;
}

let toastTimer;

function toast(text, undo) {
  $("toast-text").textContent = text;
  const action = $("toast-action");
  action.hidden = !undo;
  action.onclick = undo ? () => {
    $("toast").hidden = true;
    undo();
  } : null;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, TOAST_MS);
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

/** A card, with its Read aloud button beside rather than inside it, as buttons can't nest. */
function cardBox(item) {
  const box = el("div", "card-box");
  box.append(card(item));
  if (item.type !== "IMAGE") {
    const read = el("button", "card-read");
    read.type = "button";
    read.setAttribute("aria-label", `Read aloud: ${item.title || item.content}`);
    read.title = "Read aloud";
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
    shape.setAttribute("d", "M4 10v4h4l5 4V6L8 10H4zM16.5 9a4 4 0 0 1 0 6M19 6.5a8 8 0 0 1 0 11");
    icon.append(shape);
    read.append(icon);
    read.addEventListener("click", () => readAloud(item));
    box.append(read);
  }
  return box;
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

/** A labelled text box, with an optional hint under it. */
function field(label, control, hint) {
  const box = el("label", "field", label);
  box.append(control);
  if (hint) box.append(el("span", "field-hint", hint));
  return box;
}

function tagsInput(tags) {
  const input = el("input");
  input.value = tags.join(", ");
  input.setAttribute("list", "all-tags");
  input.autocomplete = "off";
  return input;
}

function textBox(value, rows) {
  const box = el("textarea");
  box.value = value;
  box.rows = rows;
  return box;
}

function libraryTags() {
  return KiipData.facets(state.items).tags.map((tag) => tag.key);
}

function suggestTags() {
  $("all-tags").replaceChildren(...libraryTags().map((tag) => {
    const option = el("option");
    option.value = tag;
    return option;
  }));
}

function sheetButton(text, className, onClick) {
  const button = el("button", className, text);
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

/** Saves something new: a link if it's a web address, otherwise text. */
function openAdd() {
  suggestTags();
  const sheet = $("sheet");
  const body = el("div", "sheet-body");
  const content = textBox("", 4);
  const tags = tagsInput([]);
  const note = textBox("", 2);
  body.append(el("h2", null, "Add to Kiip"), field("Link or text", content), field("Tags", tags, "Separate tags with commas."), field("Note", note));

  const actions = el("div", "sheet-actions");
  actions.append(
    sheetButton("Cancel", "quiet", () => sheet.close()),
    sheetButton("Save", null, () => {
      if (!content.value.trim()) {
        content.focus();
        return;
      }
      const existing = KiipData.saved(state.items, content.value);
      sheet.close();
      if (existing) {
        toast("That's already saved.");
        openSheet(existing);
        return;
      }
      const item = KiipData.newItem(content.value, KiipData.parseTags(tags.value, libraryTags()), note.value, Date.now(), crypto.randomUUID());
      state.items = [item, ...state.items];
      changed();
      show();
      toast(item.type === "LINK" ? "Saved. Its title and picture come from your phone when Kiip next syncs there." : "Saved.");
    }),
  );
  sheet.replaceChildren(body, actions);
  sheet.showModal();
  content.focus();
}

/** Changes an item's tags and note. */
function openEdit(item) {
  suggestTags();
  const sheet = $("sheet");
  const body = el("div", "sheet-body");
  const tags = tagsInput(item.tags || []);
  const note = textBox(item.note || "", 4);
  body.append(el("h2", null, item.title || (item.type === "IMAGE" ? "Saved image" : item.content)),
    field("Tags", tags, "Separate tags with commas."), field("Note", note));

  const actions = el("div", "sheet-actions");
  actions.append(
    sheetButton("Cancel", "quiet", () => openSheet(item)),
    sheetButton("Save", null, () => {
      const updated = replaceItem(item.id, { tags: KiipData.parseTags(tags.value, libraryTags()), note: note.value.trim() });
      show(true);
      if (updated) openSheet(updated);
      else sheet.close();
    }),
  );
  sheet.replaceChildren(body, actions);
  if (!sheet.open) sheet.showModal();
  note.focus();
}

function setTrashed(item, trashedAt) {
  replaceItem(item.id, { trashedAt });
  show(true);
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
  if (item.trashedAt) {
    actions.append(sheetButton("Restore", "quiet", () => {
      sheet.close();
      setTrashed(item, 0);
      toast("Restored.");
    }));
  } else {
    actions.append(sheetButton("Move to trash", "danger", () => {
      sheet.close();
      const { trashedAt } = item;
      setTrashed(item, Date.now());
      toast("Moved to the trash.", () => setTrashed(item, trashedAt));
    }));
  }
  if (item.type !== "IMAGE") {
    actions.append(sheetButton("Read aloud", "quiet", () => {
      sheet.close();
      readAloud(item);
    }));
  }
  actions.append(
    sheetButton("Edit", "quiet", () => openEdit(state.items.find((other) => other.id === item.id) || item)),
    sheetButton("Close", "quiet", () => sheet.close()),
  );
  if (address) {
    if (item.gone) actions.append(linkAction("Archived copy", KiipData.archiveUrl(item)));
    actions.append(linkAction(item.gone ? "Open anyway" : "Open", address));
  }
  sheet.append(body, actions);
  if (!sheet.open) sheet.showModal();
  sheet.scrollTop = 0;
}

function linkAction(text, href) {
  const link = el("a", "action", text);
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

// ---- Reading aloud -----------------------------------------------------------

const reader = { item: null, parts: [], index: 0, playing: false, run: 0, speaking: null };

function remembered(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Without storage, the choice lasts until the page closes.
  }
}

/** Starts reading [item], from its kept article text if Drive has it. */
async function readAloud(item) {
  if (!window.speechSynthesis) {
    toast("This browser can't read aloud.");
    return;
  }
  stopReading();
  const run = reader.run;
  let kept = null;
  const textFile = state.texts.get(item.id);
  if (textFile) {
    try {
      kept = await (await drive(`files/${textFile}?alt=media`)).text();
    } catch (error) {
      console.warn("Couldn't load the article's text", error);
    }
    if (run !== reader.run) return;
  }
  const { text, whole } = KiipData.reading(item, kept);
  const parts = KiipData.chunks(text);
  if (parts.length === 0) {
    toast("There's no text to read for this one.");
    return;
  }
  Object.assign(reader, { item, parts, index: 0, playing: true });
  $("player-name").textContent = item.title || item.content;
  $("player-seek").max = parts.length - 1;
  $("player").hidden = false;
  document.body.classList.add("listening");
  if (!whole) toast("Only the summary is available for this one.");
  speak();
}

/** Speaks the current piece, and carries on to the next when it ends. */
function speak() {
  const run = ++reader.run;
  speechSynthesis.cancel();
  drawReader();
  // Chrome can drop what is spoken straight after a cancel.
  setTimeout(() => {
    if (run !== reader.run) return;
    const utterance = new SpeechSynthesisUtterance(reader.parts[reader.index]);
    const voice = speechSynthesis.getVoices().find((other) => other.voiceURI === $("player-voice").value);
    if (voice) utterance.voice = voice;
    else if (reader.item.language) utterance.lang = reader.item.language;
    utterance.rate = Number($("player-speed").value);
    utterance.onend = () => {
      if (run !== reader.run) return;
      if (reader.index + 1 < reader.parts.length) {
        reader.index++;
        speak();
      } else {
        stopReading();
      }
    };
    utterance.onerror = (event) => {
      if (run !== reader.run || event.error === "interrupted" || event.error === "canceled") return;
      console.warn("Speech failed", event.error);
      stopReading();
      toast("Your browser's voice stopped reading. Try another voice.");
    };
    reader.speaking = utterance; // Chrome can drop the end of one it no longer holds
    speechSynthesis.speak(utterance);
  }, 60);
}

function drawReader() {
  $("player-seek").value = reader.index;
  $("player-play").textContent = reader.playing ? "Pause" : "Play";
  $("player-note").textContent = `Part ${(reader.index + 1).toLocaleString()} of ${reader.parts.length.toLocaleString()}`;
}

function pauseOrPlay() {
  if (reader.playing) {
    // Stopping rather than pausing, as a pause doesn't work with every browser's voices.
    reader.playing = false;
    reader.run++;
    speechSynthesis.cancel();
    drawReader();
  } else {
    reader.playing = true;
    speak();
  }
}

function goTo(index) {
  reader.index = Math.max(0, Math.min(index, reader.parts.length - 1));
  if (reader.playing) speak();
  else drawReader();
}

function stopReading() {
  reader.run++;
  reader.playing = false;
  reader.speaking = null;
  if (window.speechSynthesis) speechSynthesis.cancel();
  $("player").hidden = true;
  document.body.classList.remove("listening");
}

function listVoices() {
  const box = $("player-voice");
  const chosen = box.value || remembered(VOICE_KEY) || "";
  const options = speechSynthesis.getVoices().map((voice) => {
    const option = el("option", null, `${voice.name} (${voice.lang})`);
    option.value = voice.voiceURI;
    return option;
  });
  const standard = el("option", null, "Default");
  standard.value = "";
  box.replaceChildren(standard, ...options);
  box.value = options.some((option) => option.value === chosen) ? chosen : "";
}

function setUpReader() {
  if (!window.speechSynthesis) return;
  $("player-speed").value = remembered(SPEED_KEY) || "1";
  if (!$("player-speed").value) $("player-speed").value = "1";
  listVoices();
  speechSynthesis.addEventListener("voiceschanged", listVoices);
  $("player-play").addEventListener("click", pauseOrPlay);
  $("player-back").addEventListener("click", () => goTo(reader.index - 1));
  $("player-next").addEventListener("click", () => goTo(reader.index + 1));
  $("player-stop").addEventListener("click", stopReading);
  $("player-seek").addEventListener("change", (event) => goTo(Number(event.target.value)));
  $("player-speed").addEventListener("change", (event) => {
    remember(SPEED_KEY, event.target.value);
    if (reader.playing) speak();
  });
  $("player-voice").addEventListener("change", (event) => {
    remember(VOICE_KEY, event.target.value);
    if (reader.playing) speak();
  });
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
    shortest.append(cardBox(state.shown[state.drawn]));
  }
}

/** Draws the library as filtered and sorted now; with [keepPlace], without moving the reader. */
function show(keepPlace = false) {
  const drawn = state.drawn;
  const place = window.scrollY;
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
  if (keepPlace) {
    while (state.drawn < Math.min(drawn, state.shown.length)) drawMore();
    window.scrollTo(0, place);
  } else {
    window.scrollTo(0, 0);
  }
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
$("add").addEventListener("click", openAdd);
window.addEventListener("beforeunload", (event) => {
  if (state.dirty || state.saving) event.preventDefault();
});
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

setUpReader();
state.token = savedToken();
if (state.token) load();
