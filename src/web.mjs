// The browser page, as strings: the door an unauthorised browser gets, the icon, and the page itself.
// The page's style and script are files of their own (src/web/page.css, src/web/page.js), read here
// once at import, so the checks see the script as code. src/page-server.ts serves the strings.
import * as fs from "node:fs";

/**
 * What an unauthorised browser gets. Deliberately not the token: this is the request that has not
 * proved anything. Telling you where it lives costs an attacker nothing they did not already have
 * — reading the file needs your account — and saves you a search.
 */
export const DOOR = `<!doctype html><meta charset="utf-8"><title>pi-loops</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<body style="font:15px/1.6 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;background:Canvas;color:CanvasText">
<h2 style="font-weight:600">This browser has not been here before.</h2>
<p>Run <code>pi-loops open</code> in a terminal on this machine for a link that signs this browser in.</p>
<p>Pairing another device? <code>pi-loops pair</code> shows a code.</p>
<form method="get" style="display:flex;gap:.5rem">
  <input name="pair" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" maxlength="6"
         placeholder="000000" style="font:inherit;letter-spacing:.3em;padding:.55rem .7rem;flex:1;min-width:0;border:1px solid #8886;border-radius:6px;background:transparent;color:inherit">
  <button style="font:inherit;padding:.55rem 1rem;border:1px solid #8886;border-radius:6px;background:transparent;color:inherit">enter</button>
</form>`;

/** Maskable, so Android can crop it to whatever shape the launcher uses without eating the mark. */
export const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" rx="96" fill="#111"/>
<g fill="none" stroke="#4ade80" stroke-width="34" stroke-linecap="round">
<path d="M150 190h212"/><path d="M212 190v148"/><path d="M300 190v112a36 36 0 0 0 62 24"/>
</g></svg>`;

/* ------------------------------------------------------------------ the page */

/** The page as it is on disk now. `PAGE` is this at import; with `PI_LOOPS_PAGE_DEV=1` the server reads it per request. */
export function readPage() {
	const css = fs.readFileSync(new URL("./web/page.css", import.meta.url), "utf8");
	const script = fs.readFileSync(new URL("./web/page.js", import.meta.url), "utf8");
	return String.raw`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f2f2f7">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#000000">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="manifest" href="/manifest.webmanifest">
<script>
  // Before the first paint, which is the whole reason it is up here in a tag of its own rather
  // than with the rest of the script: applied any later, the page renders light and then blinks.
  try { var t = localStorage.getItem("theme"); if (t === "dark" || t === "light") document.documentElement.dataset.theme = t; } catch (e) {}
</script>
<title>pi-loops</title>
<style>
${css}</style>
<nav id="rail" aria-label="Views">
  <span class="logo" aria-hidden="true">pl</span>
  <button type="button" id="railList" class="on" title="Inbox" aria-label="Inbox"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg></button>
  <button type="button" id="drawer" title="Loops" aria-label="Show or hide the loops" aria-expanded="true"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/></svg></button>
</nav>
<nav id="list" aria-label="Inbox">
  <div class="lhead">
    <div class="lrow"><select id="project" title="Project" aria-label="Project"></select><button type="button" id="watchFor">+ Watch for…</button><button type="button" id="newConv" class="primary">+ New</button></div>
  </div>
  <div class="lscroll" id="lscroll">
    <div id="awaySlot"></div>
    <div id="needsSlot"></div>
    <div id="convs"></div>
    <div id="cardsSlot"></div>
    <div id="startersSlot"></div>
  </div>
</nav>
<main>
  <header>
    <b id="title"></b>
    <select id="model" aria-label="Model" hidden></select>
    <select id="thinking" title="Thinking level" hidden>
      <option>off</option><option>minimal</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option><option>max</option>
    </select>
    <span class="grow">
      <span class="badge" id="queue" hidden></span>
      <span class="badge" id="cost" title="Session tokens and cost" hidden></span>
      <button id="expand" aria-label="Steps">▸<span class="lbl"> steps</span></button>
      <span id="actions">
        <button id="reload">Reload</button>
        <button id="find" aria-label="Search this conversation">Find</button>
        <button id="undo" hidden>Undo</button>
        <button id="save" title="Export this conversation as HTML">Save</button>
        <button id="share">Share</button>
        <button id="compact" hidden>Compact</button>
        <button id="resume" hidden>Resume</button>
        <button id="theme">Theme: system</button>
        <button id="notifyMe">Notifications</button>
        <button id="adddev" aria-label="Add a device">Add a device</button>
      </span>
      <span class="badge" id="status"></span>
      <button id="more" title="Conversation actions" aria-label="Conversation actions">⋯</button>
    </span>
  </header>
  <div id="findbar" hidden><input id="findq" placeholder="search this conversation…" ><span id="findn" class="notice"></span></div>
  <button id="stale" hidden></button>
  <div id="feed" role="log" aria-live="polite" aria-label="Conversation"></div>
  <div id="activitySlot"></div>
  <div id="queued" hidden aria-label="Queued for this session"></div>
  <div id="held" class="held" hidden role="status"></div>
  <form id="composer">
    <button type="button" id="newer" hidden>↓ newer</button>
    <div id="pop"></div>
    <div id="thumbs"></div>
    <div class="composer-row">
      <textarea id="input" placeholder="Message pi"></textarea>
      <button type="button" id="attach">attach</button>
      <button type="submit" id="send" class="primary">send</button>
      <button type="button" id="stop" hidden>stop</button>
    </div>
    <input type="file" id="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" multiple hidden>
  </form>
</main>
<aside id="loops" aria-label="Loops">
  <div><h2>Loops</h2><div id="auto"></div></div>
  <details id="goalBox" hidden><summary>Goal</summary><div id="goal" class="notice"></div></details>
  <details id="runtimeBox"><summary>pi-loops</summary><div id="runtime" class="notice">—</div></details>
</aside>
<footer class="sbar" aria-label="Status"><a id="sbHost" href="/background"></a></footer>
<nav class="tabs" aria-label="Panes">
  <a href="#inbox" id="tabInbox"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 13h5l2 3h4l2-3h5"/><path d="M5 5h14l2 8v6H3v-6z"/></svg><span>Inbox</span></a>
  <a href="#chat" id="tabChat"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg><span>Chat</span></a>
  <a href="#loops" id="tabLoops"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/></svg><span>Loops</span></a>
</nav>
<div id="scrim" hidden></div>
<dialog id="menu" aria-label="Conversation actions" role="dialog">
  <div id="menuBody"></div><div id="sid" class="sid"></div>
  <menu><button id="menuClose" value="close">close</button></menu>
</dialog>
<dialog id="pairdlg" aria-labelledby="pairTitle" role="dialog">
  <h3 id="pairTitle">Add a device</h3>
  <select id="pairPick" aria-label="Which address to point that device at" hidden></select>
  <div id="pairQr" class="qr"></div>
  <div id="pairCode"></div>
  <div id="pairWhere" class="notice"></div>
  <menu><button id="pairClose" value="close">close</button></menu>
</dialog>
<dialog id="detail" aria-labelledby="detailTitle" role="dialog">
  <h3 id="detailTitle"></h3><div id="detailBody"></div>
  <menu><button id="detailClose" value="close">close</button></menu>
</dialog>
<dialog id="sessdlg" aria-labelledby="sessTitle" role="dialog">
  <h3 id="sessTitle">Earlier sessions</h3>
  <div id="sessBody"></div>
  <menu><button id="sessClose" value="close">close</button></menu>
</dialog>
<dialog id="ask" aria-labelledby="askTitle" role="dialog"><form method="dialog">
  <h3 id="askTitle"></h3><pre id="askBody"></pre><div id="askWhy" class="notice" hidden></div><div id="askField"></div>
  <menu><button value="cancel">cancel</button><button value="ok" class="primary" id="askOk">approve</button></menu>
</form></dialog>
<dialog id="watch" aria-labelledby="watchTitle" role="dialog">
  <h3 id="watchTitle">Watch for…</h3>
  <div id="watchBody">
  <textarea id="watchText" rows="3" aria-label="What to watch for, and what to do" placeholder="A time or a thing to wait for, and what to do then"></textarea>
  <div id="watchEx"></div>
  <div id="watchStatus" class="notice" hidden></div>
  <div id="watchCards"></div>
  </div>
  <menu><button type="button" id="watchClose">close</button><button type="button" id="watchRead" class="primary">Read it</button></menu>
</dialog>
<script>
${script}</script>`;
}

export const PAGE = readPage();
