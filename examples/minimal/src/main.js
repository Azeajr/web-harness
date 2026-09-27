import { registerSW } from "virtual:pwa-register";

// One note, persisted in IndexedDB (the durable copy) with its save time in localStorage. Every
// control exists to give the harness something real to observe: a save that changes state, a
// disabled control that changes nothing, a dialog whose Cancel changes nothing, a file import, a
// deliberate failure, an unserved API call, and a service-worker update prompt.

const $ = (id) => document.getElementById(id);

function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("notes", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("kv");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transact(mode, work) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction("kv", mode);
      const request = work(transaction.objectStore("kv"));
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

const readNote = () => transact("readonly", (store) => store.get("note"));

async function writeNote(text) {
  const previous = await readNote();
  const note = { text, revision: (previous?.revision ?? 0) + 1 };
  await transact("readwrite", (store) => store.put(note, "note"));
  localStorage.setItem("notes.savedAt", new Date().toISOString());
  return note;
}

async function render() {
  const note = await readNote();
  $("saved").textContent = note ? note.text : "(nothing saved)";
}

$("save").addEventListener("click", async () => {
  await writeNote($("note").value);
  await render();
  $("status").textContent = "Saved";
});

$("clear").addEventListener("click", () => {
  $("note").value = "";
});

$("import").addEventListener("change", async () => {
  const file = $("import").files[0];
  if (!file) return;
  const backup = JSON.parse(await file.text());
  await writeNote(String(backup.note));
  await render();
  $("status").textContent = "Imported";
});

$("delete").addEventListener("click", () => $("confirm").showModal());
$("confirm-cancel").addEventListener("click", () => $("confirm").close());
$("confirm-delete").addEventListener("click", async () => {
  await transact("readwrite", (store) => store.delete("note"));
  $("confirm").close();
  await render();
  $("status").textContent = "Deleted";
});

// A miss must be a 404 on both targets. In production, public/404.html makes Pages (and the harness
// server) answer 404 instead of the SPA shell; in development, Vite serves the shell to any request
// that accepts HTML — fetch() sends Accept: */* — so this one asks for JSON only.
$("break").addEventListener("click", async () => {
  console.error("induced failure");
  // The token is redacted before it reaches any evidence.
  const response = await fetch("/missing.json?token=example-secret", { headers: { accept: "application/json" } }).catch(() => null);
  await response?.text();
});

// A Pages Function in production; the harness server answers 404 and must not call it a fault.
fetch("/api/sync").catch(() => null);

const updateSW = registerSW({
  onNeedRefresh() {
    $("update").hidden = false;
  },
});
$("update-reload").addEventListener("click", () => updateSW(true));
$("update-later").addEventListener("click", () => {
  $("update").hidden = true;
});

if (import.meta.env.DEV) {
  // Development-only, read-only state accessor for `web-harness state`. Never shipped: the smoke
  // fails a production build that defines it.
  window.__harness = {
    async snapshot(sections) {
      const result = {};
      if (sections.includes("note")) result.note = (await readNote()) ?? null;
      if (sections.includes("sw"))
        result.sw = { controlled: Boolean(navigator.serviceWorker?.controller) };
      return result;
    },
  };
}

await render();
document.body.dataset.ready = "true";
