// The browser page, as strings: the door an unauthorised browser gets, the icon, and the page itself.
// Nothing here runs. src/page-server.ts serves them.

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
<p>Start the session from a terminal on this machine and it will open a window that works from
then on:</p>
<pre style="background:#8881;padding:.7rem 1rem;border-radius:6px;overflow:auto">pi-loops</pre>
<p style="opacity:.7">On a browser that is already signed in, press <b>add device</b> — it shows a
QR to point this camera at, and the same six digits to type if you would rather. Either way, this
device stays signed in afterwards.</p>
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

export const PAGE = String.raw`<!doctype html>
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
/* tokens: */
/* Inspire's palette. Three paper levels instead of borders (--bg, --panel, --panel2), one amber for
   what you can act on (--brand), and colour for state only: a hue other than amber is a fault. Every
   surface is stated, so the page looks the same on a machine whose default background is not white,
   and dark is a design rather than an inversion of light. The Background view reads this block too. */
:root{
  color-scheme:light;
  --bg:#f2f2f7;--nav:#f2f2f7;--panel:#ffffff;--panel2:#efeff4;--hover:rgb(118 118 128 / .08);--line:#d1d1d6;
  --fg:#111111;--dim:#636366;--brand:#9a5500;--brand-ink:#ffffff;--brand-soft:rgb(154 85 0 / .1);
  --ok:#3c3c43;--quiet:#aeaeb2;--bad:#b3261e;--bad-soft:rgb(179 38 30 / .08);--code:#f2f2f7;--shadow:rgb(0 0 0 / .08);
  /* Two fonts, because there are two kinds of text here. Prose — what the model wrote, what you
     wrote — reads better proportional, Chinese especially. Anything that came from a terminal or
     has columns in it stays monospace, and that stack names CJK faces whose characters are exactly
     twice the ASCII advance: without one, a box a terminal drew comes apart on the first Chinese
     character. */
  --font-ui:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  --font-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Sarasa Mono SC","Noto Sans Mono CJK SC","Source Han Mono SC",monospace;
}
@media (prefers-color-scheme:dark){html:not([data-theme=light]){
  color-scheme:dark;
  --bg:#000000;--nav:#000000;--panel:#1c1c1e;--panel2:#2c2c2e;--hover:rgb(118 118 128 / .24);--line:#38383a;
  --fg:#f2f2f7;--dim:#98989f;--brand:#ffb340;--brand-ink:#1c1200;--brand-soft:rgb(255 179 64 / .16);
  --ok:#d1d1d6;--quiet:#636366;--bad:#ff8a80;--bad-soft:rgb(255 138 128 / .12);--code:#000000;--shadow:rgb(0 0 0 / .25);
}}
html[data-theme=dark]{
  color-scheme:dark;
  --bg:#000000;--nav:#000000;--panel:#1c1c1e;--panel2:#2c2c2e;--hover:rgb(118 118 128 / .24);--line:#38383a;
  --fg:#f2f2f7;--dim:#98989f;--brand:#ffb340;--brand-ink:#1c1200;--brand-soft:rgb(255 179 64 / .16);
  --ok:#d1d1d6;--quiet:#636366;--bad:#ff8a80;--bad-soft:rgb(255 138 128 / .12);--code:#000000;--shadow:rgb(0 0 0 / .25);
}
/* The names the page's rules were written with, each one of the tokens above. On the root, beside
   the tokens, so each follows the scheme the root is in. --faint is label text, so it is --dim:
   --quiet is too faint to read on --panel2 and is for dots only. */
:root{--side:var(--panel);--field:var(--panel);--soft:var(--panel2);--ink:var(--fg);--muted:var(--dim);--faint:var(--dim);--line-strong:var(--line);--warn:var(--brand)}
/* :tokens */
:root{
  /* One column of text, centred, however wide the window is: a 2000px line is not readable. The
     composer uses the same figure so the two line up. */
  --pad:max(16px,calc((100% - 58rem) / 2));
}
*{box-sizing:border-box}
/* dvh, not vh: a phone's address bar slides away and 100vh keeps counting the space it used to
   occupy, so the composer sits below the fold exactly when you are trying to type into it. */
/* The frame: the rail, this project's conversations, the conversation, its loops; the status bar
   under all four. The paper says where one ends and the next starts, not a border. */
body{margin:0;height:100vh;height:100dvh;display:grid;grid-template-columns:56px 300px minmax(0,1fr) 290px;grid-template-rows:minmax(0,1fr) 30px;overflow:hidden;background:var(--bg);color:var(--ink);font:15px/1.62 var(--font-ui);-webkit-font-smoothing:antialiased}
/* The loops rail given back to the conversation (the rail's Loops button, remembered). */
body:has(#loops.hidden){grid-template-columns:56px 300px minmax(0,1fr)}
/* A container, so the header can tell how wide the conversation is, whatever is beside it. */
main{grid-column:3;grid-row:1;display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--bg);container-type:inline-size}

#rail{grid-column:1;grid-row:1;background:var(--nav);display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 0;min-height:0}
#rail .logo{width:30px;height:30px;border-radius:8px;background:var(--brand);color:var(--brand-ink);display:grid;place-items:center;font:700 13px var(--font-mono);margin-bottom:8px}
#rail button,#rail a{width:40px;height:40px;min-height:0;border:0;border-radius:8px;padding:0;background:transparent;color:var(--dim);display:grid;place-items:center;text-decoration:none}
#rail button:hover,#rail a:hover{background:var(--hover);color:var(--fg)}
#rail .on,#rail button[aria-expanded=true]{background:var(--brand-soft);color:var(--brand)}
svg.i{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}

#list{grid-column:2;grid-row:1;background:var(--panel);display:flex;flex-direction:column;min-width:0;min-height:0}
.lhead{padding:12px 12px 10px;display:grid;gap:10px}
.lrow{display:flex;gap:8px;align-items:center;min-width:0}
#project{flex:1;min-width:0;border:0;border-radius:8px;padding:6px 10px;font-weight:600;background:var(--panel2);color:var(--fg)}
#project option{background:Canvas;color:CanvasText}
#newConv{white-space:nowrap}
.seg{display:flex;background:var(--panel2);border-radius:8px;padding:3px;gap:2px}
.seg button{flex:1;border:0;background:transparent;border-radius:6px;padding:5px 2px;min-height:0;font-size:12.5px;color:var(--dim);display:flex;justify-content:center;gap:5px;align-items:center;white-space:nowrap}
.seg button:hover{background:transparent;color:var(--fg)}
.seg button.on{background:var(--panel);color:var(--fg);box-shadow:0 1px 2px var(--shadow)}
.pill{font-size:10.5px;line-height:1.5;border-radius:9px;padding:0 6px;background:var(--hover);color:var(--fg);font-weight:600}
.pill:empty{display:none}
.pill.hot{background:var(--brand);color:var(--brand-ink)}
.lscroll{overflow-y:auto;min-height:0;flex:1;padding:0 10px 16px;display:flex;flex-direction:column;gap:2px}
#awaySlot:empty,#startersSlot:empty,#cardsSlot:empty,#activitySlot:empty{display:none}
/* Loop activity: one line between the conversation and the composer, a list under it when opened.
   Colour for state only: a failure is the error token, the rest is dim. Nothing scrolls sideways. */
#activitySlot{flex:none;background:var(--panel2);font-size:12.5px;color:var(--dim);min-width:0;max-width:100%}
#activitySlot .strip-head{display:flex;gap:6px;align-items:center;width:100%;min-height:32px;padding:4px 12px;border:0;border-radius:0;background:transparent;color:var(--dim);text-align:left;white-space:nowrap;overflow:hidden;min-width:0}
#activitySlot .strip-head span{overflow:hidden;text-overflow:ellipsis;min-width:0;flex:none}
#activitySlot .strip-head span:first-child{flex:0 1 auto}
#activitySlot .chev{margin-left:auto}
#activitySlot .bad{color:var(--bad)}
#activitySlot ul{list-style:none;margin:0;padding:0 12px 8px;max-height:40vh;overflow-y:auto;overflow-x:hidden;display:grid;gap:2px}
#activitySlot li{display:flex;gap:6px;min-width:0;white-space:nowrap}
#activitySlot li[data-inb]{cursor:pointer}
#activitySlot li .t{overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1;color:var(--fg)}
#activitySlot li.bad .t,#activitySlot li.bad .mark{color:var(--bad)}
#activitySlot li .when{flex:none;font-variant-numeric:tabular-nums}
#cardsSlot{padding:6px 0;font-size:12.5px;color:var(--dim);display:grid;gap:6px;min-width:0}
/* An inbox finding as a card: the second paper on the list's, no border; amber only on the flag and
   on the one button to press. Text wraps whole, whatever is in it: nothing in a card scrolls sideways. */
.icard{background:var(--panel2);border-radius:10px;padding:10px;display:grid;gap:6px;color:var(--fg);font-size:13px;min-width:0;max-width:100%;overflow-wrap:anywhere}
.icard .ih{display:flex;gap:6px;align-items:baseline;min-width:0}
.icard .ih b{font-weight:600;flex:1;min-width:0}
.icard .flag{color:var(--brand);flex:none}
.icard .vf,.icard .when{color:var(--dim);font-size:11px;flex:none}
.icard .chip{flex:none;font-size:11px;color:var(--dim);background:var(--hover);border-radius:999px;padding:1px 8px}
.icard .ib{margin:0;color:var(--fg)}
.icard dl{margin:0;display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 8px}
.icard dt{color:var(--dim);font-size:12px}
.icard dd{margin:0;min-width:0}
.icard .dim{color:var(--dim)}
.icard .im{color:var(--dim);font-size:12px}
.icard .acts,.icard .why{display:flex;flex-wrap:wrap;gap:6px}
.icard .why[hidden]{display:none}
.icard button{min-height:32px;padding:4px 10px;font-size:12.5px;border-radius:8px;max-width:100%}
.icard button:disabled{opacity:.45;cursor:default}
.icard button:disabled:not(.primary):hover{background:transparent;color:var(--muted)}
.icard button.primary:disabled:hover{background:var(--brand);color:var(--brand-ink);filter:none}
.icard input{flex:1 1 12rem;min-width:0;min-height:32px;border:1px solid var(--line);border-radius:8px;padding:4px 8px;background:var(--panel);color:var(--fg);font:inherit}
.icard .cstat{color:var(--fg);font-size:12.5px}
.icard .cstat:empty{display:none}
/* The away card: one sentence that wraps between its parts, never inside one, above the cards. */
.away .sent{display:flex;flex-wrap:wrap;column-gap:.3em;min-width:0}
.away .sent>span{white-space:nowrap}
#startersSlot{padding:6px 0;display:grid;gap:6px;min-width:0}
.grp{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);font-weight:600;padding:10px 4px 2px}
.conv{display:grid;gap:2px;padding:8px 10px;border-radius:9px;color:var(--fg);text-decoration:none;min-width:0}
.conv:hover{background:var(--hover)}
/* The hover paper is lighter than the list's in dark: the dim tag and time would drop under 4.5:1 on it. */
.conv:hover .when,.conv:hover .who{color:var(--fg)}
.conv.on{background:var(--panel2);box-shadow:inset 2px 0 0 var(--brand)}
.conv>.ct{display:flex;gap:6px;align-items:center;min-width:0}
.conv>.ct>b{font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.conv .u{width:7px;height:7px;border-radius:50%;background:var(--brand);flex:none}
.conv .when{font-size:11px;color:var(--dim);font-family:var(--font-mono);flex:none}
.conv>.cm{font-size:12px;color:var(--dim);display:flex;gap:8px}
.conv .need{color:var(--brand);font-weight:600}
.who{font-size:10.5px;border:1px solid var(--line);border-radius:5px;padding:0 5px;color:var(--dim);white-space:nowrap;flex:none}
.lnote{padding:6px 4px;color:var(--dim);font-size:13px}

/* Above the composer: who answers what you send, when it is not this page's pi. */
.held{margin:0 var(--pad) 8px;background:var(--panel2);border-radius:9px;padding:8px 12px;font-size:13px;display:flex;gap:8px;align-items:center}
.held[hidden]{display:none}

.sbar{grid-column:1/-1;grid-row:2;background:var(--nav);display:flex;align-items:center;gap:14px;padding:0 12px;font-size:12px;color:var(--dim);overflow:hidden;white-space:nowrap}
.sbar .grow{flex:1}
.sbar #sbHost{color:inherit;text-decoration:none}
.sbar #sbHost:hover{color:var(--fg)}
.sbar .st{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;background:var(--quiet);vertical-align:middle}
.sbar .st.up{background:var(--ok)}.sbar .st.down{background:var(--bad)}
.tabs{display:none}

header{display:flex;gap:10px;align-items:center;padding:9px 14px;flex-wrap:wrap;min-height:52px}
header b{font-weight:650}
/* The conversation's title: as much of it as leaves the pickers on the same row. */
header>b{flex:0 1 auto;min-width:0;max-width:24rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
header .cwd{color:var(--muted);font-size:12px;border:1px solid var(--line);border-radius:999px;padding:1px 9px;background:var(--field);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:min(34vw,26rem)}
header .grow{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
select,button,textarea,input{font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:6px;padding:5px 9px}
/* A select's dropdown is drawn by the platform, not by the page. With a transparent background the
   list is painted on system white while the options keep the page's text colour — light-on-white in
   a dark theme. Canvas and CanvasText follow color-scheme, so both halves agree in both themes. */
select,option{background:Canvas;color:CanvasText}
/* Focus is shown, in amber, wherever the keyboard puts it: a field that hid it left Tab with no way
   to tell where it had gone. */
:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
textarea:focus-visible,input:focus-visible{outline-offset:0}
/* The browser's own placeholder grey is too faint on dark paper. */
textarea::placeholder,input::placeholder{color:var(--dim);opacity:1}
button{cursor:pointer;color:var(--muted)}
button:hover{color:var(--ink);background:var(--hover)}
/* The one amber control: the thing to press. */
button.primary{background:var(--brand);border-color:var(--brand);color:var(--brand-ink);font-weight:600}
button.primary:hover{background:var(--brand);color:var(--brand-ink);filter:brightness(1.08)}
.badge{border:1px solid var(--line);border-radius:999px;padding:1px 9px;font-size:12px;color:var(--muted);white-space:nowrap}
#queued{border-top:1px solid var(--line);padding:4px 16px;font-size:13px;display:flex;flex-direction:column;gap:2px}
#queued[hidden]{display:none}
#queued .qrow{display:flex;gap:8px;align-items:baseline;min-width:0}
#queued .qrow .m{flex:none}
#queued .qtext{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#queued .qtext.full{overflow:visible;text-overflow:clip;white-space:pre-wrap;overflow-wrap:anywhere}
#queued .offered .m,#queued .stuck .m{color:var(--brand)}
#queued button{font-size:12px}

/* Not a toast that fades: this is the difference between the window working and not, and it stays
   until it is dealt with. Clicking it does the one thing it asks for. */
#stale{display:block;width:100%;border:0;border-bottom:1px solid var(--line);border-radius:0;
       background:var(--brand);color:var(--brand-ink);padding:7px var(--pad);text-align:left;font-size:13px}
#stale:hover{background:var(--brand);color:var(--brand-ink);filter:brightness(1.08)}
#stale[hidden]{display:none}
#findbar{display:flex;gap:8px;align-items:center;padding:7px var(--pad);border-bottom:1px solid var(--line);background:var(--side)}
/* The UA rule for [hidden] loses to any author rule that sets display, so this has to say it. */
#findbar[hidden]{display:none}
#findbar input{flex:1}
.hit{border-left:2px solid var(--line-strong);padding-left:10px;font-size:13px;color:var(--muted);font-family:var(--font-mono)}

#feed{flex:1;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding:20px var(--pad) 24px;display:flex;flex-direction:column;gap:14px;overflow-wrap:anywhere}
/* The feed is a column flexbox with a definite height, so its children shrink by default: a tall
   block — an expanded tool, a long reply — was squeezed to fit instead of making the feed scroll,
   and its last line was cut in half. */
#feed>*{flex:0 0 auto}
.row{position:relative;min-width:0;max-width:100%}
.role{display:flex;gap:8px;align-items:center;color:var(--faint);font-size:11px;letter-spacing:.03em;text-transform:uppercase;margin-bottom:3px}
/* The copy button is not part of the conversation, so it waits until you are on the block. A finger
   has no hover, so on a touch screen it is simply always there. */
.role button{border:0;padding:0 5px;font-size:11px;background:none;min-height:0;color:var(--faint);opacity:0;text-transform:none}
.row:hover .role button,.row:focus-within .role button{opacity:1}
.role button:hover{color:var(--ink);background:none}
@media (pointer:coarse){.role button{opacity:.7}}
@media (pointer:coarse){.row[data-when]::after{content:attr(data-when);display:block;margin-top:2px;font-size:11px;color:var(--faint);letter-spacing:.03em}.row.user[data-when]::after{text-align:right}}

/* You, on the right, in a bubble; the model, full width, as prose. The shape says who is speaking
   before a word of it is read, which is most of what makes a long session scannable. */
.row.user{align-self:flex-end;max-width:min(84%,40rem)}
.row.user>span{display:block;white-space:pre-wrap;background:var(--soft);border-radius:16px 16px 5px 16px;padding:9px 14px}
.row.user .role{justify-content:flex-end}
/* Status lines are context, not conversation: quiet, small, monospace. */
.notice{color:var(--muted);font-family:var(--font-mono);font-size:12.5px;white-space:pre-wrap}
.err{color:var(--ink);border-left:2px solid var(--bad);padding-left:10px;font-family:var(--font-mono);font-size:12.5px;white-space:pre-wrap}
.row>span{white-space:pre-wrap;word-break:break-word}
/* The markdown body is block-level HTML; pre-wrap there turns the whitespace between tags into
   blank lines. It is set on the span itself, so the selector has to be more specific than .row>span. */
.row>span.md,.md{white-space:normal}

/* A tool call and what it returned are one thing, and it is closed. A tool that prints two hundred
   lines should not push the conversation off the screen to do it. */
/* The run of them is the block; each one inside is a line. */
/* Closed, it is a line of text — a box drawn around one line is itself the noise this is about.
   The box appears when you open it, because then there is something in it. */
details.work{border:1px solid transparent;border-radius:10px;overflow:hidden}
details.work[open]{border-color:var(--line);background:var(--side)}
details.work:not([open])>summary{padding-left:0;padding-right:0}
details.work>summary{cursor:pointer;display:flex;align-items:center;gap:8px;padding:7px 11px;font-family:var(--font-mono);font-size:12px;color:var(--muted);list-style:none}
/* The reply that follows a stretch of work shares its row: the label and the copy button sit in
   the summary, so "ASSISTANT" and "6 steps · thinking, bash" are one line rather than two. */
details.work>summary>span.tag{flex:0 0 auto;color:var(--faint);font-size:11px;letter-spacing:.03em;text-transform:uppercase}
details.work>summary>button{border:0;background:none;color:var(--faint);padding:0 5px;font-size:11px;min-height:0;opacity:0;text-transform:none}
details.work:hover>summary>button,details.work:focus-within>summary>button{opacity:1}
@media (pointer:coarse){details.work>summary>button{opacity:.7}}
details.work>summary::-webkit-details-marker{display:none}
details.work>summary::before{content:"▸";color:var(--faint);flex:0 0 auto}
details.work[open]>summary::before{content:"▾"}
details.work>summary>span.what{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
details.work>summary:hover{color:var(--ink)}
details.work>details.tool,details.work>details.think,details.work>.note{border:0;border-top:1px solid var(--line);border-radius:0;background:transparent;padding:6px 11px}
details.work>.note{color:var(--muted);font-family:var(--font-mono);font-size:12px;white-space:pre-wrap}
details.tool{border:1px solid var(--line);border-radius:10px;background:var(--side);overflow:hidden}
details.tool>summary{cursor:pointer;display:flex;align-items:center;gap:8px;padding:7px 11px;font-family:var(--font-mono);font-size:12px;color:var(--muted);list-style:none}
details.tool>summary::-webkit-details-marker{display:none}
details.tool>summary::before{content:"▸";color:var(--faint);flex:0 0 auto}
details.tool[open]>summary::before{content:"▾"}
details.tool>summary>span.what{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
details.tool>summary>span.state{color:var(--faint);font-size:11px}
details.tool>summary>button{border:0;background:none;color:var(--faint);padding:0 5px;font-size:11px;min-height:0;opacity:0}
details.tool:hover>summary>button,details.tool:focus-within>summary>button{opacity:1}
@media (pointer:coarse){details.tool>summary>button{opacity:.7}}
details.tool>summary:hover{color:var(--ink)}
details.tool.err{border-color:var(--bad);padding-left:0}
details.tool pre{margin:0;padding:9px 11px;border-top:1px solid var(--line);max-height:22em;overflow:auto;color:var(--muted)}
details.think{color:var(--muted)}
details.think:not([open])>summary{padding-left:0}
details.think>summary{cursor:pointer;font-size:12px;color:var(--faint);list-style:none}
details.think>summary::-webkit-details-marker{display:none}
details.think>summary::before{content:"▸ ";color:var(--faint)}
details.think>summary .peek{color:var(--faint);font-style:italic}
details.think[open]>summary .peek{display:none}
details.think[open]>summary::before{content:"▾ "}
details.think pre{border-left:2px solid var(--line);padding-left:10px;font-style:italic;font-size:13px}
pre{margin:4px 0 0;white-space:pre-wrap;word-break:break-word;max-height:22em;overflow:auto;font-family:var(--font-mono);font-size:12.5px;line-height:1.55}


.md>*:first-child{margin-top:0}.md>*:last-child{margin-bottom:0}
.md p{margin:0 0 10px}
.md h3,.md h4,.md h5,.md h6{margin:14px 0 7px;line-height:1.25;font-weight:650}
.md h3{font-size:16px}.md h4{font-size:14.5px}.md h5,.md h6{font-size:13.5px;color:var(--muted)}
.md ul,.md ol{margin:0 0 10px 22px;padding:0}.md li{margin:3px 0}
.md blockquote{margin:0 0 10px;padding-left:12px;border-left:2px solid var(--line-strong);color:var(--muted)}
.md code{border:1px solid var(--line);border-radius:5px;background:var(--side);padding:1px 5px;font-family:var(--font-mono);font-size:.88em;overflow-wrap:anywhere}
.md pre.code{border:1px solid var(--line);border-radius:10px;background:var(--side);padding:11px 12px;margin:0 0 10px;position:relative;white-space:pre;overflow:auto;max-height:none}
.md pre.code code{border:0;background:none;padding:0;font-size:13px}
.md pre.code[data-lang]::before{content:attr(data-lang);position:absolute;top:4px;right:9px;font-size:10px;color:var(--faint)}
.md pre.code button.preview{position:absolute;top:2px;right:44px;font-size:11px;padding:1px 8px;min-height:0;background:var(--panel)}
.md hr{border:0;border-top:1px solid var(--line);margin:14px 0}
.md a{color:var(--ink);text-decoration:underline;text-underline-offset:2px}
/* A link to something on disk says so, so it is not mistaken for a link to the web. */
.md a.file::before{content:"⇱ ";color:var(--faint);text-decoration:none}
/* A path that was written in backticks keeps looking like one, and is a link as well. */
.md a.file>code{border-color:var(--line-strong)}
.md img{max-width:100%;height:auto;border:1px solid var(--line);border-radius:8px;margin:4px 0;display:block}
.md table{border-collapse:collapse;margin:0 0 10px;display:block;overflow-x:auto;max-width:100%;font-size:13.5px}
.md th,.md td{border:1px solid var(--line);padding:5px 10px;text-align:left;vertical-align:top}
.md th{font-weight:650;background:var(--soft);white-space:nowrap}

/* Sitting just above the composer, out of the way of the text, and only while there is something
   below the fold to go to. */
#newer{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(100% + 6px);z-index:6;
       border-radius:999px;padding:4px 12px;font-size:12.5px;background:var(--field);
       border-color:var(--line-strong);box-shadow:0 4px 14px var(--shadow)}
form#composer{display:flex;flex-direction:column;gap:7px;padding:4px var(--pad) calc(12px + env(safe-area-inset-bottom));position:relative}
.composer-row{display:flex;gap:8px;align-items:flex-end}
textarea{flex:1;resize:none;min-height:46px;max-height:40vh;background:var(--panel);border-color:var(--line);border-radius:12px;padding:10px 13px}
.sid{margin-top:10px;font-family:var(--font-mono);font-size:12px;color:var(--muted);overflow-wrap:anywhere;user-select:all}
#thumbs{display:flex;gap:6px;flex-wrap:wrap}
#thumbs .thumb{position:relative;line-height:0}
#thumbs img{height:46px;border:1px solid var(--line);border-radius:6px}
img.shot{max-width:100%;max-height:26em;height:auto;border:1px solid var(--line);border-radius:8px;margin:6px 0 0;display:block}
#thumbs .x{position:absolute;top:-6px;right:-6px;width:20px;height:20px;min-height:0;padding:0;border-radius:999px;background:var(--panel);border:1px solid var(--line-strong);color:var(--muted);font-size:12px;line-height:1}
#pop{position:absolute;bottom:100%;left:var(--pad);right:var(--pad);max-height:min(15em,32vh);overflow:auto;border:1px solid var(--line-strong);border-radius:8px;background:var(--field);box-shadow:0 10px 30px var(--shadow);display:none;z-index:5}
#pop div{padding:8px 11px;cursor:pointer;display:flex;gap:10px;border-bottom:1px solid var(--line)}
#pop div:last-child{border-bottom:0}
#pop div.sel,#pop div:hover{background:var(--soft)}
#pop .h{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

#loops{grid-column:4;grid-row:1;overflow:auto;min-height:0;min-width:0;background:var(--panel);padding:0}
#loops.hidden{display:none}
#loops>div{padding:14px 12px 6px}
#loops>details{padding:8px 12px}
#loops h2,#loops>details>summary{font-size:12px;font-weight:700;color:var(--ink);margin:0 0 9px;letter-spacing:0;text-transform:none}
#loops>details>summary{cursor:pointer;margin:0;padding:4px 0}
#loops>details[open]>summary{margin-bottom:6px}
.card{border:0;border-radius:12px;background:var(--panel2);padding:8px 10px;margin-bottom:7px;font-size:13px}
/* The name is the thing you act on — a /cron set <name> --host here takes it — so it is the one
   thing in this card that must not be abbreviated. It used to be clipped to an ellipsis while the
   schedule beside it wrapped onto two lines: unreadable and impossible to copy, which is the whole
   point of showing it. It wraps now and the row wraps with it; the schedule stays on one piece. */
.card .t{display:flex;gap:7px;align-items:center;flex-wrap:wrap}
.card .t b{font-weight:650;min-width:0;overflow-wrap:anywhere}
.card .t .m{white-space:nowrap}
.card .m{color:var(--muted);font-size:12px}
.card button{padding:2px 9px;font-size:12px;margin-left:auto;min-height:0}
/* A job or rule is now a <details>: closed it is the name, a two-line preview and a one-line error
   hint, open it is the whole prompt and the fields the terminal /cron listing has. The summary is
   the only part shown closed, so the runs line, the preview and the error hint live there and the
   full text lives in the body. */
details.card{padding:0;overflow:hidden}
details.card>summary{cursor:pointer;list-style:none;padding:7px 11px;display:flex;flex-wrap:wrap;align-items:center;gap:8px}
details.card>summary::-webkit-details-marker{display:none}
details.card>summary::before{content:"▸";color:var(--faint);flex:0 0 auto}
details.card[open]>summary::before{content:"▾"}
details.card>summary .t{flex:1 1 auto;min-width:0}
details.card>summary>.m{flex-basis:100%}
/* A summary must hold phrasing content, so these are spans; the summary is a flex row, which
   blockifies its children anyway, and the block is stated here for the lines that need it. */
details.card>summary>.m:not(.peek){display:block}
details.card .peek{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-width:0}
details.card[open] .peek{display:none}
details.card .peek.failing{-webkit-line-clamp:1;color:var(--bad)}
details.card .body{position:relative;padding:0 11px 9px}
/* The id, cwd and last error are one unbroken run each — a path, a URL in an error — and the card
   clips what it cannot wrap, so they break the way the full prompt does. */
details.card .body .m{overflow-wrap:anywhere}
details.card pre.full{margin:0;padding:3px 3.5em 6px 0;white-space:pre-wrap;overflow-wrap:anywhere;max-height:22em;overflow:auto;color:var(--muted);font-size:12px;font-family:inherit}
details.card button.copy{border:0;background:none;color:var(--faint);padding:0 5px;font-size:11px;min-height:0;opacity:0;position:absolute;top:4px;right:6px}
details.card:hover button.copy,details.card:focus-within button.copy{opacity:1}
@media (pointer:coarse){details.card button.copy{opacity:.7}}
/* A loop row's run, signal and suggestion, under the card's name. Its buttons wrap, never push the
   panel sideways, and on a phone stack at full width. */
details.card>summary>.loopx{display:flex;flex-direction:column;gap:5px}
details.card>summary>.loopx:empty{display:none}
.loopx .runline{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.loopx button{margin-left:0}
.loopx .confirm{display:flex;flex-direction:column;gap:6px;padding:7px 8px;border-radius:9px;background:var(--panel);color:var(--fg);overflow-wrap:anywhere;cursor:default}
.loopx .acts{display:flex;flex-wrap:wrap;gap:6px}
.loopx .signal{display:block;overflow-wrap:anywhere}
.loopx .note{border-top:1px solid var(--line);padding-top:4px}
details.card>summary>.looks{display:block;overflow-wrap:anywhere}
@media (max-width:420px){.loopx .acts button,.loopx .runline button,.loopx .confirm>button{flex:1 1 100%;min-height:36px}}
.off{opacity:.5}
.dot{display:inline-block;width:7px;height:7px;border-radius:99px;margin-right:6px;vertical-align:middle}
.up{background:var(--ok)}.down{background:var(--bad)}.idle{background:var(--quiet)}
/* Words in a state: a fault, or a quiet aside. */
.bad{color:var(--bad)}.dim{color:var(--dim)}
/* Counts as a row of figures rather than a sentence: the number is the thing being read, and each
   one is a target big enough for a finger. */
.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--field);margin-top:8px}
.metrics>*{min-width:0;padding:8px 9px;border-right:1px solid var(--line);text-align:left;min-height:46px;border-radius:0;border-top:0;border-bottom:0}
.metrics>*:last-child{border-right:0}
.metrics b{display:block;font-size:16px;line-height:1.2;color:var(--ink)}
.metrics span{display:block;color:var(--muted);font-size:11px}
button.metric{background:none;border-left:0;cursor:pointer}
button.metric:hover{background:var(--soft)}
button.count{border:0;padding:0;background:none;font:inherit;min-height:0;text-decoration:underline dotted;text-underline-offset:2px;color:inherit}
button.count:hover{background:none;color:var(--ink)}

dialog{border:1px solid var(--line);border-radius:12px;padding:16px;max-width:42rem;width:min(92vw,42rem);background:var(--panel);color:var(--ink);box-shadow:0 16px 48px var(--shadow)}
dialog::backdrop{background:rgba(0,0,0,.4)}
dialog h3{margin:0 0 10px;font-size:14px;font-weight:650}
dialog pre{background:var(--side);border:1px solid var(--line);padding:9px 10px;border-radius:8px}
dialog menu{display:flex;gap:8px;justify-content:flex-end;padding:0;margin:14px 0 0}
/* Watch for…: the sentence box and the plan card (docs/design.md decision 24). Inspire tokens only:
   --panel2 for the card, --brand for Set it up and the chosen chip, colour only for danger. */
/* The body scrolls and the buttons stay: Read it in the dialog's own menu below the body, a card's
   Cancel and Set it up stuck to the bottom of the scrolling body while the card is in view. */
#watch{width:min(540px,calc(100% - 32px));max-height:90dvh;overflow:hidden}
#watch[open]{display:flex;flex-direction:column}
#watchBody{overflow:auto;min-height:0;flex:1 1 auto}
#watch menu{flex:none}
#watchCards .plan .foot{position:sticky;bottom:0;background:var(--panel2);padding-top:4px;display:grid;gap:6px}
#watch label{display:block;font-size:13px;color:var(--dim);margin:0 0 6px}
#watch textarea{width:100%;box-sizing:border-box;min-height:4.5em;border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:inherit;background:var(--panel);color:var(--fg);resize:vertical}
#watchEx{display:flex;flex-wrap:wrap;gap:5px;align-items:center;font-size:12px;margin:6px 0 0}
#watchEx button{border:0;background:var(--hover);border-radius:999px;padding:4px 10px;min-height:32px;font-size:12px;color:var(--fg);text-align:left;max-width:100%;overflow-wrap:anywhere;white-space:normal}
#watchEx button:hover{color:var(--brand)}
#watchStatus{margin-top:10px}
#watchStatus.bad{color:var(--bad)}
#watchCards{display:grid;gap:10px;margin-top:10px}
.plan{background:var(--panel2);border-radius:12px;padding:12px 14px;display:grid;gap:10px;font-size:13px;min-width:0;max-width:100%;overflow-wrap:anywhere}
.plan.done,.plan.stale{opacity:.7}
.plan .planh{font-weight:600}
.plan .planh.bad,.plan .bad{color:var(--bad)}
.plan dl{margin:0;display:grid;grid-template-columns:88px minmax(0,1fr);gap:8px 10px}
.plan dt{color:var(--dim)}
.plan dd{margin:0;min-width:0;overflow-wrap:anywhere}
.plan dd pre{margin:0;padding:8px 10px;background:var(--code);border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--font-mono);font-size:12px;color:var(--fg)}
.plan .dim{color:var(--dim)}
.plan .ib{white-space:pre-wrap}
.plan .chips{display:flex;flex-wrap:wrap;gap:6px}
.plan .chips button{border:1px solid var(--line);background:var(--panel);border-radius:999px;padding:4px 11px;min-height:32px;font-size:12.5px;color:var(--fg);max-width:100%;text-align:left;white-space:normal;overflow-wrap:anywhere}
.plan .chips button small{display:block;font-size:11px;color:var(--dim)}
.plan .chips button.on{border-color:var(--brand);background:var(--brand-soft);color:var(--brand)}
.plan .chips button.on small{color:var(--brand)}
.plan pre.preview{margin:0;padding:8px 10px;background:var(--code);border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--font-mono);font-size:12px;color:var(--dim)}
.plan .cstat{font-size:12.5px}
.plan .cstat:empty{display:none}
.plan .acts{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end}
.plan .acts button{min-height:32px;padding:4px 12px;border-radius:8px;font-size:12.5px}
.plan .acts button:disabled{opacity:.45;cursor:default}
.row.plan{max-width:min(100%,44rem)}
@media (max-width:420px){.plan dl{grid-template-columns:minmax(0,1fr)}.plan dt{margin-top:2px}.plan .acts button.primary{flex:1 1 100%}}
#pairPick{width:100%;margin-bottom:8px}
.qr{display:flex;justify-content:center;padding:6px 0}
.qr svg{width:min(62vw,240px);height:auto;background:#fff;padding:8px;border-radius:8px}
/* By id, not by a class called "code": markdown fenced blocks are <pre class="code"> and were
   inheriting this one's letter-spacing, which spread every line of code out across the page. */
#pairCode{text-align:center;font-size:32px;letter-spacing:.28em;padding:8px 0 2px;font-variant-numeric:tabular-nums;font-family:var(--font-mono)}
#pairWhere{text-align:center;padding-bottom:4px}
.detail-row{padding:4px 0;border-bottom:1px solid var(--line);font-size:13px;font-family:var(--font-mono)}
.detail-row:last-child{border-bottom:0}
/* A session is picked by recognising the conversation, so the first thing said is the line that
   matters and everything else is a caption under it. */
#sessBody{max-height:60vh;overflow:auto}
.sess{display:block;width:100%;text-align:left;padding:9px 10px;margin-bottom:6px;border:1px solid var(--line);
      border-radius:9px;background:var(--side);color:var(--ink);cursor:pointer}
.sess:hover{background:var(--hover)}
/* Two lines of the opening prompt, so a long one does not turn the list into a page. */
.sess b{font-weight:600;font-size:13px;line-height:1.35;
        display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.sess span{display:block;margin-top:3px;font-size:11px;color:var(--muted);font-family:var(--font-mono)}
.sess[disabled]{cursor:default;opacity:.75;border-style:dashed}
.sess[disabled]:hover{border-color:var(--line)}
#detailBody{max-height:60vh;overflow:auto}

/* ---------------------------------------------------------------- narrow screens */
/* The drawer covers the conversation, so tapping "somewhere else" has to mean the whole of
   somewhere else — not the 47px strip the drawer happens to leave. It dims what it covers, which
   is also how you know the panel is on top of the conversation rather than beside it. */
#scrim{display:none}
#actions{display:contents}
/* In the sheet they are a list, not a row, and each one is a full-width target. */
#menuBody #actions{display:flex;flex-direction:column;gap:8px}
#menuBody #actions button{width:100%;text-align:left;min-height:44px}
/* Thirteen controls do not fit across a narrow conversation. The ones you reach for mid-conversation
   (undo, find, compact, resume) stay; the rest are one tap away behind ⋯, which lists all of them.
   Asked of the conversation's own width, which the list and the loops rail beside it take from:
   a laptop window leaves it 600 to 800 px. */
@container (max-width:1000px){
  #more{display:inline-block}
  .grow>#actions>:not(#undo,#find,#compact,#resume){display:none}
}
/* At a laptop width the header stays two rows, as it was with the four hidden: title, path and pickers
   on the first, where the title and the path give up width; the actions with ⋯ on the second, where
   the row is tightened and the cost badge, which carries its own title, is the one thing that gives
   up width. A phone keeps its own. */
@media (min-width:761px){@container (min-width:600px) and (max-width:1000px){
  header{display:grid;grid-template-columns:minmax(0,max-content) minmax(0,max-content) auto auto 1fr;padding-left:10px;padding-right:10px}
  header .grow{grid-column:1/-1}
  header .grow{flex-wrap:nowrap;gap:6px;min-width:0;max-width:100%}
  header .grow *{flex-shrink:0}
  header .grow button{padding:5px 7px}
  #cost{flex-shrink:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
}}
/* The loops rail is not dropped when the window narrows, it is put behind the rail's Loops button: it
   slides over the conversation rather than taking a third of it, the way a drawer does elsewhere. */
@media (max-width:1100px){
  body{grid-template-columns:56px 300px minmax(0,1fr)}
  #loops{position:fixed;top:0;right:0;bottom:0;width:min(88vw,23rem);z-index:40;
        box-shadow:-14px 0 40px var(--shadow);transform:translateX(101%);transition:transform .18s ease;
        padding-bottom:calc(10px + env(safe-area-inset-bottom))}
  #loops.hidden{display:block}
  #loops.open{transform:none}
  #scrim:not([hidden]){display:block;position:fixed;inset:0;z-index:39;background:rgba(0,0,0,.4)}
}
@media (max-width:900px){
  :root{--pad:12px}
  header{padding:8px 12px;gap:7px;padding-top:calc(8px + env(safe-area-inset-top))}
  #feed{gap:12px}
  .row.user{max-width:92%}
  /* Anything under 16px makes iOS Safari zoom the whole page the moment you focus it, and it does
     not zoom back out. Touch targets get a finger's worth of height at the same time. */
  textarea,input,select{font-size:16px}
  textarea{min-height:44px}
  /* Three buttons beside the box left it about 150 characters wide, with its own scrollbar. The
     box gets the width; the buttons get a row of their own and split it. */
  .composer-row{flex-wrap:wrap}
  .composer-row textarea{flex:1 1 100%}
  .composer-row button{flex:1 1 0}
  /* The path is in the switcher. Here it was costing a whole header row, on a screen where the
     header was already taking an eighth of the height. */
  header .cwd{display:none}
  /* The title gets a row of its own, first: on a phone the list is another pane, and the header is
     the one place that says which conversation this is. */
  header>b{flex:1 1 100%;max-width:none;order:-1}
  header select{max-width:8.5rem}
  header{min-height:0}
  button{padding:8px 12px;min-height:40px}
  .card button,.role button{min-height:32px}
}
/* A phone: one pane at a time, Inbox (the list), Chat and Loops, picked by the tabs at the bottom and
   kept in the address (#inbox, #chat, #loops), so Back goes to the pane before and a reload keeps it. */
@media (max-width:760px){
  .grow>#actions{display:none}
  body,body:has(#loops.hidden){grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) calc(52px + env(safe-area-inset-bottom))}
  #rail,#scrim{display:none}
  #scrim:not([hidden]){display:none}
  /* The status bar is where pi-loops says it runs, and its way to the Background view: on a phone, under the Loops pane. */
  body:not([data-pane=loops]) .sbar{display:none}
  body[data-pane=loops]{grid-template-rows:minmax(0,1fr) 34px calc(52px + env(safe-area-inset-bottom))}
  body[data-pane=loops] .sbar{grid-row:2}
  .sbar #sbHeld{display:none}
  body[data-pane=loops] .tabs{grid-row:3}
  #list,main,#loops{grid-column:1;grid-row:1}
  body:not([data-pane=inbox]) #list{display:none}
  body[data-pane=inbox] main,body[data-pane=loops] main{display:none}
  #loops,#loops.hidden{position:static;transform:none;width:auto;box-shadow:none;transition:none;display:none}
  body[data-pane=loops] #loops{display:block}
  .tabs{display:flex;grid-column:1;grid-row:2;background:var(--nav);padding-bottom:env(safe-area-inset-bottom)}
  .tabs a{flex:1;display:grid;justify-items:center;align-content:center;gap:2px;color:var(--dim);text-decoration:none;font-size:11px}
  .tabs a.on{color:var(--brand)}
  .seg button{min-height:32px}
  #activitySlot ul{max-height:50vh}
}
@media (pointer:coarse){button,select,.icard button{min-height:40px}}
</style>
<nav id="rail" aria-label="Views">
  <span class="logo" aria-hidden="true">pl</span>
  <button type="button" id="railList" class="on" title="Inbox" aria-label="Inbox"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg></button>
  <button type="button" id="drawer" title="Loops: this project's loops, goal and pi-loops" aria-label="Show or hide the loops" aria-expanded="true"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/></svg></button>
</nav>
<nav id="list" aria-label="Inbox">
  <div class="lhead">
    <div class="lrow"><select id="project" title="Project" aria-label="Project"></select><button type="button" id="watchFor" title="Set up a watch from one sentence">+ Watch for…</button><button type="button" id="newConv" class="primary" title="Start a new conversation — this one stays on disk">+ New</button></div>
    <div class="seg" role="tablist" aria-label="Show">
      <button type="button" role="tab" id="segAll">All <span class="pill" id="nAll"></span></button>
      <button type="button" role="tab" id="segNeeds">Needs you <span class="pill" id="nNeeds"></span></button>
      <button type="button" role="tab" id="segUnread">Unread <span class="pill" id="nUnread"></span></button>
    </div>
  </div>
  <div class="lscroll" id="lscroll">
    <div id="awaySlot"></div>
    <div id="startersSlot"></div>
    <div id="cardsSlot"></div>
    <div id="convs"></div>
  </div>
</nav>
<main>
  <header>
    <b id="title">pi web</b>
    <span class="cwd" id="cwd"></span>
    <select id="model" title="Model"></select>
    <select id="thinking" title="Thinking level">
      <option>off</option><option>minimal</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option><option>max</option>
    </select>
    <span class="grow">
      <span class="badge" id="queue" hidden></span>
      <span class="badge" id="cost" title="Session tokens and cost"></span>
      <button id="expand" title="Expand every step">▸ steps</button>
      <span id="actions">
        <button id="reload" title="Load this page again from the server">reload</button>
        <button id="find" title="Search the whole session, including abandoned branches" aria-label="Search this session">find</button>
        <button id="undo" title="Fork from your last message and put it back in the composer">undo</button>
        <button id="save" title="Export this session as HTML">save</button>
        <button id="share" title="Upload a redacted transcript as a GitHub gist (asks first)">share</button>
        <button id="compact" title="Summarise the context so far and carry on (/compact &lt;instructions&gt; steers it)">compact</button>
        <button id="clear" title="Start a new session — this one stays on disk">clear</button>
        <button id="resume" title="Go back to an earlier session in this project">resume</button>
        <button id="adddev" title="Show a code and a QR for signing in another device" aria-label="Add a device">add device</button>
        <button id="theme" title="Theme: system, light, dark" aria-label="Change theme">◐</button>
        <button id="notifyMe" title="A notification while this tab is hidden: a decision, a loop failing three times in a row, the daily budget">notifications</button>
      </span>
      <span class="badge" id="status">connecting</span>
      <button id="more" title="Session actions" aria-label="Session actions">⋯</button>
    </span>
  </header>
  <div id="findbar" hidden><input id="findq" placeholder="search this session…" ><span id="findn" class="notice"></span></div>
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
      <textarea id="input" placeholder="Message pi — / for commands, @ for files, Enter sends"></textarea>
      <button type="button" id="attach">attach</button>
      <button type="submit" class="primary">send</button>
      <button type="button" id="stop">stop</button>
    </div>
    <input type="file" id="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" multiple hidden>
  </form>
</main>
<aside id="loops" aria-label="Loops">
  <div><h2>Loops</h2><div id="auto"></div></div>
  <details><summary>Goal</summary><div id="goal" class="notice">none</div></details>
  <details><summary>This conversation</summary><div id="meta" class="notice"></div></details>
  <details><summary>pi-loops</summary><div id="runtime" class="notice">—</div></details>
</aside>
<footer class="sbar" aria-label="Status"><a id="sbHost" href="/background"></a><span id="sbLoops"></span><span class="grow"></span><span id="sbHeld"></span></footer>
<nav class="tabs" aria-label="Panes">
  <a href="#inbox" id="tabInbox"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 13h5l2 3h4l2-3h5"/><path d="M5 5h14l2 8v6H3v-6z"/></svg><span>Inbox</span></a>
  <a href="#chat" id="tabChat"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg><span>Chat</span></a>
  <a href="#loops" id="tabLoops"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/></svg><span>Loops</span></a>
</nav>
<div id="scrim" hidden></div>
<dialog id="menu" aria-label="Session actions" role="dialog">
  <h3>Session</h3><div id="menuBody"></div><div id="sid" class="sid"></div>
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
/** Only a first visit's page carries the token. Any other load trades for it below (tokenReady). */
let TOKEN = "__TOKEN__";
/**
 * Handed over once, with the device cookie, on a first visit. It is kept in localStorage, which
 * belongs to this origin and its port: a server on another port receives the cookie, never this.
 */
const DEVICE_SECRET = "__DEVICE_SECRET__";
const DEVICE_KEY = "pi-loops-device";
/** The conversation this page shows. Its routes are under /c/<id>/; pi moving to another one moves it. */
let SESSION = "__SESSION__";
/** The version this page was served by. The server says its own in /state; a difference is age. */
const PAGE_VERSION = "__VERSION__";
try {
  if (DEVICE_SECRET) localStorage.setItem(DEVICE_KEY, DEVICE_SECRET);
} catch (e) {
  // Storage blocked: this tab works, and the next load of this browser meets the door.
}
/**
 * The token, for a page served without it: the device cookie goes with the request on its own, and
 * the secret goes in a header. Refused, the server has cleared the cookie, so loading again shows
 * the door rather than a page that cannot do anything.
 */
const tokenReady = TOKEN
	? Promise.resolve()
	: fetch("/c/" + SESSION + "/token", { method: "POST", headers: { "x-pi-web-device-secret": (() => { try { return localStorage.getItem(DEVICE_KEY) || ""; } catch (e) { return ""; } })() } })
			.then(async (r) => {
				const b = await r.json();
				if (b && typeof b.token === "string") TOKEN = b.token;
				else if (r.status === 401 || r.status === 403) location.reload();
			})
			// Not answered at all: pi-loops is restarting or gone. Loading again is the retry.
			.catch(() => setTimeout(() => location.reload(), 3000));
/**
 * One request, and always a value.
 *
 * Most callers here are fire-and-forget — a queue cleared, a level set, a job run now — and a
 * rejected fetch in one of those is a promise nobody is waiting on. The terminal catch is what
 * makes "always a value" true: every caller can read success and error whether the request
 * failed at the server or never left the browser.
 */
const api = (p, b) => {
	const send = () =>
		fetch(
			"/c/" + SESSION + p,
			b === undefined
				? { headers: { "x-pi-web-token": TOKEN } }
				: { method: "POST", headers: { "x-pi-web-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify(b) },
		);
	// Sent at once when the token is here, so a request leaves in the order it was made.
	return (TOKEN ? send() : tokenReady.then(send)).then((r) => r.json()).catch((e) => ({ success: false, error: String(e) }));
};
// Opened at the bare address, or with a spent open key, pairing code or token in the query: show
// this conversation's own address, which a reload or a bookmark comes back to.
if (location.pathname === "/" || location.search) history.replaceState(null, "", "/c/" + SESSION + "/" + (location.hash || ""));
const $ = (id) => document.getElementById(id);
const feed = $("feed"), statusEl = $("status");
/** How long a tab stays subscribed after it goes into the background. */
const STREAM_PARK_MS = 15000;
/** How long a send may take before the page says that it is taking long. */
const SEND_WATCHDOG_MS = 6000;
let state = {}, cwd = "", busy = false, atBottom = true, takesImages = true;
/** Installed once the stream is up; until then a poll has nothing to compare against. */
let checkStream;

feed.addEventListener("scroll", () => {
  atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  if (atBottom) $("newer").hidden = true;
});
/**
 * Following the bottom, but only while you are at it: an update must not yank the page while you
 * are reading back through it. The cost of that is silence — a reply arrives, a tool finishes, and
 * nothing on screen says so — which is what the pill is for.
 */
const scroll = () => {
  if (atBottom) {
    feed.scrollTop = feed.scrollHeight;
    $("newer").hidden = true;
  } else {
    $("newer").hidden = false;
  }
};

/**
 * Text on its way to the screen. pi's session carries whatever was written to it, and plenty of
 * that was written for a terminal: an extension's startup banner, a coloured diff, a spinner. A
 * browser has no terminal to interpret those, so without this you read the escape codes themselves
 * — ESC[38;5;240m before every box character. Stripped rather than rendered: colour is not what
 * those bytes are here for, and a page that executes terminal control sequences is a worse idea.
 */
function plain(s) {
  return String(s ?? "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b[[(][0-9;?]*[ -\/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    // Bidi embeddings, overrides and isolates: invisible characters that reorder the line drawn
    // around them. A session named "delete\u202e evil red" draws as "deleteder live" — a different
    // conversation from the one that would open, in the control that decides which one opens. The
    // marks ordinary mixed-direction text uses (U+200E, U+200F) are left alone; these are the ones
    // whose only use on a line of someone else's text is to make it say something else.
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "");
}

/**
 * A QR code, so a phone is pointed at the screen instead of typing a token.
 *
 * Byte mode, error correction level M, versions 1 to 6 — 106 characters, which is more than any
 * address this prints. Verified against a real decoder (OpenCV) at every length up to that, not
 * against another encoder: what matters is whether a scanner reads it.
 *
 */
const CAP = [null, 14, 26, 42, 62, 84, 106];
const TOTAL = [null, 26, 44, 70, 100, 134, 172];
const BLOCKS = [null, 1, 1, 1, 2, 2, 4];
const ECPB = [null, 10, 16, 26, 18, 24, 16];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]];

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function generator(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    // The coefficients run highest power first, so multiplying by x keeps each index and
    // multiplying by a constant moves one to the right. Written the other way round this builds
    // the reverse polynomial, which produces plausible-looking parity that no scanner accepts.
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function ecc(data, n) {
  const gen = generator(n);
  const rest = new Uint8Array(data.length + n);
  rest.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = rest[i];
    if (!factor) continue;
    for (let j = 0; j < gen.length; j++) rest[i + j] ^= mul(gen[j], factor);
  }
  return rest.slice(data.length);
}

function bitsOf(text) {
  const bytes = new TextEncoder().encode(text);
  const bits = [];
  const push = (value, n) => { for (let i = n - 1; i >= 0; i--) bits.push((value >> i) & 1); };
  push(4, 4);            // byte mode
  push(bytes.length, 8); // count, 8 bits for versions 1-9
  for (const b of bytes) push(b, 8);
  return { bits, length: bytes.length };
}

function encode(text) {
  const { bits, length } = bitsOf(text);
  const version = CAP.findIndex((c, i) => i > 0 && c >= length);
  if (version < 1) return undefined; // longer than this encoder covers
  const dataWords = TOTAL[version] - BLOCKS[version] * ECPB[version];
  for (let i = 0; i < 4 && bits.length < dataWords * 8; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const words = [];
  for (let i = 0; i < bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0; words.length < dataWords; pad++) words.push(pad % 2 ? 0x11 : 0xec);

  // Split into blocks, each with its own error correction, then interleave both halves.
  const n = BLOCKS[version];
  const short = Math.floor(dataWords / n);
  const long = dataWords % n; // that many blocks at the end carry one extra data codeword
  const blocks = [];
  let at = 0;
  for (let i = 0; i < n; i++) {
    const size = short + (i >= n - long ? 1 : 0);
    const data = Uint8Array.from(words.slice(at, at + size));
    at += size;
    blocks.push({ data, ec: ecc(data, ECPB[version]) });
  }
  const out = [];
  for (let i = 0; i < short + 1; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < ECPB[version]; i++) for (const b of blocks) out.push(b.ec[i]);
  return { version, size: 17 + version * 4, words: out };
}

/* ------------------------------------------------------------------ the matrix */

const FORMAT_MASK = 0x5412;

function formatBits(mask) {
  // EC level M is 00; the five data bits are that plus the mask, extended by BCH(15,5).
  let value = (0b00 << 3) | mask;
  let rest = value << 10;
  for (let i = 4; i >= 0; i--) if ((rest >> (i + 10)) & 1) rest ^= 0x537 << i;
  return ((value << 10) | rest) ^ FORMAT_MASK;
}

function blank(size) {
  return { m: Array.from({ length: size }, () => new Int8Array(size).fill(-1)), size };
}

function place(grid, r, c, v) {
  grid.m[r][c] = v;
}

function finder(grid, r, c) {
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= grid.size || cc >= grid.size) continue;
      const edge = dr === -1 || dr === 7 || dc === -1 || dc === 7;
      const ring = dr === 0 || dr === 6 || dc === 0 || dc === 6;
      const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
      place(grid, rr, cc, edge ? 0 : ring || core ? 1 : 0);
    }
  }
}

function reserveFormat(grid) {
  const s = grid.size;
  for (let i = 0; i < 9; i++) {
    if (grid.m[8][i] === -1) place(grid, 8, i, 0);
    if (grid.m[i][8] === -1) place(grid, i, 8, 0);
  }
  for (let i = 0; i < 8; i++) {
    place(grid, 8, s - 1 - i, 0);
    place(grid, s - 1 - i, 8, 0);
  }
  place(grid, s - 8, 8, 1); // the dark module, always set
}

function skeleton(version) {
  const grid = blank(17 + version * 4);
  const s = grid.size;
  finder(grid, 0, 0);
  finder(grid, 0, s - 7);
  finder(grid, s - 7, 0);
  for (let i = 8; i < s - 8; i++) {
    place(grid, 6, i, i % 2 === 0 ? 1 : 0);
    place(grid, i, 6, i % 2 === 0 ? 1 : 0);
  }
  for (const r of ALIGN[version]) {
    for (const c of ALIGN[version]) {
      if (grid.m[r][c] !== -1) continue; // never on top of a finder
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          place(grid, r + dr, c + dc, ring === 1 ? 0 : 1);
        }
      }
    }
  }
  reserveFormat(grid);
  return grid;
}

/** The zigzag: two columns at a time, right to left, skipping the timing column. */
function fill(grid, words) {
  const bits = [];
  for (const w of words) for (let i = 7; i >= 0; i--) bits.push((w >> i) & 1);
  const s = grid.size;
  let at = 0;
  let up = true;
  for (let right = s - 1; right > 0; right -= 2) {
    if (right === 6) right = 5; // the vertical timing pattern is not a data column
    for (let step = 0; step < s; step++) {
      const row = up ? s - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (grid.m[row][col] !== -1) continue;
        grid.m[row][col] = at < bits.length ? bits[at++] : 0;
      }
    }
    up = !up;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function penalty(m, s) {
  let score = 0;
  // Rule 1: runs of five or more of the same colour, in both directions.
  for (let i = 0; i < s; i++) {
    for (const line of [m[i], m.map((row) => row[i])]) {
      let run = 1;
      for (let j = 1; j < s; j++) {
        if (line[j] === line[j - 1]) run++;
        else { if (run >= 5) score += run - 2; run = 1; }
      }
      if (run >= 5) score += run - 2;
    }
  }
  // Rule 2: every 2x2 block of one colour.
  for (let r = 0; r < s - 1; r++) for (let c = 0; c < s - 1; c++) {
    const v = m[r][c];
    if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
  }
  // Rule 3: the finder-like pattern, which must not appear in the data.
  const A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matches = (line, at, pat) => pat.every((v, k) => line[at + k] === v);
  for (let i = 0; i < s; i++) {
    const row = m[i];
    const col = m.map((r) => r[i]);
    for (let j = 0; j + 11 <= s; j++) {
      for (const line of [row, col]) if (matches(line, j, A) || matches(line, j, B)) score += 40;
    }
  }
  // Rule 4: how far the proportion of dark modules is from half.
  let dark = 0;
  for (const row of m) for (const v of row) dark += v;
  score += Math.floor(Math.abs((dark * 100) / (s * s) - 50) / 5) * 10;
  return score;
}

function matrixWithMask(text, only) {
  const data = encode(text);
  if (!data) return undefined;
  const base = skeleton(data.version);
  const reserved = base.m.map((row) => Int8Array.from(row, (v) => (v === -1 ? 0 : 1)));
  fill(base, data.words);
  const s = base.size;

  let best;
  for (let mask = only ?? 0; mask < (only === undefined ? 8 : only + 1); mask++) {
    const m = base.m.map((row, r) => Int8Array.from(row, (v, c) => (reserved[r][c] ? v : v ^ (MASKS[mask](r, c) ? 1 : 0))));
    const bits = formatBits(mask);
    const at = (i) => (bits >> i) & 1;
    // Two copies, so a damaged corner still leaves the mask readable. Bit 0 is the least
    // significant, and the two copies walk the corner in opposite directions.
    for (let i = 0; i < 6; i++) m[i][8] = at(i);
    m[7][8] = at(6);
    m[8][8] = at(7);
    m[8][7] = at(8);
    for (let i = 9; i < 15; i++) m[8][14 - i] = at(i);
    for (let i = 0; i < 7; i++) m[8][s - 1 - i] = at(i);
    for (let i = 7; i < 15; i++) m[s - 15 + i][8] = at(i);
    m[s - 8][8] = 1; // the dark module is not part of the format bits and is always set
    const score = penalty(m, s);
    if (!best || score < best.score) best = { score, m, mask };
  }
  return { size: s, version: data.version, mask: best.mask, m: best.m };
}

const qrMatrix = (text) => matrixWithMask(text, undefined);

/* ---------------- markdown ---------------- */
/*
 * A small Markdown renderer. A model writes Markdown whether or not the front end reads it, so a
 * page that shows the source is showing you asterisks and pipes where a list and a table were
 * meant. This covers what actually turns up in a reply: fenced code, headings, lists, quotes,
 * rules, and inline code, emphasis and links.
 *
 * Everything is escaped before anything is added — by esc(), the same one the panel uses, because
 * there was a second copy of it here and two escape tables is one too many — and the only attribute
 * this ever writes is an href that had to survive a scheme check first. A reply is not trusted
 * input: it is whatever the model was persuaded to write, and a tool result inside it is whatever a
 * web page said.
 */

/** http and https and nothing else: javascript: and data: are both a way to run code from a link. */
function safeHref(url) {
  const trimmed = String(url ?? "").trim();
  // The placeholder marker means a code span was taken out of this URL and will be put back after
  // the attribute is written — so the address would not be the one the link says. Leave it as text.
  if (trimmed.includes("\u0000")) return "";
  return /^https?:\/\//i.test(trimmed) ? esc(trimmed) : "";
}

/**
 * A path the session wrote, turned into something you can look at.
 *
 * A reply that says "I put the chart in ./out/chart.png" is a reply you cannot see the chart in.
 * Anything that is not an absolute URL is treated as a path relative to the session's directory
 * and handed to /file, which decides whether it exists, whether it is inside, and whether it is a
 * kind of thing worth showing — none of which the page is in a position to know. This is the path
 * as /file is asked for it, written into data-file: the address itself needs a key (fileUrl).
 */
function filePath(url) {
  const trimmed = String(url ?? "").trim();
  if (!trimmed || trimmed.includes("\u0000")) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) return ""; // a scheme of its own
  return trimmed.replace(/^\.\//, "");
}

/**
 * The address of one file, with a key minted for that path. No token in it: a page the model wrote,
 * opened from one of these, can read its own address, and the key is spent by the load that opens it.
 */
async function fileUrl(p) {
  const r = await api("/key", { for: "file", path: p });
  return r && r.key ? "/c/" + SESSION + "/file?path=" + encodeURIComponent(p) + "&key=" + r.key : "";
}

const fileImg = (p, alt) => '<img data-file="' + esc(p) + '" alt="' + esc(alt) + '">';
const fileLink = (p, inner) => '<a data-file="' + esc(p) + '" href="#" class="file">' + inner + "</a>";

/** A file link, opened: a key first, then the file in a tab of its own. */
async function openFile(p) {
  const u = await fileUrl(p);
  if (u) window.open(u, "_blank", "noopener");
}

/** The whole of a code span, and nothing but a path. */
const ONLY_A_PATH = /^(?:~\/|\.{0,2}\/)[^\s<>"']+\.(?:png|jpe?g|gif|webp|avif|svg|pdf|html?|txt|md|csv|json)$/i;

/**
 * A path written in prose, rather than as a link.
 *
 * "I put it in /home/you/Downloads/report.html" is how a model actually says where something is,
 * and until now that was a sentence with a dead end in it. Only paths that name a file this can
 * show — the extension list, the same one the server enforces — so ordinary words with slashes in
 * them are left alone.
 */
const PREVIEWABLE = /(^|[^\w\/~.-])((?:~\/|\.{0,2}\/)[^\s)<>"'，。；：]+\.(?:png|jpe?g|gif|webp|avif|svg|pdf|html?|txt|md|csv|json))(?=$|[^\w-])/gi;

function linkPathsInProse(html) {
  // Only the text between tags: run over the whole string and it would find the paths inside the
  // href attributes it has just written. And not inside a link, where it would nest one in another.
  let depth = 0;
  return html
    .split(/(<[^>]*>)/)
    .map((part, i) => {
      if (i % 2) {
        if (/^<a\b/i.test(part)) depth++;
        else if (/^<\/a>/i.test(part)) depth = Math.max(0, depth - 1);
        return part;
      }
      if (depth) return part;
      return part.replace(PREVIEWABLE, (whole, before, p) => {
        const file = filePath(p);
        if (!file) return whole;
        const image = /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(p);
        return before + (image ? fileImg(file, p) : fileLink(file, esc(p)));
      });
    })
    .join("");
}

// This page is a template literal inside a Node file, so a backtick cannot be written here at all
// — and Markdown is made of them. Building the character keeps those two facts from colliding.
const BT = String.fromCharCode(96);
const RE_CODESPAN = new RegExp(BT + "([^" + BT + "]+)" + BT, "g");
const FENCE = "^\\s*" + BT + BT + BT;

function inlineMd(text) {
  // Code spans first and put back last, so nothing inside them is read as markup.
  const spans = [];
  let out = String(text).replace(RE_CODESPAN, (_, code) => {
    spans.push(code);
    return "\u0000" + (spans.length - 1) + "\u0000";
  });
  out = esc(out)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    // Images first, or the link rule would eat them: ![alt](src) is a link with a bang in front.
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, alt, src) => {
      const safe = safeHref(src);
      if (safe) return '<img src="' + safe + '" alt="' + esc(alt) + '" loading="lazy">';
      const file = filePath(src);
      return file ? fileImg(file, alt) : whole;
    })
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, href) => {
      const safe = safeHref(href);
      if (safe) return '<a href="' + safe + '" target="_blank" rel="noreferrer noopener">' + label + "</a>";
      const file = filePath(href);
      return file ? fileLink(file, label) : whole;
    });
  out = linkPathsInProse(out);
  /**
   * And a code span that is *only* a path is a path.
   *
   * Backticks around a filename is how a model writes one — I put it in, then the path in them —
   * and treating that as a literal string to be left alone was a rule that fired on exactly the
   * case it was meant to serve. A span with anything else in it is still a literal string, and a
   * path inside a fenced block is still code.
   */
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => {
    const raw = String(spans[Number(i)] ?? "").trim();
    const file = ONLY_A_PATH.test(raw) ? filePath(raw) : "";
    if (!file) return "<code>" + esc(spans[Number(i)]) + "</code>";
    if (/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(raw)) return fileImg(file, raw);
    return fileLink(file, "<code>" + esc(raw) + "</code>");
  });
}

/** One table row into its cells: the outer pipes are optional, the inner ones are the separator. */
function cells(line) {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

function markdownToHtml(src) {
  const lines = String(src ?? "").split("\n");
  const html = [];
  let list = "";
  let para = [];
  const flushPara = () => { if (para.length) { html.push("<p>" + inlineMd(para.join("\n")) + "</p>"); para = []; } };
  const flushList = () => { if (list) { html.push("</" + list + ">"); list = ""; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = new RegExp(FENCE + "(\\w*)").exec(line);
    if (fence) {
      flushPara(); flushList();
      const body = [];
      for (i++; i < lines.length && !new RegExp(FENCE).test(lines[i]); i++) body.push(lines[i]);
      html.push('<pre class="code"' + (fence[1] ? ' data-lang="' + esc(fence[1]) + '"' : "") + "><code>" + esc(body.join("\n")) + "</code></pre>");
      continue;
    }
    const head = /^(#{1,4})\s+(.*)$/.exec(line);
    if (head) { flushPara(); flushList(); html.push("<h" + (head[1].length + 2) + ">" + inlineMd(head[2]) + "</h" + (head[1].length + 2) + ">"); continue; }
    if (/^\s*([-*_])\s*\1\s*\1[-*_\s]*$/.test(line)) { flushPara(); flushList(); html.push("<hr>"); continue; }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) { flushPara(); flushList(); html.push("<blockquote>" + inlineMd(quote[1]) + "</blockquote>"); continue; }
    // A table is the one block that needs the line after it to be recognised at all: the divider is
    // what separates a header row from a paragraph that happens to contain pipes.
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      flushPara(); flushList();
      const aligns = cells(lines[i + 1]).map((c) => (/^:.*:$/.test(c) ? "center" : c.startsWith(":") ? "left" : c.endsWith(":") ? "right" : ""));
      const head = cells(line);
      const body = [];
      for (i += 2; i < lines.length && lines[i].includes("|"); i++) body.push(cells(lines[i]));
      const cell = (tag, text, n) => "<" + tag + (aligns[n] ? ' style="text-align:' + aligns[n] + '"' : "") + ">" + inlineMd(text) + "</" + tag + ">";
      html.push(
        "<table><thead><tr>" + head.map((c, n) => cell("th", c, n)).join("") + "</tr></thead><tbody>" +
          body.map((r) => "<tr>" + r.map((c, n) => cell("td", c, n)).join("") + "</tr>").join("") +
          "</tbody></table>",
      );
      i--;
      continue;
    }
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushPara();
      const want = item[1] ? "ul" : "ol";
      if (list !== want) { flushList(); html.push("<" + want + ">"); list = want; }
      html.push("<li>" + inlineMd(item[3]) + "</li>");
      continue;
    }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    para.push(line);
  }
  flushPara(); flushList();
  return html.join("");
}

/* ---------------- feed ---------------- */

/**
 * Copy, which on a phone is the difference between having a command and retyping it. The clipboard
 * API needs a secure context, and http://192.168.x.x is not one — so there is a fallback, and it is
 * the only reason this is more than one line.
 */
function copyBtn(getText) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = "copy";
  b.title = "Copy this message";
  b.onclick = async (e) => {
    e.stopPropagation();
    const text = getText();
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.append(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        if (!ok) throw new Error("copy refused");
      }
      b.textContent = "copied";
    } catch (_) {
      b.textContent = "copy failed";
    }
    setTimeout(() => { b.textContent = "copy"; }, 1400);
  };
  return b;
}

/**
 * Long text, cut, saying how much there was.
 *
 * Three places cap what they show — a tool result, an extension's message, pi's dying words — and
 * they reported the drop three different ways, one of them not at all: a result that stopped at 8000
 * characters looked like a result that ended there. A cap that hides its own existence is a lie
 * about the output.
 *
 * Counted and cut in characters, which is what the message says and what capChars in src/protocol.ts
 * and previewText in src/session-head.ts have always counted. String.length is code units, so an
 * emoji is two of them: the count came out larger than what was shown, and a cut between the two
 * halves of one left half a character, which a browser draws as a replacement glyph.
 */
function capped(text, n) {
  const chars = Array.from(String(text ?? ""));
  return chars.length > n ? chars.slice(0, n).join("") + "\n… (" + chars.length + " chars)" : chars.join("");
}

/**
 * Long text cut at n characters, with an ellipsis only when something was dropped.
 *
 * The work row's live line — a tool call, a note, the thinking arriving — cut with String.slice,
 * which counts UTF-16 code units: an emoji-heavy preview came out about half as long as its n, and a
 * cut could land between the two halves of one, leaving a lone surrogate the browser draws as a
 * replacement glyph. The feed's caps (above) count characters for the same reason.
 */
function clipChars(text, n) {
  const chars = Array.from(String(text ?? ""));
  return chars.length > n ? chars.slice(0, n).join("") + "…" : chars.join("");
}

/** Replace a row's plain text with its rendered Markdown, keeping the source for the copy button. */
function mdInto(el, text) {
  el.raw = text;
  el.className = "md";
  el.innerHTML = markdownToHtml(plain(text));
  // A picture the session made is fetched with a key of its own, minted as it is drawn.
  for (const img of el.querySelectorAll?.("img[data-file]") ?? []) {
    fileUrl(img.dataset.file)
      .then((u) => { if (u) img.src = u; })
      .catch(() => {});
  }
  // A page written into the conversation is a page you cannot look at. This opens it — sandboxed,
  // served back by this process, never rendered inside this document.
  for (const pre of el.querySelectorAll?.('pre.code[data-lang="html"]') ?? []) {
    // Read before the button goes in, or the word "preview" ends up inside the page it opens.
    const source = pre.textContent;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "preview";
    b.textContent = "preview";
    b.onclick = async () => {
      const r = await api("/preview", { html: source });
      if (!r.success) return row("err", "error", r.error || "could not open a preview");
      const k = await api("/key", { for: "preview", path: r.id });
      if (!k.key) return row("err", "error", k.error || "could not open a preview");
      window.open("/preview/" + r.id + "?key=" + k.key, "_blank", "noopener");
    };
    pre.append(b);
  }
}

/** The clock, on hover: a long session has no other answer to "when". */
function stamp(el) {
  // The tooltip is for a mouse. A touch screen has no hover, so the same time is also kept where
  // the stylesheet can show it under the block (the pointer:coarse rule beside the copy button's).
  const t = clock(Date.now());
  el.title = t;
  el.dataset.when = t;
  return el;
}

function row(cls, role, text) {
  const el = document.createElement("div");
  el.className = "row " + cls;
  const b = document.createElement("span");
  // The answer that follows a turn's work shares its row: the label and its copy button go into
  // the summary, so "ASSISTANT" and "6 steps · thinking, bash" are one line, not two — and the
  // stretch continues past the answer rather than being cut in two.
  const shared = role === "assistant" && toolGroup;
  if (role) {
    if (shared) {
      toolGroup.answerEl = b;
      if (!toolGroup.roleTag) {
        const name = document.createElement("span");
        name.className = "tag";
        name.textContent = role;
        const btn = copyBtn(() => {
          const a = (toolGroup && toolGroup.answerEl) ?? b;
          return a.raw ?? a.textContent ?? "";
        });
        toolGroup.summary.insertBefore(name, toolGroup.what);
        toolGroup.summary.insertBefore(btn, toolGroup.what);
        toolGroup.roleTag = name;
      }
    } else {
      const r = document.createElement("div");
      r.className = "role";
      const name = document.createElement("span");
      name.textContent = role;
      r.append(name);
      // Only where there is something worth copying: a status line is not.
      if (cls === "" || cls === "tool" || cls === "user") r.append(copyBtn(() => b.raw ?? b.textContent ?? ""));
      el.append(r);
    }
  }
  if (text) b.textContent = plain(text);
  el.append(b);
  if (!shared) endToolGroup();
  feed.append(stamp(el));
  scroll();
  return b;
}
/** Calls with no result yet, so a result can be given to the call that made it. */
const openCalls = [];

function argSummary(args) {
  if (typeof args === "string") return args;
  const o = args ?? {};
  // The first string that looks like the subject: a command, a path, a pattern.
  for (const k of ["command", "cmd", "path", "file_path", "filePath", "pattern", "query", "url", "id"]) {
    if (typeof o[k] === "string" && o[k]) return o[k];
  }
  const first = Object.values(o).find((v) => typeof v === "string" && v);
  return first ?? Object.keys(o).join(", ");
}

/** The stretch of work being collected right now, or nothing between them. */
let toolGroup;

/**
 * The stretch of work being collected, made if there is not one.
 *
 * Thinking and tool calls arrive interleaved — think, read, think, run, think — and each one used to
 * take a row of the conversation. A turn that reads four files and runs two commands spent six rows
 * saying so, and a long agentic turn was thirty rows of plumbing around three sentences of answer;
 * the conversation is the thing being read. Consecutive steps collect into one block instead: while
 * it is happening its summary is the step that is happening, so you can still see what it is doing,
 * and when the answer arrives it closes into "6 steps · thinking, read, bash". Everything is still
 * there, one click in. Anything that is not part of the work — a reply, a message, a notice — ends
 * the stretch.
 */
function toolGroupFor() {
  if (toolGroup && toolGroup.parentElement === feed) return toolGroup;
  const d = document.createElement("details");
  d.className = "row work";
  d.open = allOpen;
  const s = document.createElement("summary");
  const what = document.createElement("span");
  what.className = "what";
  s.append(what);
  d.append(s);
  d.what = what;
  d.summary = s;
  d.names = [];
  feed.append(stamp(d));
  toolGroup = d;
  return d;
}

/** While a turn runs, the line says what is happening; afterwards, what happened. */
function describeGroup(group, nowLine) {
  if (!group) return;
  const n = group.names.length;
  if (nowLine) {
    group.what.textContent = nowLine;
    return;
  }
  const unique = [...new Set(group.names)];
  group.what.textContent = n + (n === 1 ? " step · " : " steps · ") + unique.slice(0, 4).join(", ") + (unique.length > 4 ? "…" : "");
}

/** Anything that is not part of the work ends the stretch: an answer, a message, a notice. */
function endToolGroup() {
  if (toolGroup) describeGroup(toolGroup, "");
  toolGroup = undefined;
}

/**
 * Every stretch of work at once, because that is how a person reads them: either the conversation
 * on its own, or the whole of what went into it. The choice is kept in this browser.
 */
let allOpen = remembered("work", "closed") === "open";

function setAllWork(open) {
  allOpen = open;
  remember("work", open ? "open" : "closed");
  for (const d of feed.querySelectorAll?.("details.work") ?? []) d.open = open;
  const b = $("expand");
  b.textContent = open ? "▾ steps" : "▸ steps";
  b.title = open ? "Collapse every step" : "Expand every step";
}

/**
 * The image types an <img> will actually render, and so the only ones a data: URL here may claim.
 *
 * Both ends of the page need it: a type out of a tool result is whatever some web page said, and a
 * type off the clipboard is whatever the source application wrote. One list for all three ways in —
 * the file picker's accept list, a paste, and a tool result — so nothing is sent under a type it is not.
 */
const IMAGE_TYPE = /^image\/(png|jpeg|gif|webp|avif)$/;

/** One image content block, as an image. The data is base64 in the message; nothing is fetched. */
function imageOf(c) {
  const img = document.createElement("img");
  img.className = "shot";
  img.loading = "lazy";
  img.alt = "image";
  const type = IMAGE_TYPE.test(c.mimeType || "") ? c.mimeType : "image/png";
  img.src = "data:" + type + ";base64," + String(c.data).replace(/[^A-Za-z0-9+/=]/g, "");
  return img;
}

/**
 * A tool call and what it returned are one block, and it is closed.
 *
 * They used to be two rows, both open: the arguments as a block of JSON, then however many thousand
 * characters came back. One shell command could push the conversation off the screen, and on a phone
 * it did. The summary is the line that matters — which tool, on what — and the rest is one tap away.
 */
function toolRow(name, args, id, orphan) {
  const el = document.createElement("details");
  el.className = "row tool";
  const sum = document.createElement("summary");
  const what = document.createElement("span");
  what.className = "what";
  const state = document.createElement("span");
  state.className = "state";
  el.state = state;
  // Copying a tool call means copying what it ran and what came back, which is the pair of things
  // you paste into a bug report.
  sum.append(what, state, copyBtn(() => [...el.querySelectorAll("pre")].map((x) => x.textContent).join("\n\n")));
  el.append(sum);
  const pre = document.createElement("pre");
  el.append(pre);
  el.what = what;
  el.setArgs = (a) => {
    what.textContent = clipChars(plain(name + "  " + argSummary(a)), 200);
    pre.textContent = plain(typeof a === "string" ? a : JSON.stringify(a ?? {}, null, 1));
  };
  el.setArgs(args);
  state.textContent = "running";
  const group = toolGroupFor();
  group.names.push(name);
  group.append(el);
  describeGroup(group, clipChars(plain(name + "  " + argSummary(args)), 120));
  // A block made to hold an orphan result is not waiting for one. Registering it here is what used
  // to break the pairing for everything after it.
  if (!orphan) {
    openCalls.push({ id, name, el });
    if (openCalls.length > 100) openCalls.shift();
  }
  scroll();
  return el;
}

/**
 * Which call a result belongs to.
 *
 * By id when there is one, because two calls to the same tool can finish in either order and a
 * queue keyed on the name would hand each one the other's output. By name only as a fallback, and
 * a result that matches nothing gets a block of its own rather than corrupting the list — the
 * earlier version pushed that orphan onto the queue it had just failed to find, and every later
 * result for that tool was off by one for the life of the tab.
 */
function claimCall(id, name) {
  let at = id ? openCalls.findIndex((c) => c.id === id) : -1;
  if (at === -1) at = openCalls.findIndex((c) => c.name === name);
  if (at === -1) return undefined;
  return openCalls.splice(at, 1)[0].el;
}

/** Nothing is coming for these now. They stop claiming to be running, and stop being remembered. */
function endOpenCalls() {
  for (const c of openCalls) if (c.el.state.textContent === "running") c.el.state.textContent = "stopped";
  openCalls.length = 0;
  endToolGroup();
}

function toolResult(name, text, isError, id) {
  const el = claimCall(id, name) ?? toolRow(name || "tool", "", undefined, true);
  el.state.textContent = isError ? "error" : "";
  if (isError) el.classList.add("err");
  const pre = document.createElement("pre");
  pre.textContent = plain(capped(text, 8000));
  el.append(pre);
  scroll();
  return el;
}
/**
 * Thinking is closed, and clicking opens it — which it always was. What it was missing is a reason
 * to click: a line saying only "thinking" hides an unknown amount of unknown text. The summary
 * carries the first of it and how much there is, so the choice is an informed one.
 */
function thinkRow() {
  const d = document.createElement("details");
  d.className = "row think";
  const s = document.createElement("summary");
  const label = document.createElement("span");
  label.textContent = "thinking";
  const peek = document.createElement("span");
  peek.className = "peek";
  s.append(label, peek);
  d.append(s);
  const p = document.createElement("pre");
  d.append(p);
  // Kept up to date as the deltas arrive, and it is the closed state that shows it.
  p.onGrow = () => {
    const text = p.textContent.replace(/\s+/g, " ").trim();
    peek.textContent = text ? " · " + clipChars(text, 90) : "";
    describeGroup(d.parentElement?.classList?.contains("work") ? d.parentElement : undefined, "thinking · " + clipChars(text, 90));
  };
  // Thinking is part of the work, not a separate row of the conversation.
  const group = toolGroupFor();
  group.names.push("thinking");
  group.append(d);
  scroll();
  return p;
}

/* ---------------- streaming assembly: deltas are keyed by contentIndex ---------------- */
let blocks = new Map();
const blockAt = (key, make) => { if (!blocks.has(key)) blocks.set(key, make()); return blocks.get(key); };
/** Append a delta, keeping the raw text: an escape sequence can be split across two of them. */
function grow(el, delta) {
  el.raw = (el.raw || "") + delta;
  el.textContent = plain(el.raw);
  el.onGrow?.();
}

function handle(ev) {
  switch (ev.type) {
    case "agent_start": busy = true; setStatus(); break;
    case "agent_end": busy = false; endOpenCalls(); setStatus(); refresh(); watchTurnEnded(); watchTurnOver(); break;
    case "message_start": blocks = new Map(); break;
    case "message_update": {
      const d = ev.assistantMessageEvent || {};
      if (d.type === "text_delta") grow(blockAt("t" + d.contentIndex, () => row("", "assistant", "")), d.delta);
      else if (d.type === "thinking_delta") grow(blockAt("k" + d.contentIndex, thinkRow), d.delta);
      else if (d.type === "toolcall_start") blockAt("c" + d.contentIndex, () => toolRow(d.toolName, "", d.toolCallId ?? d.id));
      else if (d.type === "toolcall_end" && d.toolCall) blocks.get("c" + d.contentIndex)?.setArgs(d.toolCall.arguments);
      break;
    }
    case "message_end":
      // Markdown is rendered once the message is whole. Half a fenced block is not a fenced block,
      // and re-parsing on every delta would rewrite the DOM under a finger that is scrolling it.
      for (const [key, el] of blocks) if (key[0] === "t" && el.raw) mdInto(el, el.raw);
      if (ev.message && ev.message.role === "assistant") lastReply = (ev.message.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
      renderMessage(ev.message, true);
      break;
    case "send_failed": {
      // A message pi refused comes back where it was typed, with the reason, ahead of anything typed since.
      const input = $("input");
      input.value = ev.text + (input.value ? "\n" + input.value : "");
      images = ev.images || []; drawThumbs(); autoGrow(); saveDraft();
      row("err", "not sent", ev.error || "pi did not take it");
      refresh();
      break;
    }
    case "extension_ui_request": onAsk(ev); break;
    // The terminal that holds this conversation finished a turn, and the server read the file again:
    // numbered like every event, so the one after it is no gap.
    case "reread": void resync(plain(str(ev.why)) || "the conversation above was read again").catch(() => {}); break;
    case "entry_appended":
      // A run card the page's pi saved: drawn as it lands, as a reload draws it from the transcript.
      if (ev.entry?.type === "custom" && ev.entry.customType === "pi-loops:view") renderMessage({ role: "pi-loops:view", id: ev.entry.id, title: ev.entry.data?.title, lines: ev.entry.data?.lines }, true);
      if (ev.entry?.type === "custom") refresh();
      break;
    case "compaction_end":
      // A compaction you asked for is reported by the call that asked for it. This line is for the
      // one pi does on its own when the context fills up — and it used to say "context compacted"
      // for that one whether it had worked, been aborted, or failed, and say it a second time over
      // the top of a manual one that had just reported the opposite.
      if (ev.reason !== "manual") row("notice", "", compactionLine(ev.result, ev.aborted, ev.errorMessage, true));
      refresh();
      break;
    case "pi_exit": {
      busy = false;
      statusEl.textContent = "pi exited";
      // The reason belongs on the page. Anything else means reading a terminal you may have opened
      // this window precisely to avoid.
      const why = (ev.stderr || "").trim();
      const el = row("err", "pi exited" + (ev.signal ? " (" + ev.signal + ")" : ev.code == null ? "" : " (code " + ev.code + ")"), "");
      if (why) {
        const pre = document.createElement("pre");
        pre.textContent = plain(capped(why, 4000));
        el.parentElement.append(pre);
      } else {
        el.textContent = "it stopped without saying why; the terminal that started this has its output";
      }
      scroll();
      break;
    }
  }
}

/**
 * What you typed, drawn here the moment you sent it — and sent back by pi when it lands, because a
 * front end that joined later has to see it too. Both are right; showing both is not. Each message
 * drawn locally is remembered until its echo arrives and cancels it.
 */
const drewLocally = [];
function alreadyDrawn(text) {
  const at = drewLocally.indexOf(text);
  if (at === -1) return false;
  drewLocally.splice(at, 1);
  return true;
}

/**
 * One message onto the screen. fromStream says it arrived live rather than out of the transcript:
 * a live one may be the echo of something this page already drew, and a live assistant message has
 * already been rendered by the deltas that built it.
 */
/** The pi-loops:view entries in the feed, by id; emptied with the feed. */
const drawnViews = new Set();
function renderMessage(message, fromStream) {
  if (!message) return;
  if (message.role === "pi-loops:view") {
    // A run card, or a view a terminal wrote (/cron, /inbox): one notice, as text. Once by its entry
    // id: a card saved while /history was read is in the transcript and arrives as an event too.
    if (message.id !== undefined) {
      if (drawnViews.has(str(message.id))) return;
      drawnViews.add(str(message.id));
    }
    const lines = Array.isArray(message.lines) ? message.lines.map(str) : [];
    row("notice", "", capped([str(message.title), ...lines].join("\n"), 4000));
    return;
  }
  if (message.role === "user") {
    const text = typeof message.content === "string" ? message.content : (message.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    const imgs = typeof message.content === "string" ? 0 : (message.content || []).filter((c) => c.type === "image").length;
    const shown = text + (imgs ? "\n[" + imgs + " image(s)]" : "");
    // The Watch box's sentence, echoed: the turn that carries it is the one whose end counts.
    if (fromStream && watchReading && text === watchReading.text) watchReading.turn = true;
    if (fromStream && alreadyDrawn(shown)) return;
    if (text || imgs) {
      const body = row("user", "you", text);
      // What you sent, shown back. A line saying "[2 image(s)]" is a receipt, not a message.
      for (const c of Array.isArray(message.content) ? message.content : []) {
        if (c?.type === "image" && c.data) body.parentElement.append(imageOf(c));
      }
    }
  } else if (message.role === "toolResult") {
    const parts = Array.isArray(message.content) ? message.content : [message.content];
    const text = parts.map((c) => (typeof c === "string" ? c : (c?.text ?? ""))).join("");
    const el = toolResult(message.toolName || "tool", text, message.isError, message.toolCallId ?? message.id);
    // A tool that answers with a picture was answering with nothing at all until now: the image
    // blocks were filtered out and only the text of the result was kept.
    for (const c of parts) if (c && c.type === "image" && c.data) el.append(imageOf(c));
    // The answer to a watch question, as it lands: the card it asked with becomes its receipt.
    if ((message.toolName === "cron_create" || message.toolName === "new_trigger") && fromStream) watchResult(message);
  } else if (message.role === "custom") {
    // A promotion pi-loops pushed into the chat ("[Trigger ...] ..."), or another extension message.
    // display:false means the model sees it and the person is not meant to.
    if (message.display === false) return;
    const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
    const shown = capped(text, 4000);
    /**
     * Where it goes depends on when it arrived. An extension that logs what a tool just did — "wrote
     * 166 lines to x.html" — speaks in the middle of a stretch of work, and belongs inside it: as a
     * row of its own it both takes a line and cuts the stretch in two, so six steps and thirty-five
     * become three rows instead of one. A message that arrives between turns is a message.
     */
    if (toolGroup) {
      const el = document.createElement("div");
      el.className = "note";
      const name = document.createElement("div");
      name.className = "role";
      name.textContent = message.customType || "note";
      const body = document.createElement("span");
      body.textContent = plain(shown);
      el.append(name, body);
      toolGroup.append(el);
      toolGroup.names.push(message.customType || "note");
      describeGroup(toolGroup, clipChars(plain(shown), 120));
      scroll();
      return;
    }
    row("tool", message.customType || "custom", shown);
  } else if (message.role === "assistant" && !fromStream) {
    for (const c of message.content || []) {
      if (c.type === "text" && c.text) mdInto(row("", "assistant", ""), c.text);
      else if (c.type === "thinking" && c.thinking) {
        const p = thinkRow();
        p.textContent = plain(c.thinking);
        p.onGrow();
      }
      else if (c.type === "toolCall") toolRow(c.name, c.arguments, c.id).state.textContent = "";
    }
  }
}

/** What pi itself still holds (a slash command or template typed while busy): listed after the rows, labelled "pi". */
function piQueue() {
  const q = state.queue || {};
  return [...(q.steering || []), ...(q.followUp || [])];
}

function setStatus() {
  const q = (state.requests || []).length + piQueue().length;
  const qe = $("queue");
  qe.hidden = !q;
  qe.textContent = "queued " + q + " ✕";
  qe.onclick = () => api("/queue/clear", {}).then(refresh);
  statusEl.textContent = busy ? "working…" : "ready";
  drawQueue();
}

/**
 * What is queued for this session, in the order it runs: your messages and what pi-loops addressed
 * to the conversation, one list, each with its source and a ✕. A message a previous page left
 * behind is offered — "not sent before pi stopped" — with send and discard, and is sent by nobody
 * until you choose. After Stop your own queued messages wait until you send again or press "send
 * queued (n)".
 */
function drawQueue() {
  const box = $("queued");
  const list = state.requests || [];
  const inPi = piQueue();
  box.hidden = !list.length && !inPi.length;
  box.innerHTML = "";
  if (box.hidden) return;
  const button = (label, title, onclick) => {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = label; b.title = title; b.onclick = onclick;
    return b;
  };
  // A claim's row cancelled here: its card says so, not that it was handed over (drawInbox).
  const cancel = (id, source) => () =>
    api("/queue/cancel", { id }).then((r) => {
      if (r && r.success && typeof source === "string" && source.startsWith("inbox:")) {
        cancelledClaims.add(source.slice("inbox:".length));
        drawInbox();
      }
      return refresh();
    });
  const send = (id) => () => api("/queue/send", id === undefined ? {} : { id }).then(refresh);
  const sendHere = (id) => () => api("/queue/send-here", { id }).then(refresh);
  for (const q of list) {
    const line = document.createElement("div");
    // Stuck: this page's message that nobody took in fifteen seconds (the pi holding the session
    // stands aside, is busy or suspended, or is not interactive); the server writes the line and
    // names the offer, if there is one.
    const stuck = q.stuck;
    line.className = "qrow" + (q.offered ? " offered" : stuck ? " stuck" : "");
    const who = document.createElement("span");
    who.className = "m";
    who.textContent = q.offered ? "not sent before pi stopped" : stuck ? stuck.line : q.label;
    const what = document.createElement("span");
    // Offered: whole and wrapped, since send vouches for every word of it.
    what.className = q.offered ? "qtext full" : "qtext";
    what.textContent = q.text + (q.images ? " [" + q.images + " image(s)]" : "");
    line.append(who, what);
    if (q.offered) line.append(button("send", "Send it now, from this page", send(q.id)), button("discard", "Forget it", cancel(q.id)));
    else if (stuck && stuck.button) line.append(button(stuck.button, "Take it out of the queue and send it to this page's pi, as before 0.24", sendHere(q.id)), button("✕", "Cancel this before it runs", cancel(q.id, q.source)));
    else line.append(button("✕", "Cancel this before it runs", cancel(q.id, q.source)));
    box.append(line);
  }
  for (const text of inPi) {
    const line = document.createElement("div");
    line.className = "qrow pi";
    const who = document.createElement("span");
    who.className = "m";
    who.textContent = "pi";
    const what = document.createElement("span");
    what.className = "qtext";
    what.textContent = String(text);
    line.append(who, what);
    box.append(line);
  }
}

/* ---------------- the automation panel ---------------- */
// Quotes included: the sidebar interpolates a job id into an attribute, and jobs.json is a file on
// disk, not something this page gets to assume is well formed.
const ESCAPES = { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" };
function esc(s) { return String(s ?? "").replace(/[<>&"']/g, (c) => ESCAPES[c]); }
// A count out of a JSON file is a number only if the file says so: a runCount holding an img tag
// with an onerror handler is a perfectly valid file, and interpolating it raw reaches the DOM.
function num(n) { return Number.isFinite(Number(n)) ? Number(n) : 0; }
// And .slice() is a string method: a job whose lastError is a number, or which has no id at all,
// is a file this page has to draw, not a reason for the whole panel to stop redrawing.
function str(v) { return v === undefined || v === null ? "" : String(v); }

/**
 * Escape, and strip what escaping does not stop.
 *
 * esc() keeps a name out of the markup; it does nothing about a bidi override, which is invisible and
 * reorders the line drawn around it, or a C0 control, which can blank what follows. Every string in
 * this panel comes off the disk (jobs.json, triggers.json) or out of pi (a snapshot, a dialog), so
 * every one of them goes through both. A job named "backup\u202e evil" must draw as what it is.
 */
function safeText(v) { return esc(plain(str(v))); }

// Which cards were open when the panel last drew. The panel is rebuilt as one string and assigned
// every eight seconds, so the open flag has nowhere to live but here: read before the draw, restore
// after it, and a card toggled between draws updates this at once through its own toggle event.
const openCards = new Set();

/**
 * A loop row's Stop this run, kept across the 8-second redraw the way openCards is: the confirm a
 * person opened (confirming: run id to loop id), a stop on its way (stopping: run id to its loop and
 * when it was sent), and what became of one (stopNote: loop id to the line). Nothing here is typed,
 * so closing the confirm by any means loses nothing.
 */
const confirming = new Map();
const stopping = new Map();
const stopNote = new Map();
/** A suggestion's answer, by loop id, until the next draw shows the loop as it is now. */
const tuneNote = new Map();
/** An applied suggestion's next run, by loop id, for the minute before next-runs.json says it too. */
const appliedNext = new Map();
/** The next run a loop row shows: the applied one while the store's answer has not caught up, and never one that has passed. */
function nextOf(j) {
  const a = appliedNext.get(j.id);
  if (!a) return j.next;
  if (Date.now() > a.until || !(Date.parse(a.nextAt) > Date.now()) || a.schedule !== str(j.schedule) || j.next === a.nextAt) { appliedNext.delete(j.id); return j.next; }
  return a.nextAt;
}
/** How long a stop may take before the row says so instead of claiming it. */
const STOP_SLOW_MS = 8000;
// A click anywhere outside a loop row closes an open confirm, sending nothing. The row's own buttons
// and the confirm keep their clicks to themselves, so this hears only the rest of the page.
document.addEventListener("click", (e) => {
  if (!confirming.size || (e && e.target && e.target.closest && e.target.closest(".loopx"))) return;
  confirming.clear();
  renderSidebar(state);
});

function rowButton(label, primary, onclick, act) {
  const b = document.createElement("button");
  b.type = "button";
  if (act) b.dataset.act = act;
  if (primary) b.className = "primary";
  b.textContent = label;
  b.onclick = (e) => {
    // The row sits in the card's summary: a click on its buttons is not a click on the card.
    e.preventDefault(); e.stopPropagation();
    onclick();
  };
  return b;
}

/** Ask the snapshot again every second while a stop is on its way, for at most STOP_SLOW_MS and one second more. */
function followStop(runId) {
  const tick = () => {
    const sent = stopping.get(runId);
    if (!sent) return;
    refresh().catch(() => {});
    if (Date.now() - sent.at <= STOP_SLOW_MS) setTimeout(tick, 1000);
  };
  setTimeout(tick, 1000);
}

async function sendStop(j, runId) {
  confirming.delete(runId);
  stopping.set(runId, { jobId: j.id, at: Date.now() });
  stopNote.delete(j.id);
  renderSidebar(state);
  const r = await inboxPost("/loops/stop", { runId });
  if (r.status === 200 && r.body && r.body.ok) followStop(runId);
  else {
    stopping.delete(runId);
    stopNote.set(j.id, r.body && r.body.finished ? "It finished before the stop reached it." : "Could not stop it: " + str(r.body && r.body.error || "no answer"));
  }
  renderSidebar(state);
}

async function sendTune(j, choice) {
  const key = j.suggestion && j.suggestion.key;
  if (!key) return;
  const r = await inboxPost("/loops/tune", { jobId: j.id, key, choice });
  // Until the scheduler rewrites next-runs.json (its next tick), the row's next run is the one the
  // answer gave, so the row and the note say one time.
  if (r.status === 200 && r.body.nextAt) appliedNext.set(j.id, { schedule: str(r.body.schedule), nextAt: str(r.body.nextAt), until: Date.now() + 60000 });
  tuneNote.set(j.id, r.status === 200 ? (choice === "keep" ? "Kept as it is." : str(r.body.line) + (r.body.nextAt ? " · next " + clock(r.body.nextAt) : r.body.due ? " · next run now" : "")) : r.status === 409 ? "The suggestion changed; here is the loop as it is now." : "Could not do that: " + str(r.body && r.body.error || "no answer"));
  refresh().catch(() => {});
}

/** The row under a loop's name: running with Stop this run and its confirm, the signal, one suggestion. */
function drawLoopRow(slot, j) {
  const name = str(j.name || j.id);
  const run = j.run && typeof j.run.runId === "string" ? j.run : undefined;
  // A confirm or a stop for a run of this loop that is no longer the one running: it ended.
  for (const [runId, jobId] of confirming) if (jobId === j.id && (!run || run.runId !== runId)) { confirming.delete(runId); stopNote.set(j.id, "This run has finished."); }
  // The run log says how it ended: a stop that landed, or a run that ended some other way first.
  for (const [runId, sent] of stopping) if (sent.jobId === j.id && (!run || run.runId !== runId)) { stopping.delete(runId); stopNote.set(j.id, j.lastEnd && j.lastEnd.runId === runId && j.lastEnd.stoppedBy === "person" ? "Stopped by you." : "The run ended."); }
  if (run) {
    const line = document.createElement("span");
    line.className = "runline";
    line.append(textEl("span", "", "running " + ago(run.since)));
    const sent = stopping.get(run.runId);
    if (sent) line.append(textEl("span", "", Date.now() - sent.at > STOP_SLOW_MS ? "· stopping is taking longer than usual" : "· stopping…"));
    else if (!confirming.has(run.runId)) line.append(rowButton("Stop this run", false, () => { confirming.set(run.runId, j.id); stopNote.delete(j.id); renderSidebar(state); }, "stop"));
    slot.append(line);
    if (confirming.has(run.runId)) {
      const box = document.createElement("span");
      box.className = "confirm";
      box.append(textEl("span", "", "Stop this run of " + name + "? Its notes are not updated. " + (str(j.schedule).startsWith("once") ? "It will not run again by itself." : "The next run happens on schedule.")));
      const acts = document.createElement("span");
      acts.className = "acts";
      acts.append(rowButton("Stop it", true, () => sendStop(j, run.runId).catch(() => {}), "stop-confirm"), rowButton("Keep running", false, () => { confirming.delete(run.runId); renderSidebar(state); }, "stop-cancel"));
      box.append(acts);
      box.onclick = (e) => { e.preventDefault(); e.stopPropagation(); };
      slot.append(box);
    }
  }
  const note = stopNote.get(j.id);
  if (note) {
    const done = document.createElement("span");
    done.className = "confirm";
    done.append(textEl("span", "", note), rowButton("OK", false, () => { stopNote.delete(j.id); renderSidebar(state); }, "ok"));
    done.onclick = (e) => { e.preventDefault(); e.stopPropagation(); };
    slot.append(done);
  }
  const g = j.signal;
  if (g) slot.append(textEl("span", "signal", "30d: " + num(g.findings30d) + " finding" + (num(g.findings30d) === 1 ? "" : "s") + " · " + num(g.claimed30d) + " claimed · " + num(g.dismissed30d) + " dismissed" + (num(g.quietStreak) >= 3 ? " · quiet ×" + num(g.quietStreak) : "")));
  const told = tuneNote.get(j.id);
  if (told) { slot.append(textEl("span", "signal note", told)); tuneNote.delete(j.id); }
  else if (j.suggestion && j.suggestion.key) {
    const acts = document.createElement("span");
    acts.className = "acts suggest";
    acts.append(rowButton(str(j.suggestion.label), false, () => sendTune(j, "apply").catch(() => {}), "tune"), rowButton("Keep", false, () => sendTune(j, "keep").catch(() => {}), "keep"));
    slot.append(acts);
  }
}

function renderSidebar(s) {
  const a = s.automation || {};
  const box = $("auto");
  if (!a.installed) { box.innerHTML = '<div class="notice">pi-loops not found in ' + safeText(a.dir || "") + "</div>"; }
  else {
    let html = "";
    for (const j of a.jobs) {
      // The prompt is shown twice — a two-line peek in the summary, the whole of it in the body —
      // rather than once and cut, which is what the 90-character slice was: a preview that hid the
      // rest with no way to see it. Both copies go through safeText; neither is sliced here.
      const prompt = safeText(j.prompt);
      html += '<details class="card job' + (j.enabled ? "" : " off") + '" data-key="job:' + safeText(j.id) + '">' +
        '<summary><span class="t"><b>' + safeText(j.label || j.name || j.id) + "</b>" +
        '<span class="m">' + safeText(j.schedule) + (j.stateful ? " · loop" : "") + (j.enabled ? "" : " · disabled") + "</span>" +
        '<button data-run="' + safeText(j.id) + '">run</button></span>' +
        '<span class="m peek">' + prompt + "</span>" +
        // A run pi-loops holds has its own line, with Stop this run, under the card's name.
        '<span class="m">' + (j.running && !j.run ? "running · " : "") + "runs " + num(j.runCount) + (nextOf(j) ? " · next " + safeText(clock(nextOf(j))) : "") + "</span>" +
        // A one-line hint so a job that is failing says so before it is opened; the whole error is in
        // the body. It is a .peek like the prompt, hidden once the card is open.
        (j.lastError ? '<span class="m peek failing">' + safeText(j.lastError) + "</span>" : "") +
        (j.asleep ? '<span class="m dim">' + safeText(j.asleep) + "</span>" : "") +
        // Stop this run, the loop's worth and its one suggestion: drawn into this slot with textContent
        // after the panel is assigned (drawLoopRow), so nothing in them is markup.
        '<span class="m loopx" data-loopx="' + safeText(j.id) + '"></span>' +
        "</summary>" +
        '<div class="body">' +
        '<pre class="full">' + prompt + "</pre>" +
        '<button class="copy" data-copy="' + safeText(j.id) + '">copy</button>' +
        '<div class="m">id ' + safeText(j.id) + " · cwd " + safeText(j.cwd) + (j.lastFiredAt ? " · last fired " + safeText(clock(j.lastFiredAt)) : "") + (j.skippedOverlap ? " · skipped overlaps " + num(j.skippedOverlap) : "") + "</div>" +
        // A job belonging to a hostname this machine no longer has: it is listed, because it exists,
        // and it says why nothing is happening rather than leaving you to find out from the silence.
        (j.lastError ? '<div class="m bad">' + safeText(j.lastError) + "</div>" : "") +
        "</div></details>";
    }
    for (const r of a.rules) {
      html += '<details class="card rule' + (r.enabled ? "" : " off") + '" data-key="rule:' + safeText(r.id) + '">' +
        '<summary><span class="t"><b>rule</b><span class="m">' + (r.enabled ? "" : "disabled · ") + (r.fireOnce ? "once" : "repeat") + "</span></span>" +
        '<span class="m peek">when ' + safeText(r.condition) + "</span>" +
        (r.look ? '<span class="m looks" data-rulelook="' + safeText(r.id) + '"></span>' : "") +
        "</summary>" +
        '<div class="body">' +
        '<pre class="full">when ' + safeText(r.condition) + "</pre>" +
        '<pre class="full">→ ' + safeText(r.action) + "</pre>" +
        "</div></details>";
    }
    if (!a.jobs.length && !a.rules.length) html += '<div class="notice">no loops or rules in this project</div>';
    // The store is machine-wide and this list is not: without these lines, a job made in another
    // directory is indistinguishable from a job that is gone. Counted and labelled apart, because
    // /cron counts jobs and /triggers counts rules: one number covering both agrees with neither
    // command, and the line exists to send someone to the command.
    const jobsAway = num(a.elsewhere?.jobs);
    const rulesAway = num(a.elsewhere?.rules);
    if (jobsAway) html += '<div class="notice">+ ' + jobsAway + " loop" + (jobsAway === 1 ? "" : "s") + " in other projects — /cron all</div>";
    if (rulesAway) html += '<div class="notice">+ ' + rulesAway + " rule" + (rulesAway === 1 ? "" : "s") + " elsewhere — /triggers rules --all</div>";
    const check = s.lastPoll || a.lastCheck;
    if (check) html += '<div class="notice">last check: ' + safeText(check.state || "") + " · " + esc(clock(check.at)) + "</div>";
    // The open state survives the redraw by being read out before the panel is rebuilt and put back
    // after: the cards themselves are new elements each time, so the flag has to live in this set.
    box.querySelectorAll("details[data-key]").forEach((d) => {
      if (d.open) openCards.add(d.dataset.key); else openCards.delete(d.dataset.key);
    });
    box.innerHTML = html;
    const slots = [...box.querySelectorAll("[data-loopx]")];
    for (const j of a.jobs) {
      const slot = slots.find((el) => el.dataset.loopx === str(j.id));
      if (slot) drawLoopRow(slot, j);
    }
    const looks = [...box.querySelectorAll("[data-rulelook]")];
    for (const r of a.rules) {
      const slot = r.look && looks.find((el) => el.dataset.rulelook === str(r.id));
      if (slot) slot.textContent = plain("waits for " + str(r.waitsFor) + " · " + (r.nextLookAt && clock(r.nextLookAt) ? "next look " + clock(r.nextLookAt) + " · " : "") + str(r.look));
    }
    box.querySelectorAll("details[data-key]").forEach((d) => {
      if (openCards.has(d.dataset.key)) d.open = true;
      // The toggle event does not bubble, so it is heard per card, not once on the box: a card
      // closed by hand between draws stays closed when the next draw runs.
      d.addEventListener("toggle", () => {
        if (d.open) openCards.add(d.dataset.key); else openCards.delete(d.dataset.key);
      });
    });
    box.querySelectorAll("[data-run]").forEach((b) => (b.onclick = (e) => {
      // A click anywhere in a summary toggles the card; the run button is a summary's own button,
      // not a way to open the prompt.
      e.preventDefault(); e.stopPropagation();
      api("/trigger/immediate", { id: b.dataset.run });
    }));
    box.querySelectorAll("[data-copy]").forEach((b) => {
      const card = b.closest?.("details[data-key]");
      b.type = "button";
      // Reads the prompt back from the DOM rather than holding a second copy in JS, the way the
      // feed's tool rows do, so the two can never fall out of step.
      b.onclick = async (e) => {
        e.stopPropagation();
        const text = card?.querySelector?.("pre.full")?.textContent ?? "";
        try {
          if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
          else {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.append(ta);
            ta.focus();
            ta.select();
            let ok = false;
            try { ok = document.execCommand("copy"); } finally { ta.remove(); }
            if (!ok) throw new Error("copy refused");
          }
          b.textContent = "copied";
        } catch (_) {
          b.textContent = "copy failed";
        }
        setTimeout(() => { b.textContent = "copy"; }, 1400);
      };
    });
  }
  renderRuntime(s.runtime, s.automation);
  $("goal").textContent = s.goal ? plain((s.goal.condition || "") + " — " + (s.goal.status || "") + " (" + (s.goal.iterations ?? 0) + ")") : "none";
  $("meta").textContent = plain([s.sessionName, s.messageCount + " messages", s.model?.label].filter(Boolean).join(" · "));
}

// What only the pi process knows: which servers connected, what they exposed, whether pi-loops runs.
// pi-loops writes it as a pi_loops_snapshot entry; nothing here is guessed from config files.
/**
 * A count on its own answers "how many" and nothing else — and the question a person actually has
 * is which ones. Any number rendered through this can be clicked for the list behind it.
 */
const detailLists = new Map();
let detailSeq = 0;

/**
 * Put a list behind a number and give back the key that opens it, or nothing when there is no list.
 *
 * Both the inline counts and the tiles need this, and both used to mint their own key: two copies of
 * one convention, which is how the two of them could have disagreed about it.
 */
function detailKey(label, names) {
  const items = (names || []).filter(Boolean).map(String);
  if (!items.length) return undefined;
  const key = "d" + detailSeq++;
  detailLists.set(key, { title: label, items });
  return key;
}

function countOf(n, label, names) {
  const key = detailKey(label, names);
  if (!key) return num(n) + " " + esc(label);
  return '<button class="count" data-detail="' + key + '">' + num(n) + " " + esc(label) + "</button>";
}

/** A row of figures rather than a sentence: the number is what is being read. */
function metrics(items) {
  const tileHtml = items.map(([label, n, names]) => {
    const inner = "<b>" + num(n) + "</b><span>" + esc(label) + "</span>";
    const key = detailKey(label, names);
    if (!key) return "<div>" + inner + "</div>";
    return '<button class="metric" data-detail="' + key + '">' + inner + "</button>";
  });
  return '<div class="metrics">' + tileHtml.join("") + "</div>";
}

function showDetail(key) {
  const d = detailLists.get(key);
  if (!d) return;
  $("detailTitle").textContent = plain(d.title) + " (" + d.items.length + ")";
  const body = $("detailBody");
  body.innerHTML = "";
  for (const item of d.items) {
    const line = document.createElement("div");
    line.className = "detail-row";
    // An MCP server's name and a tool's name are whatever that server said they were.
    line.textContent = plain(item);
    body.append(line);
  }
  $("detail").showModal();
}

/**
 * Thirty-three lines of provider-slash-id is a list, not a picker. Grouped by provider, named the
 * a person would name them, and annotated with the two things that decide the choice: how much
 * context there is and whether it can look at a picture.
 */
function drawModels(catalog, current) {
  const picker = $("model");
  const key = catalog.length + "|" + (current ?? "");
  if (picker.dataset.n === key) return; // unchanged; do not disturb a menu somebody has open
  picker.dataset.n = key;
  picker.innerHTML = "";
  const byProvider = new Map();
  for (const m of catalog) {
    if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
    byProvider.get(m.provider).push(m);
  }
  const label = (m) => {
    const bits = [m.name || m.id];
    if (m.contextWindow) bits.push(Math.round(m.contextWindow / 1000) + "k");
    if (m.images) bits.push("images");
    return bits.join(" · ");
  };

  const spec = (m) => m.provider + "/" + m.id;
  const known = new Map(catalog.map((m) => [spec(m), m]));

  // The model in use, when the catalog does not have it.
  //
  // pi lists only providers you have credentials for, and a session can be running on one you do
  // not: --model deepseek resolving to a gateway that will not authenticate leaves the session on
  // that model with nothing in the catalog to match it. The picker then had no option to select and
  // showed nothing at all — a blank control, while the Session panel named the model. Say which one
  // it is and why it is not in the list below.
  if (current && !known.has(String(current))) {
    const g = document.createElement("optgroup");
    g.label = String(current).split("/")[0];
    g.append(new Option(String(current) + " (not in the catalog)", String(current)));
    picker.append(g);
  }

  // What you have chosen before, most recent first — this browser only, and only ones still
  // offered. pi already filters the catalog to providers you have configured, so everything here
  // is usable; this is about the difference between usable and used.
  const recent = remembered("models", "").split(",").filter(Boolean);
  const mine = recent.map((k) => known.get(k)).filter(Boolean).slice(0, 5);
  if (mine.length) {
    const g = document.createElement("optgroup");
    g.label = "recent";
    for (const m of mine) g.append(new Option(label(m), spec(m)));
    picker.append(g);
  }

  // Then the provider whose model is in use, then the rest as pi listed them.
  const currentProvider = current ? String(current).split("/")[0] : undefined;
  const order = [...byProvider.keys()].sort((a, b) => (a === currentProvider ? -1 : b === currentProvider ? 1 : 0));
  for (const provider of order) {
    const g = document.createElement("optgroup");
    g.label = provider;
    for (const m of byProvider.get(provider)) g.append(new Option(label(m), spec(m)));
    picker.append(g);
  }
}

/** Only the levels this model has. A level pi maps to null is a level that does nothing. */
function drawThinking(levels, current) {
  const picker = $("thinking");
  const list = (levels && levels.length ? levels : ["off", "minimal", "low", "medium", "high", "xhigh", "max"]).map(String);
  if (picker.dataset.levels !== list.join(",")) {
    picker.dataset.levels = list.join(",");
    picker.innerHTML = "";
    for (const l of list) picker.append(new Option(l, l));
  }
  if (current) picker.value = current;
}

function renderRuntime(rt, auto) {
  const box = $("runtime");
  // The panel is redrawn every few seconds; without this the lists behind it accumulate for as long
  // as the tab is open.
  detailLists.clear();
  if (!rt) { box.textContent = "no snapshot yet — /cron snapshot writes one"; return; }
  const dot = (state) => '<span class="dot ' + (state === "connected" ? "up" : state === "disabled" || state === "idle" ? "idle" : "down") + '"></span>';
  let html = "";
  for (const m of rt.mcp || []) {
    // An MCP server's name, its state and its last error are all that server's own words.
    html += "<div>" + dot(m.state) + safeText(m.name) + " <span class=\"m\">" + safeText(m.state) + " · " + countOf((m.tools || []).length, "tools", m.tools) +
      (m.injects ? " · injects" : "") + (m.queued ? " · " + num(m.queued) + " queued" : "") + "</span></div>" +
      (m.lastError ? '<div class="m bad">  ' + safeText(str(m.lastError)) + "</div>" : "");
  }
  if (rt.mcpConfigError) html += '<div class="m bad">mcp.toml: ' + safeText(rt.mcpConfigError) + "</div>";
  const h = rt.hooks || {};
  html += metrics([
    ["hooks", h.count, h.events],
    ["tools", (rt.tools || []).length, rt.tools],
    ["mcp", (rt.mcp || []).length, (rt.mcp || []).map((m) => m.name)],
  ]);
  if (rt.poll) html += '<div class="m">last check ' + esc(clock(rt.poll.at)) + " · " + safeText(rt.poll.outcome || "") + "</div>";
  html += '<div class="m">snapshot ' + esc(clock(rt.at)) + " · v" + safeText(rt.version || "?") + "</div>";
  box.innerHTML = html;
  // The lists are rebuilt with the panel, so the handler is attached to the panel, not the buttons.
  box.onclick = (e) => {
    // The tiles have a <b> and a <span> filling them, so the click target is usually one of those
    // and not the button carrying the key. Ask upwards.
    const key = e.target?.closest?.("[data-detail]")?.dataset?.detail ?? e.target?.dataset?.detail;
    if (key) showDetail(key);
  };
}

async function refresh() {
  state = await api("/state");
  checkStream?.(state);
  checkAge(state);
  cwd = state.cwd || "";
  $("cwd").textContent = cwd;
  $("cwd").title = cwd;
  $("sid").textContent = state.sessionId || "";
  drawModels(state.modelCatalog || [], state.model?.label);
  if (state.model) $("model").value = state.model.label;
  drawThinking(state.thinkingLevels, state.thinkingLevel);
  // Whether this model can look at an image is something pi knows and the button was guessing at.
  const currentModel = (state.modelCatalog || []).find((m) => state.model && m.provider + "/" + m.id === state.model.label);
  takesImages = currentModel?.images !== false;
  $("attach").disabled = !takesImages;
  $("attach").title = takesImages ? "Attach images" : (state.model?.id || "this model") + " does not take images";
  busy = state.busy;
  setStatus();
  renderSidebar(state);
  drawFrame(state);
  markOpenRead();
  // The list rides on this poll rather than a timer of its own: at most every fifteen seconds, and
  // only while the tab is looked at.
  if (document.visibilityState === "visible" && Date.now() - listAt >= LIST_EVERY_MS) refreshList().catch(() => {});
  // The strip, the title and the notifications ride every poll, hidden or not (refreshActivity).
  refreshActivity().catch(() => {});
  api("/stats").then((st) => {
    if (!st || st.error) return;
    const pct = st.contextUsage?.percent;
    $("cost").textContent = "$" + (st.cost ?? 0).toFixed(3) + " · " + Math.round((st.tokens?.total ?? 0) / 1000) + "k" + (pct == null ? "" : " · ctx " + Math.round(pct) + "%");
  });
  for (const ask of state.pendingAsks || []) onAsk(ask);
}

/* ---------------- extension dialogs (pi-loops' approvals land here) ---------------- */
/**
 * Which dialogs this page has already put on the screen, so the eight-second poll does not offer the
 * same one again. Cleared by a resync: a reload takes the transcript afresh, and the server's own
 * list of unanswered dialogs is what it hands back.
 */
const asked = new Set();
/**
 * The dialog on the screen right now, if any. There is one dialog element for all of them, and
 * showModal() on one that is already open throws — so the id is held here as well as in the set
 * above, which a resync empties on purpose.
 */
let showingAsk;
function onAsk(req) {
  if (req.method === "notify") { row("notice", "", req.message); return; }
  if (!["confirm", "select", "input", "editor"].includes(req.method)) return;
  // A watch question is the card in the conversation, not the dialog over it.
  const watch = watchAskOf(req);
  if (watch) return void watchAsked(watch);
  if (asked.has(req.id) || showingAsk) return;
  asked.add(req.id);
  showingAsk = req.id;
  const dlg = $("ask");
  // An extension writes the title, and an extension is code somebody else installed: the same rule
  // the message body has always had applies to the line above it.
  $("askTitle").textContent = plain(req.title || req.method);
  /**
   * A confirmation is only worth anything if you can see what you are confirming. The danger gate
   * sends a message with the command in it and a line saying why it was stopped; run together in
   * one paragraph they read as prose and get waved through. Split on the first blank line: what is
   * about to run goes in a box of its own, the reasoning goes under it.
   */
  const text = String(req.message || "");
  const cut = text.indexOf("\n\n");
  const subject = cut === -1 ? text : text.slice(0, cut);
  const why = cut === -1 ? "" : text.slice(cut + 2).trim();
  $("askBody").textContent = plain(subject);
  const reason = $("askWhy");
  reason.textContent = plain(why);
  reason.hidden = !why;
  const field = $("askField");
  field.innerHTML = "";
  let input = null;
  if (req.method === "select") { input = document.createElement("select"); for (const o of req.options || []) input.append(new Option(o, o)); field.append(input); }
  if (req.method === "input" || req.method === "editor") {
    input = document.createElement("textarea");
    input.style.width = "100%"; input.rows = req.method === "editor" ? 8 : 2; input.value = req.prefill || "";
    field.append(input);
  }
  $("askOk").textContent = req.method === "confirm" ? "approve" : "ok";
  // Esc closes a dialog with no returnValue, which is already "declined". What must not happen is a
  // stray Enter approving something: the cancel button holds the focus, so it is what Enter hits.
  setTimeout(() => dlg.querySelector("menu button")?.focus(), 0);
  dlg.returnValue = "";
  dlg.showModal();
  // pi refuses a timed question on its own when the time is up and does not say so: past that, an
  // answer reaches nobody, so the dialog goes and approving it is not reported.
  const deadline = req.timeout > 0 ? Date.now() + req.timeout : undefined;
  let expired = false;
  const timer = deadline === undefined ? undefined : setTimeout(() => { expired = true; dlg.close(); }, req.timeout);
  dlg.addEventListener("close", () => {
    showingAsk = undefined;
    clearTimeout(timer);
    if (expired || (deadline !== undefined && Date.now() >= deadline)) {
      row("notice", "", (req.title || req.method) + " → timed out with no answer: refused");
      return;
    }
    const ok = dlg.returnValue === "ok";
    const answer = { id: req.id };
    if (!ok) answer.cancelled = true;
    else if (req.method === "confirm") answer.confirmed = true;
    else answer.value = input ? input.value : undefined;
    api("/ui-response", answer);
    row("notice", "", (req.title || req.method) + " → " + (ok ? "approved" : "declined"));
  }, { once: true });
}

/* ---------------- composer ---------------- */
let images = [];
function drawThumbs() {
  $("thumbs").innerHTML = "";
  images.forEach((im, i) => {
    // A visible ✕ rather than a tooltip: a finger cannot hover, so "click to remove" was a secret.
    const wrap = document.createElement("div");
    wrap.className = "thumb";
    const img = document.createElement("img");
    img.src = "data:" + im.mimeType + ";base64," + im.data;
    const x = document.createElement("button");
    x.type = "button";
    x.className = "x";
    x.textContent = "✕";
    x.title = "Remove this image";
    x.setAttribute("aria-label", "Remove this image");
    x.onclick = () => { images.splice(i, 1); drawThumbs(); };
    wrap.append(img, x);
    $("thumbs").append(wrap);
  });
}
/** One message is one message. Ten images is already an unusual one, and a hundred is a mistake. */
const MAX_IMAGES = 10;

function addFile(file) {
  if (!file) return;
  if (images.length >= MAX_IMAGES) return row("notice", "", "up to " + MAX_IMAGES + " images per message; the rest were left out");
  // Refused, not relabelled. An SVG or a TIFF used to be sent as "image/png" — bytes claiming to be
  // something they are not, which neither an <img> nor a model can decode, and the only sign of it
  // was a broken thumbnail. The same notice the ten-image cap uses, because it is the same answer:
  // this is not going with the message, and here is why.
  if (!IMAGE_TYPE.test(file.type || "")) return row("notice", "", (file.type || "that file") + " is not an image this can send; attach PNG, JPEG, GIF, WebP or AVIF");
  const r = new FileReader();
  r.onload = () => { images.push({ type: "image", data: String(r.result).split(",")[1], mimeType: file.type }); drawThumbs(); };
  r.readAsDataURL(file);
}
/**
 * On a phone, tapping a button beside the box first blurs the box — which dismisses the soft
 * keyboard, which relayouts the page — and the tap then lands wherever that button used to be.
 * "send" appears dead. Taking the focus steal away makes the click land where you aimed it. This
 * is not visible in a desktop browser, which has no soft keyboard to dismiss.
 */
for (const b of document.querySelectorAll("form#composer button")) {
  b.addEventListener("pointerdown", (e) => e.preventDefault());
}

$("attach").onclick = () => $("file").click();
$("file").onchange = (e) => { for (const f of e.target.files) addFile(f); e.target.value = ""; };
$("input").addEventListener("paste", (e) => {
  // Every image type the clipboard offers, so addFile is the one place that decides which of them
  // can actually be sent — the picker and a paste then accept exactly the same set.
  const pics = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith("image/"));
  if (!pics.length) return;
  if (!takesImages) return void row("notice", "", (state.model?.id || "this model") + " does not take images; the paste was dropped");
  for (const item of pics) addFile(item.getAsFile());
});

$("composer").onsubmit = async (e) => {
  e.preventDefault();
  const input = $("input");
  let text = input.value.trim();
  if (!text && !images.length) return;
  input.value = ""; hidePop(); saveDraft(); autoGrow();
  if (text) { sentPrompts.push(text); if (sentPrompts.length > 200) sentPrompts.shift(); }
  promptIdx = -1;
  // Typed rather than clicked, which is how these get used once they are a habit. They run here
  // instead of being sent: anything attached stays in the tray, and a session about to be replaced
  // is not given a message it would carry nowhere.
  if (pageCommand(text)) return;
  // '/session export|import' are the archive commands here. pi's own '/session' is a terminal
  // command that does not exist over rpc, so the two-word spelling is free to mean the extension's.
  text = text.replace(/^\/session\s+(export|import)\b/i, (_m, sub) => "/session-" + sub.toLowerCase());
  const payload = { text, images };
  const shown = text + (images.length ? "\n[" + images.length + " image(s)]" : "");
  // Drawn at once only when it is next: with anything already queued it would be drawn above what runs
  // before it; pi's own echo draws it in place when its turn comes.
  if (!busy && !(state.requests || []).length) {
    row("user", "you", shown);
    drewLocally.push(shown);
    // A message pi never echoes back must not sit here waiting to swallow a later one.
    if (drewLocally.length > 20) drewLocally.shift();
  }
  images = []; drawThumbs();
  // A send that neither succeeds nor fails is a send the browser has queued behind its connection
  // pool — every other tab of this address holding a stream is the usual reason (#14). The fetch is
  // not given up on; the page says what is happening instead of looking alive.
  const slow = setTimeout(() => { statusEl.textContent = "still sending — if it never lands, close the other tabs of this address"; }, SEND_WATCHDOG_MS);
  let r;
  try {
    r = await api("/prompt", payload);
  } finally {
    clearTimeout(slow);
    if (statusEl.textContent.startsWith("still sending")) statusEl.textContent = busy ? "working…" : "ready";
  }
  if (!r.success) row("err", "error", r.error || JSON.stringify(r));
  // The session is open in a terminal, which holds it: that terminal answers (owner decision O2).
  else if (r.elsewhere) row("notice", "", "open in a terminal: answered there");
  // This page's own pi holds the session but shows an older copy of it: nothing may write into it
  // until pi reads it again (the server asks once pi is idle), and the message waits until then.
  else if (r.aside) row("notice", "", "this page shows an older copy of this conversation: your message is answered once it reads the new one");
  else if (r.queued) refresh();
};
$("stop").onclick = () => api("/abort", {});

/* ---------------- find, undo, save ---------------- */
$("find").onclick = () => {
  const bar = $("findbar");
  bar.hidden = !bar.hidden;
  if (!bar.hidden) $("findq").focus();
};
let findTimer;
$("findq").oninput = () => {
  clearTimeout(findTimer);
  findTimer = setTimeout(async () => {
    const q = $("findq").value.trim();
    if (q.length < 2) { $("findn").textContent = ""; return; }
    const r = await api("/find", { q });
    const hits = r.hits || [];
    $("findn").textContent = hits.length + " hit(s)";
    // Results go into the feed rather than a separate pane: it is where you were already reading.
    row("notice", "", "find: " + q);
    for (const h of hits.slice(0, 20)) row("hit", h.role + " · " + clock(h.when), "…" + h.excerpt + "…");
  }, 250);
};
$("undo").onclick = async () => {
  const r = await api("/undo", {});
  if (!r.success) return row("err", "error", r.error || "cannot undo");
  if (r.data?.cancelled) return row("notice", "", "undo was cancelled by an extension");
  // pi hands back the forked message; put it where it came from.
  $("input").value = r.data?.text ?? "";
  saveDraft();
  autoGrow();
  // The branch moved, so the conversation is taken again — through resync, which is the one path
  // that also resets what the page is counting against and drains what arrived meanwhile. This used
  // to be a second copy of it, and the copy was missing all three of those.
  // Only claim the message is back if it is. pi hands one back when there was one to hand back.
  await resync($("input").value ? "forked from your last message — it is back in the composer" : "forked from your last message");
};
$("save").onclick = async () => {
  const r = await api("/export", {});
  row("notice", "", r.success ? "saved " + r.data.path : "export failed: " + (r.error || ""));
};
// pi-loops' /share renders and redacts, then asks — the dialog arrives here like any other.
$("share").onclick = () => api("/share", {});

/* ---------------- keeping the context in hand ---------------- */

/**
 * Compact, and say what it did.
 *
 * "context compacted" on its own is the reason nobody trusted this button: compaction costs a model
 * call and throws most of the conversation away, and a line that reports neither is asking to be
 * taken on faith. pi hands back what it was and what it became, so that is what goes on the screen.
 */
function compactionLine(result, aborted, errorMessage, automatic) {
  if (aborted) return "compaction aborted";
  if (!result) return "compaction failed: " + (errorMessage || "no reason given");
  // Thousands where there are thousands. A summary that came out at 312 tokens was reported as
  // "0k", which reads as "gone" rather than "small" — and the numbers either side of that arrow are
  // the whole reason the line exists.
  const k = (n) => (n >= 1000 ? Math.round(n / 1000) + "k" : String(n));
  const before = result.tokensBefore, after = result.estimatedTokensAfter, cost = result.usage?.cost?.total;
  return (automatic ? "context compacted on its own" : "context compacted") +
    (before && after ? " · " + k(before) + " → " + k(after) : "") +
    (cost ? " · $" + cost.toFixed(3) : "");
}

async function compactNow(instructions) {
  const said = row("notice", "", instructions ? "compacting — " + instructions : "compacting…");
  const r = await api("/compact", instructions ? { instructions } : {});
  said.textContent = plain(compactionLine(r.success ? r.data : undefined, false, r.error, false));
  refresh();
}

/** Why the next reload is happening, when it is happening because somebody asked for it. */
let swapWhy = "";

/**
 * Start a new session, or go back to one.
 *
 * Nothing is deleted by either: the session being left is a file on disk that resume lists, which
 * is the difference between this and clearing a terminal.
 */
async function swap(call, body, why) {
  // Said before the request, not after it. The new session starts announcing itself the moment pi
  // swaps — and those events carry the new epoch, so the reload is often already under way by the
  // time this call returns. Setting the reason afterwards lost the race every time in a browser and
  // never once against a stand-in: what you got was "the session restarted", over an empty feed,
  // for a session you had just asked to start.
  swapWhy = why;
  const note = row("notice", "", "switching…");
  const r = await api(call, body);
  // Mid-turn the server refuses rather than asking, and its refusal says what to do about it. A
  // dialog here would be a second way to answer the same question, on the one screen where the
  // turn it is about is already visible.
  // A conversation already open in the page has one pi, in another tab or child: the refusal says
  // where, and going there is the switch that was asked for.
  if (!r.success && typeof r.url === "string" && r.url.startsWith("/c/")) { swapWhy = ""; note.textContent = "open in another tab: going to it…"; location.assign(r.url); return; }
  if (!r.success) { swapWhy = ""; note.textContent = plain(r.error || "could not switch session"); return; }
  if (r.data?.cancelled) { swapWhy = ""; note.textContent = "an extension stopped the switch"; return; }
  // The feed is not cleared here. The epoch changed under the page, and the reload that follows is
  // the same one a restarted server gets — one path, already tested, rather than two that drift.
  refresh();
}

/**
 * The commands the page runs itself. Returns true when the line was one of them.
 *
 * The server keeps the same list and refuses these on the prompt route, so a tab left open across
 * an upgrade is told to reload rather than having /clear delivered to the model as two words.
 */
function pageCommand(text) {
  const m = /^\/(\w[\w-]*)\s*([\s\S]*)$/.exec(text.trim());
  if (!m) return false;
  const name = m[1].toLowerCase();
  const rest = m[2].trim();
  if (name === "session" && /^(export|import)\b/i.test(rest)) return false; // an extension command, sent as one
  if (name !== "clear" && name !== "new" && name !== "resume" && name !== "compact" && name !== "sessions" && name !== "session") return false;
  row("user", "you", text.trim());
  if (name === "compact") compactNow(rest);
  else if (name === "resume") openSessions();
  else if (name === "sessions") listSessionsHere();
  else if (name === "session") row("system", "session", "usage: /session export [path] [--exclude-triggers] | /session import <path>\n/sessions lists this project's sessions; the header shows this one's model, cost and context.");
  else swap("/session/new", {}, "new session — the one you left is under resume");
  return true;
}

/* /sessions: one line per session, newest first — short id, when it started, what was first said. No backticks in here: this is inside the page template. */
async function listSessionsHere() {
  const r = await api("/sessions");
  const list = r.sessions || [];
  if (!list.length) return row("system", "sessions", "(no sessions for this project yet)");
  const lines = list.map((s) => {
    const when = String(s.startedAt || "").slice(0, 16);
    const said = plain(s.name || s.first || "").replace(/\s+/g, " ");
    const chars = [...said];
    return String(s.id).slice(0, 16) + "  " + when + (s.current ? "  [this one]" : "") + "  " + (chars.length > 80 ? chars.slice(0, 80).join("") + "…" : said);
  });
  row("system", "sessions", lines.join("\n"));
}

$("compact").onclick = () => compactNow("");
$("clear").onclick = () => swap("/session/new", {}, "new session — the one you left is under resume");

/** The sessions of this project, newest first — the conversation, not the filename. */
async function openSessions() {
  const body = $("sessBody");
  body.innerHTML = "";
  $("sessdlg").showModal();
  const r = await api("/sessions");
  const list = r.sessions || [];
  body.innerHTML = "";
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "notice";
    empty.textContent = "no other sessions saved for this project yet";
    body.append(empty);
    return;
  }
  for (const s of list) {
    const b = document.createElement("button");
    b.className = "sess";
    if (s.current) b.disabled = true;
    const title = document.createElement("b");
    // Everything drawn from a file or from pi goes through plain(), panel and feed alike. It matters
    // most here: this is the control that decides which conversation comes back, and a bidi override
    // in a name makes one of them read as another.
    title.textContent = plain(s.name || s.first || "") || "(nothing said yet)";
    const meta = document.createElement("span");
    const when = clock(s.mtimeMs);
    // The count is what was read, and only part of a long session is read: say "20+" rather than
    // a number that is quietly wrong.
    const msgs = s.messages + (s.truncated ? "+" : "") + " message(s)";
    meta.textContent = [when, msgs, s.current ? "this session" : ""].filter(Boolean).join(" · ");
    b.append(title, meta);
    if (!s.current) {
      b.onclick = () => {
        $("sessdlg").close();
        swap("/session/switch", { file: s.file }, "back in: " + (s.name || s.first || "an earlier session"));
      };
    }
    body.append(b);
  }
}
$("resume").onclick = openSessions;
$("sessClose").onclick = () => $("sessdlg").close();
// Outside a form, so nothing closes the dialog for it: an MCP list, a tool list or a run's transcript.
$("detailClose").onclick = () => $("detail").close();
$("model").onchange = async (e) => {
  // Remembered here and nowhere else, so the next time this browser opens the picker the ones you
  // reach for are at the top of it.
  const was = remembered("models", "").split(",").filter(Boolean);
  remember("models", [e.target.value, ...was.filter((m) => m !== e.target.value)].slice(0, 5).join(","));
  const r = await api("/model", { model: e.target.value });
  if (!r.success) row("err", "error", r.error || "model not available — check credentials");
  refresh();
};
$("thinking").onchange = (e) => api("/thinking", { level: e.target.value }).then(refresh);

/* ---------------- adding a device ---------------- */

/** The matrix as an SVG. One rect per dark module; a version 6 code is 41 across, which is fine. */
function qrSvg(q) {
  const quiet = 4;
  const span = q.size + quiet * 2;
  let rects = "";
  for (let r = 0; r < q.size; r++) {
    // One rect per run of dark modules rather than per module: fewer nodes, same picture.
    let run = 0;
    for (let c = 0; c <= q.size; c++) {
      if (c < q.size && q.m[r][c]) { run++; continue; }
      if (run) rects += '<rect x="' + (c - run + quiet) + '" y="' + (r + quiet) + '" width="' + run + '" height="1"/>';
      run = 0;
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + span + " " + span + '" shape-rendering="crispEdges" role="img" aria-label="Pairing code as a QR code">' +
    '<rect width="' + span + '" height="' + span + '" fill="#fff"/><g fill="#000">' + rects + "</g></svg>";
}

$("adddev").onclick = async () => {
  const r = await api("/pair", {});
  if (!r.success) { row("err", "error", r.error || "could not make a pairing code"); return; }
  $("pairCode").textContent = r.code;

  // The address this browser reached, first: under tailscale serve that is the tailnet name, and
  // it is the only one anybody had to configure. Then whatever else the machine can see — which is
  // a guess, so when there is more than one the choice is offered rather than made.
  const thisWindow = location.origin + "/";
  const loopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/)/.test(thisWindow);
  const candidates = (loopback ? [] : [{ url: thisWindow, via: "this window" }]).concat(r.addresses || []);

  const pick = $("pairPick");
  pick.innerHTML = "";
  for (const c of candidates) pick.append(new Option(c.url + " (" + c.via + ")", c.url));
  pick.hidden = candidates.length < 2;

  const draw = () => {
    const target = pick.value || candidates[0]?.url;
    const qr = target ? qrMatrix(target + "?pair=" + r.code) : undefined;
    $("pairQr").innerHTML = qr ? qrSvg(qr) : "";
    $("pairWhere").textContent = target
      ? "Scan it, or open " + target + " on that device and type the code. Good for " +
        Math.round((r.expiresIn || 600) / 60) + " minutes, once."
      : "This window is on " + thisWindow + ", which only this machine can reach. Run  tailscale serve --bg " +
        (location.port || 80) + "  and reload, or set [page] host = \"0.0.0.0\" in config.toml and run  pi-loops restart.";
  };
  pick.onchange = draw;
  draw();
  $("pairdlg").showModal();
};
/**
 * Closing the dialog retires the code. It is a live grant that a camera resolves in one frame, so
 * leaving it armed — and on screen behind whatever you do next — because nobody pressed anything
 * is the wrong default.
 */
function closePairing() {
  $("pairQr").innerHTML = "";
  $("pairCode").textContent = "";
  $("pairWhere").textContent = "";
  $("pairdlg").close();
  api("/pair", { cancel: true });
}
$("pairClose").onclick = closePairing;
$("pairdlg").addEventListener("close", () => { if ($("pairCode").textContent) closePairing(); });

/**
 * Clicking away from a dialog closes it. A native <dialog> does not do this on its own: the
 * backdrop is drawn by the browser and takes the click, so the click target is the dialog element
 * itself while the point is outside its box. That is the test.
 */
for (const dlg of document.querySelectorAll("dialog")) {
  dlg.addEventListener("click", (e) => {
    if (e.target !== dlg) return; // a click on something inside it
    const r = dlg.getBoundingClientRect();
    const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    if (outside) dlg.close();
  });
}

/* ---------------- the actions sheet ---------------- */
/**
 * The same buttons, moved rather than duplicated: a second copy means two of every id, two
 * handlers, and one of them going stale the next time somebody edits the other. On a wide screen
 * they live in the header; on a narrow one they are behind ⋯, and this carries them there and back.
 */
$("more").onclick = () => {
  $("menuBody").append($("actions"));
  $("menu").showModal();
};
function closeMenu() {
  document.querySelector("header .grow").insertBefore($("actions"), $("status"));
  $("menu").close();
}
$("menuClose").onclick = closeMenu;
$("menu").addEventListener("close", () => { if ($("menuBody").children.length) closeMenu(); });
/**
 * The sheet gets out of the way *before* the button does its job, not after. A modal dialog makes
 * the rest of the document inert, so an action that ends by focusing something — find, for one —
 * had its focus call ignored and then no keyboard came up. Capture phase, so this runs first.
 */
$("menuBody").addEventListener("click", (e) => { if (e.target.tagName === "BUTTON") closeMenu(); }, true);

/**
 * This page against the one the server would send now. They differ when something was installed
 * while this window was open — at which point everything still looks fine and none of the fixes in
 * the new version are running here, because they are not in this document.
 */
function checkAge(s) {
  if (!s?.version || s.version === PAGE_VERSION || PAGE_VERSION === "__" + "VERSION__") return;
  const bar = $("stale");
  bar.hidden = false;
  bar.textContent = "This window is running v" + PAGE_VERSION + "; v" + s.version + " is installed. Reload to use it.";
}
$("stale").onclick = () => location.reload();

/* ---------------- theme, and the side panel ---------------- */
/**
 * Both of these are a preference about this browser and nothing else — no server, no session, no
 * other device. localStorage is where that belongs, and it is allowed to fail: a private window,
 * a browser set to block site data, a thumbnailer. The page has to come up either way.
 */
function remembered(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch (_) {
    return fallback;
  }
}
function remember(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (_) {
    // Nothing to do and nothing worth saying: the preference simply does not outlive the tab.
  }
}

/**
 * What you have typed and not sent is the only copy of it, and this page reloads for its own
 * reasons: the header button, the banner that says the page is stale, a phone that discards a
 * backgrounded tab. None of them should cost a prompt. sessionStorage rather than localStorage,
 * because two tabs of this address are open at once by design and one tab's typing must not land in
 * the other's box. As with the theme, the store may refuse — that costs the draft, never the page.
 */
/** One draft per conversation: a row of the list loads another conversation in this same tab. */
const draftKey = () => "pi-web-draft:" + SESSION;
function savedDraft() {
  try {
    const own = sessionStorage.getItem(draftKey());
    if (own) return own;
    // A tab open across the upgrade kept its draft under the one key of before: it is this one's now.
    const old = sessionStorage.getItem("pi-web-draft");
    if (old === null) return "";
    sessionStorage.removeItem("pi-web-draft");
    sessionStorage.setItem(draftKey(), old);
    return old;
  } catch (_) {
    return "";
  }
}
/**
 * The text in the box, kept as it changes. Only the text: an attached image is one gesture to redo.
 * Recalling a sent prompt with the up-arrow deliberately does not come through here — it is a look at
 * something that already exists elsewhere, and storing it would drop the one copy of what does not.
 */
function saveDraft() {
  try {
    const text = $("input").value;
    if (text) sessionStorage.setItem(draftKey(), text);
    else sessionStorage.removeItem(draftKey());
  } catch (_) {
    // Nothing to do and nothing worth saying: the draft simply does not outlive a reload.
  }
}

/**
 * The box grows with what is in it, up to the ceiling the stylesheet already puts on it. The order
 * matters: scrollHeight is measured against the height the box has now, so it is set back to auto
 * first — assigned straight back, the box can only ever get taller, and a shorter prompt would sit in
 * a slot as tall as the last one. The cap stays in CSS (max-height:40vh) rather than being said
 * twice, so past it the box scrolls exactly as it did before.
 */
function autoGrow() {
  const el = $("input");
  el.style.height = "auto";
  // scrollHeight leaves out the border, and these boxes are border-box: without it added back, the
  // content overflows by exactly the border and a box that fits its text shows a scrollbar anyway.
  el.style.height = el.scrollHeight + (el.offsetHeight - el.clientHeight) + "px";
}

const THEMES = ["system", "light", "dark"];
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  $("theme").textContent = theme === "system" ? "◐" : theme === "light" ? "☀" : "☾";
  $("theme").title = "Theme: " + theme + " (click to change)";
}
let theme = remembered("theme", "system");
applyTheme(THEMES.includes(theme) ? theme : "system");
$("theme").onclick = () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  applyTheme(theme);
  remember("theme", theme);
};

const side = $("loops");
/**
 * One button, two jobs, because the panel means two different things depending on the width. On a
 * narrow screen it is a drawer that slides over the conversation; on a wide one it is a column that
 * can be given back to the conversation, and that choice is worth remembering.
 */
function applyPanel(hidden) {
  side.classList.toggle("hidden", hidden);
  $("drawer").setAttribute("aria-expanded", String(!hidden));
}
let panelHidden = remembered("panel", "shown") === "hidden";
applyPanel(panelHidden);
/** Open or shut, in one place, so the scrim can never disagree with the drawer. */
function setDrawer(open) {
  side.classList.toggle("open", open);
  $("scrim").hidden = !open;
  $("drawer").setAttribute("aria-expanded", String(open));
}
$("scrim").onclick = () => setDrawer(false);

// The one button that is always the right answer when something looks wrong.
$("reload").onclick = () => location.reload();
$("expand").onclick = () => setAllWork(!allOpen);

$("newer").onclick = () => {
  atBottom = true;
  feed.scrollTop = feed.scrollHeight;
  $("newer").hidden = true;
};

$("drawer").onclick = (e) => {
  e.stopPropagation();
  if (window.matchMedia && window.matchMedia("(max-width:1100px)").matches) {
    setDrawer(!side.classList.contains("open"));
    return;
  }
  panelHidden = !panelHidden;
  applyPanel(panelHidden);
  remember("panel", panelHidden ? "hidden" : "shown");
};
// Tapping the conversation puts the drawer away too, for the sliver of it the drawer leaves. A file
// link has no address until it is clicked: its key is good for one load.
feed.addEventListener("click", (e) => {
  setDrawer(false);
  const a = e && e.target && e.target.closest ? e.target.closest("a[data-file]") : null;
  if (!a) return;
  e.preventDefault();
  openFile(a.dataset.file).catch(() => {});
});

/* ---------------- completion ---------------- */
const pop = $("pop");
let completions = [], completionIdx = 0;
/**
 * Every keystroke asks for completions, and the answers do not necessarily come back in the order
 * they were asked for. Without this, typing "@src/we" quickly showed the whole of src/ — the reply
 * to "@src/" arriving after the reply to "@src/we" and overwriting it. Only the newest request is
 * allowed to draw.
 */
let popSeq = 0;
/**
 * Closing counts as newer, or an answer still in flight reopens what was just closed. Typing
 * "/compact keep the summary short" asks for completions on "/compact", closes the list on the
 * space, and then had the answer arrive and put it back — so Enter accepted "/compact" instead of
 * sending the line. Anything with an argument was reachable by mouse and not by typing.
 */
const hidePop = () => { popSeq++; pop.style.display = "none"; completions = []; };

async function updatePop() {
  const el = $("input");
  const upto = el.value.slice(0, el.selectionStart);
  const line = upto.split("\n").pop();
  const mine = ++popSeq;
  const r = await api("/complete", { text: line });
  if (mine !== popSeq) return; // something newer is already on its way
  completions = r.items || [];
  if (!completions.length) return hidePop();
  completionIdx = 0;
  renderCompletions();
  pop.style.display = "block";
}
function renderCompletions() {
  pop.innerHTML = "";
  completions.forEach((it, i) => {
    const d = document.createElement("div");
    if (i === completionIdx) d.className = "sel";
    d.innerHTML = "<span>" + esc(it.value) + '</span><span class="h">' + esc(it.hint) + "</span>";
    d.onclick = () => accept(i);
    pop.append(d);
  });
}
/** What a candidate would replace: the token the caret is sitting at the end of. */
function completionToken(it) {
  const el = $("input");
  const upto = el.value.slice(0, el.selectionStart);
  const nl = upto.lastIndexOf("\n") + 1;
  const from = it.replaceFrom !== undefined ? nl + it.replaceFrom : nl;
  return el.value.slice(from, el.selectionStart);
}
function accept(i) {
  const it = completions[i];
  const el = $("input");
  const upto = el.value.slice(0, el.selectionStart);
  const nl = upto.lastIndexOf("\n") + 1;
  const from = it.replaceFrom !== undefined ? nl + it.replaceFrom : nl;
  el.value = el.value.slice(0, from) + it.value + (it.value.endsWith("/") ? "" : " ") + el.value.slice(el.selectionStart);
  el.focus();
  hidePop();
  saveDraft();
  autoGrow();
}
/** What has been sent from this composer, for the up-arrow. Not window.history, which it shadowed. */
const sentPrompts = [];
let promptIdx = -1;
let promptDraft = "";

/**
 * Whether an input method is mid-word. Typing Chinese, Japanese or Korean means Enter picks a
 * candidate from the IME's own list — it is not a request to send anything, and treating it as one
 * sends half a sentence and clears what you were writing. The isComposing flag is the answer where
 * it is set; keyCode 229 says the same thing on browsers that only report it that way, and the last
 * milliseconds after composition ends cover the browsers that fire compositionend first and hand
 * the very same Enter to keydown afterwards.
 */
let composing = false;
let composedAt = 0;
$("input").addEventListener("compositionstart", () => { composing = true; });
$("input").addEventListener("compositionend", () => { composing = false; composedAt = Date.now(); });
const midWord = (e) => composing || e.isComposing || e.keyCode === 229 || Date.now() - composedAt < 50;

$("input").onkeydown = (e) => {
  if (midWord(e)) return;
  // Prompt history, but only while the caret is on the first/last line, so arrows still navigate
  // a multi-line draft.
  if (!completions.length && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    const el = $("input");
    const before = el.value.slice(0, el.selectionStart);
    const after = el.value.slice(el.selectionStart);
    const atTop = !before.includes("\n");
    const atEnd = !after.includes("\n");
    if (e.key === "ArrowUp" && atTop && sentPrompts.length) {
      if (promptIdx === -1) promptDraft = el.value;
      promptIdx = Math.min(promptIdx + 1, sentPrompts.length - 1);
      el.value = sentPrompts[sentPrompts.length - 1 - promptIdx];
      autoGrow();
      e.preventDefault();
      return;
    }
    if (e.key === "ArrowDown" && atEnd && promptIdx >= 0) {
      promptIdx -= 1;
      el.value = promptIdx === -1 ? promptDraft : sentPrompts[sentPrompts.length - 1 - promptIdx];
      autoGrow();
      e.preventDefault();
      return;
    }
  }
  if (completions.length) {
    if (e.key === "ArrowDown") { e.preventDefault(); completionIdx = (completionIdx + 1) % completions.length; renderCompletions(); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); completionIdx = (completionIdx - 1 + completions.length) % completions.length; renderCompletions(); return; }
    if (e.key === "Tab") { e.preventDefault(); accept(completionIdx); return; }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // A command you have typed out in full needs no completing, and Enter on it means run it —
      // which is what it means in a terminal. "/inbox" then Enter used to accept the completion it
      // was already equal to and add a space, so every argumentless command took two Enters. Only
      // when there is nothing left to add: a shorter prefix still gets the candidate, as before.
      const it = completions[completionIdx];
      if (it && completionToken(it) === it.value) { hidePop(); $("composer").requestSubmit(); return; }
      accept(completionIdx);
      return;
    }
    if (e.key === "Escape") { hidePop(); return; }
  }
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("composer").requestSubmit(); }
};
$("input").oninput = () => {
  const el = $("input");
  saveDraft();
  autoGrow();
  const line = el.value.slice(0, el.selectionStart).split("\n").pop();
  if (/(^\/[\w-]*$)|(@[^\s]*$)/.test(line)) updatePop(); else hidePop();
};

/* ---------------- staying in step with the server ---------------- */
/**
 * Where the event stream had got to when this page last agreed with the server, and which run of the
 * server those numbers belong to.
 *
 * The feed is built by appending, which is what keeps a selection alive and a tool panel open — but
 * it also means an event that never arrives is simply missing, and the page goes quietly out of date
 * until someone reloads it. The numbers make that detectable: a jump means the stream dropped
 * something (a reconnect, a slow tab the browser suspended), and the answer is to take the transcript
 * again rather than carry on with a hole in it.
 */
let seen = 0;
let epoch;
/**
 * Taking the transcript again takes a moment, and events keep arriving while it happens. They used to
 * be drawn onto a feed that the resync was about to empty — so a message sent at exactly the wrong
 * moment went in and then vanished. They wait in the holding list instead, and are applied against
 * the numbering the new transcript establishes.
 */
let resyncing = false;
let behind = 0;
const waiting = [];

/** What to call this reload: what was asked for, if anything was, and once. */
function reloadReason() {
  const why = swapWhy || "the session restarted — the conversation above was reloaded";
  swapWhy = "";
  return why;
}

/**
 * Start the conversation again from the server's copy of it, and say why.
 *
 * Everything that throws the feed away goes through here — a gap in the numbering, a server that was
 * replaced, a session swapped, an undo that moved the branch. Undo used to do its own version of it
 * and the two drifted: that one left the sequence number and the epoch
 * pointing at a transcript it had just replaced, and dropped whatever was waiting to be applied.
 */
async function resync(why) {
  resyncing = true;
  feed.innerHTML = "";
  drawnViews.clear();
  toolGroup = undefined;
  openCalls.length = 0;
  blocks = new Map();
  // A dialog is offered again if the server still has it unanswered, and it does say so in /state.
  asked.clear();
  for (const rec of watchAsks.values()) rec.feed = undefined;
  const again = await api("/history");
  for (const m of again.messages || []) renderMessage(m, false);
  seen = again.seq ?? seen;
  epoch = again.epoch ?? epoch;
  // Said after the clearing, or it would be the first thing the clearing removes.
  row("notice", "", why);
  feed.scrollTop = feed.scrollHeight;
  resyncing = false;
  behind = 0;
  // Whatever happened while we were reading: anything the transcript already covers is dropped by
  // the same rule as always.
  const held = waiting.splice(0, waiting.length);
  for (const ev of held) applyEvent(ev);
  refresh();
}

/**
 * One event, against the numbering this page is counting on: already covered by the transcript, the
 * next one in sequence, or evidence that something in between never arrived.
 */
function applyEvent(ev) {
  // While a reload runs, every event waits for it, a replayed one too: a reload started by the replay
  // clears the feed, and the replay must not go on drawing into what it cleared (the history it reads
  // has those events already). Applied once the transcript is back.
  if (resyncing) return void waiting.push(ev);
  if (ev.type === "page_moved" && ev.sessionId) {
    // pi is in another conversation now (a new session, a resume): its routes and its address move.
    SESSION = ev.sessionId;
    history.replaceState(null, "", "/c/" + SESSION + "/");
    // And the list marks it at the next poll, not fifteen seconds later.
    listAt = 0;
  }
  if (!ev.seq) return handle(ev); // not numbered: nothing to reason about
  if (epoch && ev.epoch && ev.epoch !== epoch) {
    // A different run of the server: its numbers mean nothing next to the ones we were counting.
    epoch = ev.epoch;
    seen = ev.seq;
    void resync(reloadReason()).catch(() => {});
    return;
  }
  if (ev.seq <= seen) return; // already in the transcript we replayed
  if (ev.seq > seen + 1 && seen > 0) {
    // Something in between never arrived. Do not draw this one on top of the gap.
    seen = ev.seq;
    void resync("reconnected — the conversation above was reloaded").catch(() => {});
    return;
  }
  seen = ev.seq;
  handle(ev);
}

/* ---------------- the frame: the conversation list, the held line, the status bar, the panes ---------------- */
/**
 * This project's conversations, read by the server from pi's own files (GET /conversations): who
 * holds each, what needs you, what is queued. Showing them starts no pi. A row is a link, and picking
 * one loads that conversation's own page: that keeps one conversation per load true for everything
 * above it (the stream, the numbering, the draft), at the price of a load per switch.
 */
const LIST_EVERY_MS = 15000;
/** The last answer, when the list was last asked for, and a project chosen in the switcher (else the open conversation's). */
let listAnswer, listAt = 0, listCwd;
let segment = remembered("pi-loops-segment", "all");
/**
 * The rows on the screen, in order. Kept here rather than asked of the DOM, so the keys that move
 * through them and the filters that pick them never depend on a selector query.
 */
const convRows = [];
let focusAt = 0;
const HELD_LINE = "Your terminal has this conversation. What you send here is answered there.";
const BESIDE_LINE = "A terminal has this conversation open, and this page's pi has no pi-loops: what you send here is answered here, beside the terminal.";
const PLACEHOLDER = $("input").placeholder || "Message pi — / for commands, @ for files, Enter sends";
const phone = () => !!(window.matchMedia && window.matchMedia("(max-width:760px)").matches);
const spanOf = (cls, text) => {
  const el = document.createElement("span");
  el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
};

/**
 * Unread is this browser's own mark, "pi-loops-read:<id>": nothing on the server records that a
 * person has read a conversation; the away card's cursor is per project, not per conversation.
 * The first load on a device counts everything before it as read; a conversation a terminal holds
 * is never unread, because the person is at that terminal; storage that refuses leaves nothing unread.
 */
const READ_SINCE_KEY = "pi-loops-read-since";
const readSince = (() => {
  try {
    const at = Number(localStorage.getItem(READ_SINCE_KEY));
    if (at > 0) return at;
    localStorage.setItem(READ_SINCE_KEY, String(Date.now()));
    return Date.now();
  } catch (_) {
    return Infinity;
  }
})();
function readMark(id) {
  try {
    return Number(localStorage.getItem("pi-loops-read:" + id)) || 0;
  } catch (_) {
    return Infinity;
  }
}
function isUnread(r) {
  if (r.holder === "terminal" || r.sessionId === SESSION) return false;
  const at = Date.parse(r.lastActivityAt);
  return Number.isFinite(at) && at > Math.max(readSince, readMark(r.sessionId));
}
/**
 * The conversation on the screen is read as of now: on every poll and, at most every two seconds,
 * on what streams in. A mark from the list's last draw lagged it by up to fifteen seconds, and an
 * answer that landed in between made the conversation just watched come back Unread.
 */
let markedAt = 0;
function markOpenRead() {
  if (document.visibilityState !== "visible") return;
  markedAt = Date.now();
  try {
    localStorage.setItem("pi-loops-read:" + SESSION, String(markedAt));
  } catch (_) {
    // Nothing to do: without storage nothing is unread either.
  }
}

/** When, in the fewest characters that cannot be misread: now, 3m, 2h, else the day. */
function ago(iso) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const s = Math.max(0, (Date.now() - at) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return clock(iso).replace(/ \d\d:\d\d$/, "");
}

/** Who has it, in a word: a terminal, the page (open), pi-loops in the background, or no tag at all. */
const HOLDER_TAGS = { terminal: ["terminal", "A terminal has this conversation open and answers what is sent to it"], page: ["open", "Open in the page"], background: ["pi-loops", "pi-loops is working in it in the background"] };
function holderTag(r) {
  const known = HOLDER_TAGS[r.holder];
  let text = known ? known[0] : "";
  if (r.open && r.holder !== "page") text = text ? text + " · open here" : "open here";
  if (!text) return undefined;
  const tag = spanOf("who", text);
  // A one-shot run, or a window whose copy is behind the file, holds it and answers nothing.
  tag.title = r.holder === "terminal" && r.delivers === false ? "A terminal has this conversation open but answers nothing sent to it (a one-shot run, or a window behind the file)" : known ? known[1] : "Open in the page";
  return tag;
}

const rowHref = (id) => "/c/" + encodeURIComponent(id) + "/" + (phone() ? "#chat" : "");

function convRow(r) {
  const a = document.createElement("a");
  const id = str(r.sessionId);
  const current = id === SESSION;
  a.className = "conv" + (current ? " on" : "");
  a.href = rowHref(id);
  a.dataset.conv = id;
  if (current) a.setAttribute("aria-current", "page");
  const top = spanOf("ct");
  if (isUnread(r)) {
    const dot = spanOf("u");
    dot.title = "new since this browser last looked";
    top.append(dot);
  }
  // What people typed: plain() takes out what textContent does not stop (a bidi override reorders
  // the line drawn around it).
  const title = plain(str(r.title)).trim();
  top.append(Object.assign(document.createElement("b"), { textContent: title || id.slice(-8) }));
  const tag = holderTag(r);
  if (tag) top.append(tag);
  const when = spanOf("when", ago(r.lastActivityAt));
  when.title = clock(r.lastActivityAt);
  top.append(when);
  a.append(top);
  const meta = spanOf("cm");
  if (num(r.needsYou)) {
    const need = spanOf("need", "⚑ " + num(r.needsYou));
    need.title = "decisions waiting on you";
    meta.append(need);
  }
  if (num(r.queued)) meta.append(spanOf("", "queued " + num(r.queued)));
  if (meta.children.length) a.append(meta);
  return a;
}

const SEGMENTS = [["all", "segAll", "nAll"], ["needs", "segNeeds", "nNeeds"], ["unread", "segUnread", "nUnread"]];
const inSegment = (r, k) => (k === "needs" ? num(r.needsYou) > 0 : k === "unread" ? isUnread(r) : true);

function drawProjects(projects, current) {
  const picker = $("project");
  const key = projects.map((p) => str(p.cwd)).join("\n") + "|" + str(current);
  if (picker.dataset.n === key) return; // unchanged; do not disturb a menu somebody has open
  picker.dataset.n = key;
  picker.innerHTML = "";
  for (const p of projects) {
    const o = new Option(plain(str(p.label || p.cwd)), str(p.cwd));
    o.title = plain(str(p.cwd));
    picker.append(o);
  }
  picker.value = str(current);
  picker.title = plain(str(current));
}

function drawList() {
  const a = listAnswer;
  if (!a) return;
  drawProjects(Array.isArray(a.projects) ? a.projects : [], a.cwd);
  const rows = a.rows.filter((r) => r && typeof r === "object");
  for (const [k, id, n] of SEGMENTS) {
    const b = $(id);
    b.className = segment === k ? "on" : "";
    b.setAttribute("aria-selected", String(segment === k));
    b.tabIndex = segment === k ? 0 : -1;
    const count = rows.filter((r) => inSegment(r, k)).length;
    $(n).textContent = count ? String(count) : "";
    $(n).className = "pill" + (k === "needs" && count ? " hot" : "");
  }
  const box = $("convs");
  const scroller = $("lscroll");
  const top = scroller.scrollTop;
  const focused = convRows.includes(document.activeElement) ? document.activeElement.dataset.conv : undefined;
  box.innerHTML = "";
  convRows.length = 0;
  const today = new Date().toDateString();
  let group;
  for (const r of rows.filter((r) => inSegment(r, segment))) {
    const g = new Date(r.lastActivityAt).toDateString() === today ? "Today" : "Earlier";
    if (g !== group) {
      group = g;
      box.append(Object.assign(document.createElement("div"), { className: "grp", textContent: g }));
    }
    const el = convRow(r);
    box.append(el);
    convRows.push(el);
  }
  if (!convRows.length) box.append(Object.assign(document.createElement("div"), { className: "lnote", textContent: segment === "needs" ? "Nothing needs you. Loops keep running." : segment === "unread" ? "Nothing unread." : "No conversations in this project yet." }));
  if (num(a.more)) box.append(Object.assign(document.createElement("div"), { className: "lnote", textContent: "+ " + num(a.more) + " older" }));
  // One row is in the Tab order, the open one or else the first; the arrow keys move between them.
  const at = convRows.findIndex((el) => el.dataset.conv === (focused ?? SESSION));
  focusAt = at >= 0 ? at : 0;
  convRows.forEach((el, i) => (el.tabIndex = i === focusAt ? 0 : -1));
  if (focused && at >= 0) convRows[at].focus();
  scroller.scrollTop = top;
  // Opened from far down the list: the first draw shows where the open one is. Later draws keep
  // whatever scroll you chose.
  if (!shownOpen && !focused && at >= 0 && convRows[at].dataset.conv === SESSION) {
    shownOpen = true;
    // Unless the away card was put in view first: it is what you came back to read (drawAway).
    if (convRows[at].scrollIntoView && !awayScrolled) convRows[at].scrollIntoView({ block: "nearest" });
  }
  const mine = rows.find((r) => r.sessionId === SESSION);
  if (mine && mine.title) openTitle = mine.title;
  const held = rows.filter((r) => r.holder === "terminal").length;
  $("sbHeld").textContent = held ? held + " conversation" + (held === 1 ? "" : "s") + " open in a terminal" : "";
  drawTitle();
}

function drawListError(why) {
  const box = $("convs");
  box.innerHTML = "";
  convRows.length = 0;
  box.append(Object.assign(document.createElement("div"), { className: "lnote", textContent: "The conversation list is not available" + (why ? ": " + plain(str(why)) : "") + ". This conversation still works." }));
}

/** The list, asked of the server. Not this conversation's route: it is the same for every page. */
async function refreshList() {
  listAt = Date.now();
  if (!TOKEN) await tokenReady;
  refreshInbox().catch(() => {});
  const q = "?session=" + encodeURIComponent(SESSION) + (listCwd !== undefined ? "&cwd=" + encodeURIComponent(listCwd) : "");
  let body;
  try {
    body = await fetch("/conversations" + q, { headers: { "x-pi-web-token": TOKEN } }).then((r) => r.json());
  } catch (e) {
    return drawListError(String(e && e.message ? e.message : e));
  }
  if (!body || !Array.isArray(body.rows)) return drawListError(body && body.error);
  listAnswer = body;
  drawList();
}

/* ---------------- the inbox as cards, above the conversations (GET /inbox, docs/loops.md) ---------------- */
/**
 * This project's new findings, decisions first, from the server's one parser (src/inbox-card.ts).
 * Every button sends the finding's whole id and nothing that becomes a prompt: Yes and Look into it
 * claim it into the conversation that created its loop; No and Dismiss take a reason that goes to the
 * loop's next run. All text goes in with textContent.
 */
let inboxAnswer;
/** Cards acted on here, with the line the server answered: kept on screen until the next answers leave them out. */
const inboxDone = new Map();
/** Findings whose claim row was cancelled from this page's queue (drawQueue's ✕). */
const cancelledClaims = new Set();
let newsOpen = false;
const NEWS_SHOWN = 5;
/**
 * The reason boxes opened on cards, by finding id: whether open, what is typed, the selection and
 * whether it had focus. Kept here and not in the DOM, so the list's redraw (every 15 s, and after any
 * action) loses none of it, and closing a box keeps its text for when it is opened again. A
 * successful dismiss forgets it; so does the finding leaving the answer.
 */
const openForms = new Map();
/** The field each form is drawn in now, read back before the next redraw. */
const formFields = new Map();
const formOf = (id) => {
  if (!openForms.has(id)) openForms.set(id, { open: false, text: "", selStart: null, selEnd: null, focused: false });
  return openForms.get(id);
};
function keepForms() {
  const active = document.activeElement;
  for (const [id, field] of formFields) {
    const f = openForms.get(id);
    if (!f) continue;
    f.text = str(field.value);
    f.selStart = field.selectionStart;
    f.selEnd = field.selectionEnd;
    f.focused = active === field;
  }
  formFields.clear();
}
/** After a redraw, on the screen: the focus and the selection go back where they were. */
function restoreForms() {
  for (const [id, field] of formFields) {
    const f = openForms.get(id);
    if (!f || !f.open || !f.focused) continue;
    field.focus();
    if (typeof f.selStart === "number" && typeof f.selEnd === "number") {
      if (typeof field.setSelectionRange === "function") field.setSelectionRange(f.selStart, f.selEnd);
      else {
        field.selectionStart = f.selStart;
        field.selectionEnd = f.selEnd;
      }
    }
  }
}
const OWNER_HINTS = { page: (t) => "runs in " + (t ? "“" + t + "”" : "its conversation"), terminal: () => "runs in your terminal", "terminal-quiet": () => "its terminal is not taking messages", background: () => "runs after pi-loops finishes its scheduled run there", none: () => "starts its conversation", gone: () => "its conversation is gone; Yes runs it in this one", project: () => "runs in the conversation you claim it from" };

async function refreshInbox() {
  if (!TOKEN) await tokenReady;
  const q = "?session=" + encodeURIComponent(SESSION) + (listCwd !== undefined ? "&cwd=" + encodeURIComponent(listCwd) : "");
  let body;
  try {
    body = await fetch("/inbox" + q, { headers: { "x-pi-web-token": TOKEN } }).then((r) => r.json());
  } catch (e) {
    return; // the list says the server is not answering; the last cards stay
  }
  if (!body || !Array.isArray(body.cards)) return;
  inboxAnswer = body;
  const listed = new Set([...body.cards, ...(Array.isArray(body.handled) ? body.handled : [])].map((c) => c && c.id));
  for (const [id, d] of inboxDone) if (!listed.has(id) && Date.now() - d.at > 60000) inboxDone.delete(id);
  drawInbox();
  drawAway();
  drawStarters();
  // The panel's inbox count is these cards' (renderSidebar).
  if (state && state.automation) renderSidebar(state);
}

const inboxPost = (route, b) =>
  fetch(route, { method: "POST", headers: { "x-pi-web-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify(b) })
    .then(async (r) => ({ status: r.status, body: await r.json() }))
    .catch((e) => ({ status: 0, body: { error: String(e && e.message ? e.message : e) } }));

function textEl(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  el.textContent = plain(str(text));
  return el;
}

function inboxButton(label, act, primary) {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.act = act;
  if (primary) b.className = "primary";
  b.textContent = label;
  return b;
}

/** What filed a card: a rule's condition (src/inbox-card.ts), or the loop's label. */
function originLabel(c) {
  if (c.rule) return "rule " + (c.rule.condition ? plain(str(c.rule.condition)) : str(c.rule.id).slice(0, 12));
  return (c.loop && (c.loop.label || c.loop.name)) || str(c.source).replace(/^cron:/, "");
}
/** Whether the listed cards come from more than one loop or rule: only then does a card say which. */
function manyOrigins() {
  const cards = inboxAnswer && Array.isArray(inboxAnswer.cards) ? inboxAnswer.cards : [];
  return new Set(cards.map((c) => (c && c.rule && c.rule.id) || (c && c.loop && c.loop.id) || str(c && c.source))).size > 1;
}

/** One card. "done" is the line an action here was answered with. */
function inboxCardEl(c, done) {
  const card = document.createElement("article");
  const decision = c.kind === "decision";
  card.className = "icard" + (decision ? " decision" : " news");
  card.dataset.inb = str(c.id);
  const head = document.createElement("div");
  head.className = "ih";
  if (decision) head.append(textEl("span", "flag", "⚑"));
  head.append(textEl("b", "", c.headline));
  if (c.verified) {
    const v = textEl("span", "vf", "✓");
    v.title = "kept by the checker" + (c.verifiedReason ? ": " + plain(str(c.verifiedReason)) : "");
    head.append(v);
  }
  const when = textEl("span", "when", ago(c.createdAt));
  when.title = clock(c.createdAt);
  head.append(when);
  card.append(head);
  if (decision) {
    const dl = document.createElement("dl");
    for (const [label, value] of [["Waiting on", c.waits], ["If you don't", c.ifNot]]) {
      if (!value) continue;
      dl.append(textEl("dt", "", label));
      dl.append(textEl("dd", "", value));
    }
    if (dl.children.length) card.append(dl);
  } else if (c.body) card.append(textEl("p", "ib", c.body));
  const owner = c.owner || {};
  // Gone or the project's, in another project than the open conversation's: not run here, but in a new conversation there.
  const away = startsElsewhere(c);
  // Where a claim runs, said only when that is not the conversation on screen.
  const elsewhere = away || owner.holder === "terminal-quiet" || (!c.fromThisConversation && owner.holder !== "project");
  const hint = !elsewhere ? undefined : away ? () => (owner.holder === "gone" ? "its conversation is gone; Yes runs it" : "runs") + " in a new conversation in " + projectName(inboxAnswer.cwd) : OWNER_HINTS[owner.holder];
  const meta = [manyOrigins() ? originLabel(c) : "", hint ? hint(plain(str(owner.title))) : ""].filter(Boolean).join(" · ");
  if (meta) card.append(textEl("div", "im", meta));
  const stat = textEl("div", "cstat", done || c.line || "");
  stat.setAttribute("role", "status");
  const parts = { stat, buttons: [], why: undefined, field: undefined };
  if (!done && c.status === "new") {
    const acts = document.createElement("div");
    acts.className = "acts";
    if (!c.claiming) acts.append(inboxButton(decision ? ((owner.holder === "gone" || owner.holder === "project") && !away ? "Yes, do it here" : "Yes, do it") : "Look into it", "claim", decision));
    acts.append(inboxButton(decision ? "No…" : "Dismiss…", "no"));
    if (c.hasTranscript) acts.append(inboxButton("See the run", "run"));
    card.append(acts);
    const why = document.createElement("div");
    why.className = "why";
    why.hidden = true;
    for (const chip of Array.isArray(inboxAnswer && inboxAnswer.chips) ? inboxAnswer.chips : []) {
      const b = inboxButton(plain(str(chip)), "reason");
      b.dataset.reason = str(chip);
      why.append(b);
    }
    const field = document.createElement("input");
    field.maxLength = 500;
    field.placeholder = "Or say why (the loop's next run reads it)";
    field.setAttribute("aria-label", "Why, in your words");
    why.append(field, inboxButton("Send", "typed"), inboxButton("Dismiss without a reason", "bare"), inboxButton("Cancel", "cancel"));
    card.append(why);
    const kept = openForms.get(c.id);
    if (kept) {
      why.hidden = !kept.open;
      field.value = kept.text;
    }
    formFields.set(c.id, field);
    field.addEventListener("input", () => void (formOf(c.id).text = str(field.value)));
    parts.why = why;
    parts.field = field;
    // Every control of the card, the field too: nothing is sent twice while a post is out.
    parts.buttons = [...acts.children, ...why.children];
    card.addEventListener("click", (e) => onCardClick(c, e && e.target, parts));
  }
  card.append(stat);
  return card;
}

/** A click anywhere on a card: which button, read off its data-act; the finding is the card's, never a position. */
function onCardClick(c, b, parts) {
  if (!b || !b.dataset || b.disabled) return;
  const act = b.dataset.act;
  if (act === "run") return void showRun(c.id).catch(() => {});
  if (act === "no") {
    parts.why.hidden = !parts.why.hidden;
    formOf(c.id).open = !parts.why.hidden;
    return;
  }
  if (act === "cancel") {
    parts.why.hidden = true;
    formOf(c.id).open = false;
    return;
  }
  if (act === "claim") return void inboxAct(c, parts, "claim").catch(() => {});
  if (act === "reason") return void inboxAct(c, parts, "dismiss", b.dataset.reason).catch(() => {});
  if (act === "bare") return void inboxAct(c, parts, "dismiss").catch(() => {});
  if (act === "typed") {
    const text = str(parts.field.value).trim();
    if (text) return void inboxAct(c, parts, "dismiss", text).catch(() => {});
  }
}

function drawInbox() {
  const slot = $("cardsSlot");
  const a = inboxAnswer;
  keepForms();
  slot.innerHTML = "";
  if (!a) return;
  const cards = a.cards.filter((c) => c && typeof c === "object" && typeof c.id === "string");
  const listed = new Set([...cards, ...(Array.isArray(a.handled) ? a.handled : [])].map((c) => c && c.id));
  for (const id of openForms.keys()) if (!listed.has(id)) openForms.delete(id);
  const decisions = cards.filter((c) => c.kind === "decision");
  const news = cards.filter((c) => c.kind !== "decision");
  const shown = new Set();
  const group = (label) => {
    const g = textEl("div", "grp", label);
    slot.append(g);
    return g;
  };
  const add = (c) => {
    shown.add(c.id);
    const d = inboxDone.get(c.id);
    slot.append(inboxCardEl(c, d && d.line));
  };
  if (decisions.length) group("Needs you");
  decisions.forEach(add);
  if (news.length) group("News");
  (newsOpen ? news : news.slice(0, NEWS_SHOWN)).forEach(add);
  if (!newsOpen && news.length > NEWS_SHOWN) {
    const more = inboxButton("Show " + (news.length - NEWS_SHOWN) + " more", "more");
    more.onclick = () => {
      newsOpen = true;
      drawInbox();
    };
    slot.append(more);
  }
  if (num(a.more)) slot.append(textEl("div", "lnote", "+ " + num(a.more) + " more · /inbox lists them all"));
  const handled = (Array.isArray(a.handled) ? a.handled : []).filter((c) => c && typeof c.id === "string" && !shown.has(c.id));
  const doneHere = [...inboxDone.entries()].filter(([id]) => !shown.has(id) && !handled.some((c) => c.id === id));
  if (handled.length || doneHere.length) group("Handled");
  // A claim made here follows the server: while its row waits, the line of where it waits; once the
  // row is gone, its turn ran. Other lines (a dismiss, handled elsewhere) stay as they were said.
  for (const c of handled) {
    shown.add(c.id);
    const d = inboxDone.get(c.id);
    slot.append(inboxCardEl(c, d && !d.claim ? d.line : c.line || (d && d.line)));
  }
  // The row goes once its message is in the conversation, not when the turn ends.
  // A row cancelled from this page's queue ran nothing, and its finding stays claimed.
  for (const [id, d] of doneHere) slot.append(inboxCardEl(d.card, d.claim ? (cancelledClaims.has(id) ? "Cancelled; nothing was sent. The finding stays claimed." : "Handed to that conversation.") : d.line));
  if (num(a.elsewhere)) slot.append(textEl("div", "lnote", num(a.elsewhere) + " new in other projects · /inbox --all"));
  restoreForms();
}

/** A run's transcript, read-only: the lines the server folded and redacted, as text. */
async function showRun(id) {
  if (!TOKEN) await tokenReady;
  let b;
  try {
    b = await fetch("/inbox/run?id=" + encodeURIComponent(id), { headers: { "x-pi-web-token": TOKEN } }).then((r) => r.json());
  } catch (e) {
    b = { error: String(e && e.message ? e.message : e) };
  }
  $("detailTitle").textContent = "The run that filed it";
  const box = $("detailBody");
  box.innerHTML = "";
  const lines = b && Array.isArray(b.lines) ? b.lines : [];
  if (!lines.length) box.append(textEl("div", "detail-row", (b && b.error) || "This run left no lines."));
  for (const l of lines) box.append(textEl("div", "detail-row", (l && l.kind ? l.kind + ": " : "") + str(l && l.text)));
  $("detail").showModal();
}

/** A card whose conversation is gone, or the project's own, listed for a project other than the open conversation's. */
function startsElsewhere(c) {
  return !!c && !!c.owner && (c.owner.holder === "gone" || c.owner.holder === "project") && !!inboxAnswer && typeof inboxAnswer.cwd === "string" && otherProject(inboxAnswer.cwd);
}

async function inboxAct(c, parts, act, reason) {
  const id = c.id;
  for (const b of parts.buttons) b.disabled = true;
  // Yes on another project's card whose conversation is gone, or the project's own: a new conversation there first, claimed into.
  const opened = act === "claim" && startsElsewhere(c) ? await startConversationIn(inboxAnswer.cwd) : undefined;
  if (opened && !opened.url) {
    for (const b of parts.buttons) b.disabled = false;
    parts.stat.textContent = "Not sent: " + opened.error + ". Try again.";
    return;
  }
  const r = act === "claim" ? await inboxPost("/inbox/claim", { id, from: opened ? opened.id : SESSION }) : await inboxPost("/inbox/dismiss", reason ? { id, reason } : { id });
  if (opened && r.status === 200) return void location.assign(opened.url);
  const settled = r.status === 200 ? plain(str(r.body.line)) : r.status === 409 && (r.body.status === "claimed" || r.body.status === "dismissed") ? (r.body.status === "claimed" ? "Already claimed." : "Already dismissed.") : undefined;
  if (settled !== undefined) {
    inboxDone.set(id, { line: settled, at: Date.now(), card: c, claim: act === "claim" && r.status === 200 });
    openForms.delete(id);
    drawInbox();
    // The cards, the list's counts (Needs you, a conversation's flag) and the panel's inbox count, on
    // one refresh: the card moving and its counts dropping are the same event.
    refreshList().catch(() => {});
    refresh().catch(() => {});
    return;
  }
  for (const b of parts.buttons) b.disabled = false;
  parts.stat.textContent = "Not sent: " + plain(str(r.body && r.body.error)) + ". Try again.";
}

/* ---------------- the away card: what happened in this project while nobody looked (GET /inbox's away, docs/loops.md) ---------------- */
/* clock: */
/**
 * When sinceMs was, said from nowMs in this browser's time zone: "09:14", "yesterday 23:10",
 * "Mon 23:10", "Oct 28 23:10", "Oct 28 2025 23:10". nowMs is the server's clock (the answer's
 * asOf), so a phone whose own clock is wrong still says "yesterday" right. A copy of src/seen.ts
 * sinceWords; test/web-page.test.ts holds the two to the same words.
 */
function sinceWords(sinceMs, nowMs) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const pad = (n) => String(n).padStart(2, "0");
  const a = new Date(sinceMs);
  const b = new Date(nowMs);
  const day = (d) => Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
  const apart = day(b) - day(a);
  const time = pad(a.getHours()) + ":" + pad(a.getMinutes());
  if (apart <= 0) return time;
  if (apart === 1) return "yesterday " + time;
  if (apart < 7) return days[a.getDay()] + " " + time;
  const date = months[a.getMonth()] + " " + a.getDate();
  return a.getFullYear() === b.getFullYear() ? date + " " + time : date + " " + a.getFullYear() + " " + time;
}
/**
 * Every time the page shows, in one format: sinceWords for now and before, and for a time ahead
 * "09:14" today, "tomorrow 09:14", a weekday within the week, a date after that.
 */
function clock(iso) {
  const at = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const now = Date.now();
  if (at <= now) return sinceWords(at, now);
  const a = new Date(at);
  const b = new Date(now);
  const day = (d) => Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
  const ahead = day(a) - day(b);
  const time = String(a.getHours()).padStart(2, "0") + ":" + String(a.getMinutes()).padStart(2, "0");
  if (ahead <= 0) return time;
  if (ahead === 1) return "tomorrow " + time;
  if (ahead < 7) return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][a.getDay()] + " " + time;
  return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][a.getMonth()] + " " + a.getDate() + (a.getFullYear() === b.getFullYear() ? "" : " " + a.getFullYear()) + " " + time;
}
/* :clock */
/** A Mark all seen on its way, its refusal, the asOf it cleared, and the card's last fingerprint: module state, so a redraw keeps them. */
let awayMarking = false, awayError = "", awayCleared, awayDrawn, awayScrolled = false;

/** The sentence, part by part: each part stays whole on a narrow screen. Runs are the activity strip's to count. */
function awayParts(s) {
  const n = (k) => num(s[k]);
  const plural = (k, one) => n(k) + " " + one + (n(k) === 1 ? "" : "s");
  const since = typeof s.since === "string" && Number.isFinite(Date.parse(s.since)) ? "Since " + sinceWords(Date.parse(s.since), Date.parse(s.asOf)) : "In the last day";
  const parts = [[{ text: since }]];
  if (n("findings")) parts.push([{ text: plural("findings", "finding") + (n("fromThisConversation") ? ", " + n("fromThisConversation") + " from this conversation" : "") }]);
  if (n("decisions")) parts.push([{ text: n("decisions") + " need" + (n("decisions") === 1 ? "s" : "") + " you" }]);
  if (n("costUsd") > 0) parts.push([{ text: "$" + n("costUsd").toFixed(2) }]);
  return parts;
}

/** The card above the inbox's cards. Drawn again only when what it says changes, so a focused button survives the poll. */
function drawAway() {
  const slot = $("awaySlot");
  const a = inboxAnswer && inboxAnswer.away;
  const s = a && typeof a === "object" && typeof a.asOf === "string" && typeof a.cwd === "string" ? a : undefined;
  const show = !!s && num(s.findings) > 0 && awayCleared !== s.asOf;
  // What the card says, not the answer: asOf is the server's now and moves on every poll, and a card
  // drawn again for it would take the focus off its buttons.
  const print = show ? JSON.stringify([s.cwd, awayParts(s), awayMarking, awayError]) : "";
  if (print === awayDrawn) return;
  awayDrawn = print;
  slot.innerHTML = "";
  if (!show) return;
  const card = document.createElement("section");
  card.className = "icard away";
  card.setAttribute("aria-label", "While you were away");
  const line = document.createElement("div");
  line.className = "sent";
  // The separator ends the part before it, so a wrapped line starts with a part, never with "·".
  const parts = awayParts(s);
  parts.forEach((part, i) => {
    const span = document.createElement("span");
    for (const p of part) span.append(textEl("span", p.cls || "", p.text));
    if (i < parts.length - 1) span.append(textEl("span", "sep", " · "));
    line.append(span);
  });
  card.append(line);
  const acts = document.createElement("div");
  acts.className = "acts";
  const mark = inboxButton(awayMarking ? "Marking…" : "Mark all seen", "seen");
  mark.disabled = awayMarking;
  mark.onclick = () => void markAllSeen().catch(() => {});
  acts.append(mark);
  card.append(acts);
  const stat = textEl("div", "cstat", awayError);
  stat.setAttribute("role", "status");
  card.append(stat);
  slot.append(card);
  // The list scrolls the open conversation's row into view, which can leave the card above the fold;
  // the first card after a load is what you came back to read. Later ones leave the scroll alone.
  if (!awayScrolled && card.scrollIntoView) {
    awayScrolled = true;
    card.scrollIntoView({ block: "nearest" });
  }
}

/**
 * Mark all seen: the project's cursor moves to what the card counts, for the terminal too: the asOf
 * of the latest answer, which the card on the screen says (it is drawn again only when its words
 * change). The findings stay new.
 */
async function markAllSeen() {
  const a = inboxAnswer && inboxAnswer.away;
  const s = a && typeof a === "object" && typeof a.asOf === "string" && typeof a.cwd === "string" ? a : undefined;
  if (awayMarking || !s) return;
  awayMarking = true;
  awayError = "";
  drawAway();
  const r = await inboxPost("/inbox/seen", { cwd: s.cwd, at: s.asOf });
  awayMarking = false;
  if (r.status === 200) awayCleared = s.asOf;
  else awayError = "Not marked: " + plain(str(r.body && r.body.error)) + ". Try again.";
  drawAway();
  if (r.status === 200) refreshInbox().catch(() => {});
}

/* ---------------- the starters: three recipes for an empty project (GET /inbox's starters, docs/recipes.md) ---------------- */
/** A starter's Add on its way, and the line it was answered with, by name: module state, so a redraw keeps them. */
const starterBusy = new Set();
const starterLine = new Map();
let startersDrawn;
const STARTER_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The starters the last answer offered, the names checked: Add sends only one of these. */
function offeredStarters() {
  const list = inboxAnswer && Array.isArray(inboxAnswer.starters) ? inboxAnswer.starters : [];
  return list.filter((s) => s && typeof s === "object" && typeof s.name === "string" && STARTER_NAME.test(s.name));
}
/** A terminal holds this conversation and answers what is sent to it: the wizard must run there (O2). */
function terminalHolds() {
  const h = (state && state.holder) || {};
  return h.kind === "terminal" && h.mine !== true && h.delivers === true && h.piLoops !== false;
}

/** The starter cards, above the inbox's. Drawn again only when what they say changes. */
function drawStarters() {
  const slot = $("startersSlot");
  const list = offeredStarters();
  const held = terminalHolds();
  const print = list.length ? JSON.stringify([list, held, [...starterBusy], [...starterLine]]) : "";
  if (print === startersDrawn) return;
  startersDrawn = print;
  slot.innerHTML = "";
  if (!list.length) return;
  slot.append(textEl("div", "grp", "Start with a loop"));
  for (const s of list) {
    const card = document.createElement("section");
    card.className = "icard starter";
    card.dataset.starter = s.name;
    const head = document.createElement("div");
    head.className = "ih";
    head.append(textEl("b", "", s.name));
    if (num(s.budgetHintUsd) > 0) head.append(textEl("span", "chip", "≈ $" + num(s.budgetHintUsd) + "/day"));
    card.append(head);
    card.append(textEl("p", "ib", str(s.line)));
    const acts = document.createElement("div");
    acts.className = "acts";
    if (held) {
      // The command Add would send, at report.
      const command = "/recipe add " + s.name + " --level report";
      acts.append(textEl("span", "im", "Add it from your terminal: " + command));
      const copy = inboxButton("Copy", "copy");
      copy.onclick = () => {
        const done = (line) => {
          starterLine.set(s.name, line);
          drawStarters();
        };
        const clip = navigator && navigator.clipboard;
        if (!clip || typeof clip.writeText !== "function") return done("Copy it by hand: " + command);
        clip.writeText(command).then(() => done("Copied."), () => done("Copy it by hand: " + command));
      };
      acts.append(copy);
    } else {
      const busy = starterBusy.has(s.name);
      const add = inboxButton(busy ? "Adding…" : "Add", "add", true);
      add.disabled = busy;
      add.onclick = () => void addStarter(s.name).catch(() => {});
      acts.append(add);
    }
    card.append(acts);
    const stat = textEl("div", "cstat", starterLine.get(s.name) || "");
    stat.setAttribute("role", "status");
    card.append(stat);
    slot.append(card);
  }
}

/**
 * Add: the recipe wizard, run by this conversation's pi with the command a person may type here,
 * at report. Its questions are this page's dialogs; closing one installs
 * nothing, and Add is live again. Once the loop exists, the next answer offers no starters.
 */
async function addStarter(name) {
  if (starterBusy.has(name) || terminalHolds() || !offeredStarters().some((s) => s.name === name)) return;
  starterBusy.add(name);
  starterLine.delete(name);
  drawStarters();
  const r = await api("/prompt", { text: "/recipe add " + name + " --level report" });
  starterBusy.delete(name);
  if (!r.success) starterLine.set(name, "Not added: " + plain(str(r.error)));
  drawStarters();
  refreshList().catch(() => {});
}

function moveFocus(i) {
  if (!convRows.length) return;
  focusAt = Math.max(0, Math.min(convRows.length - 1, i));
  convRows.forEach((el, j) => (el.tabIndex = j === focusAt ? 0 : -1));
  convRows[focusAt].focus();
}
$("convs").addEventListener("keydown", (e) => {
  const at = convRows.indexOf(e.target);
  const from = at >= 0 ? at : focusAt;
  if (e.key === "ArrowDown") moveFocus(from + 1);
  else if (e.key === "ArrowUp") moveFocus(from - 1);
  else if (e.key === "Home") moveFocus(0);
  else if (e.key === "End") moveFocus(convRows.length - 1);
  else if (e.key === "Enter" && at >= 0) location.assign(convRows[at].href);
  else return;
  e.preventDefault();
});
for (const [k, id] of SEGMENTS) {
  $(id).onclick = () => {
    segment = k;
    remember("pi-loops-segment", k);
    drawList();
  };
}
$("segAll").parentElement.addEventListener("keydown", (e) => {
  const at = SEGMENTS.findIndex(([k]) => k === segment);
  const to = e.key === "ArrowRight" ? at + 1 : e.key === "ArrowLeft" ? at - 1 : undefined;
  if (to === undefined) return;
  e.preventDefault();
  const [k, id] = SEGMENTS[(to + SEGMENTS.length) % SEGMENTS.length];
  segment = k;
  remember("pi-loops-segment", k);
  drawList();
  $(id).focus();
});
$("project").onchange = () => {
  listCwd = $("project").value;
  refreshList().catch(() => {});
};
/** The project the list shows: the open conversation's, or the one picked above it. */
const listedProject = () => (listAnswer && typeof listAnswer.cwd === "string" && listAnswer.cwd ? listAnswer.cwd : undefined);
/** Whether the list shows a project other than the open conversation's. */
const otherProject = (project) => project !== undefined && !!cwd && project !== cwd;
const projectName = (project) => plain(str(project)).split("/").filter(Boolean).pop() || plain(str(project));
/**
 * A new conversation in another project the list offers: its pi started there by the server, which
 * answers with its address, /c/<id>/, and its id; or why it could not.
 */
async function startConversationIn(project) {
  const r = await inboxPost("/conversations/new", { cwd: project });
  const m = r.status === 200 && typeof r.body.url === "string" ? /^\/c\/([^/?#]+)\/$/.exec(r.body.url) : null;
  if (!m) return { error: plain(str(r.body && r.body.error) || "the server did not answer") };
  return { url: r.body.url, id: decodeURIComponent(m[1]) };
}
/** + New: in the project the list shows. The open conversation's starts a new session in this page's pi, as it always did. */
$("newConv").onclick = () => {
  const project = listedProject();
  if (!otherProject(project)) return $("clear").onclick();
  const note = row("notice", "", "starting a new conversation in " + projectName(project) + "…");
  startConversationIn(project)
    .then((r) => (r.url ? location.assign(r.url) : void (note.textContent = "No new conversation in " + projectName(project) + ": " + r.error)))
    .catch(() => {});
};
$("railList").onclick = () => moveFocus(focusAt);

/**
 * The conversation's name in the header: what it was called, else what the list called it while
 * the list showed its project (another project's list does not have it, and must not take it away).
 */
let openTitle = "";
let shownOpen = false;
function drawTitle() {
  const title = plain(str(state.sessionName || openTitle)).trim();
  $("title").textContent = title || (state.messageCount ? SESSION.slice(-8) : "New conversation");
  $("title").title = SESSION;
}

/**
 * What /state says beside the conversation: who answers what you send (the held line, by the same
 * rule the send notice follows), and whether pi-loops runs. The inbox is the cards above the list.
 */
function drawFrame(s) {
  const h = s.holder || {};
  const terminal = h.kind === "terminal" && h.mine !== true && h.delivers === true;
  // Only a pi with pi-loops in it hands a message to the terminal. One without answers it itself,
  // beside the terminal, and the page says that instead of a promise it would not keep.
  const held = terminal && h.piLoops !== false;
  const beside = terminal && h.piLoops === false;
  const line = $("held");
  line.hidden = !held && !beside;
  line.innerHTML = "";
  if (held) line.append(spanOf("", "⌨"), spanOf("", HELD_LINE));
  // A terminal says on its lease when a turn started; the page reads the file again when it ends.
  if (held && h.turnSince && Number.isFinite(Date.parse(h.turnSince))) line.append(spanOf("", "· answering since " + clock(h.turnSince)));
  else if (beside) line.append(spanOf("", "⌨"), spanOf("", BESIDE_LINE));
  $("input").placeholder = held ? "Message (answered in your terminal)…" : PLACEHOLDER;
  const a = s.automation || {};
  const up = !!a.installed && a.hostPid !== undefined && a.hostPid !== null;
  const host = $("sbHost");
  host.innerHTML = "";
  host.append(spanOf("st " + (up ? "up" : "down")), spanOf("", up ? "pi-loops running in the background" : a.paused ? "loops and checks are paused: " + plain(str(a.paused)) : "pi-loops is not running"));
  const loops = Array.isArray(a.jobs) ? a.jobs.length : 0;
  $("sbLoops").textContent = a.installed ? loops + " loop" + (loops === 1 ? "" : "s") : "";
  drawTitle();
  // Who holds the conversation decides whether a starter's Add runs here or names the terminal command.
  drawStarters();
}

/* ---------------- loop activity, the tab title and notifications (GET /activity, docs/loops.md) ---------------- */
/**
 * The runs and rule results of this conversation's project over the last day, as a strip above the
 * composer: one line closed, a list open. A run that carded is in the conversation as well; every
 * other one is only here. The same answer counts the tab title and decides the hidden tab's
 * notifications. It rides the eight-second poll, visible or not: a browser slows a hidden tab's
 * timers to about once a minute, and that is the delay a notification can have. All text goes in
 * with textContent, and every field is String()ed first: jobs.json is anybody's JSON.
 */
let activityAnswer;
const STRIP_KEY = "pi-loops-strip";
let stripOpen = remembered(STRIP_KEY, "closed") === "open";

async function refreshActivity() {
  if (!TOKEN) await tokenReady;
  let body;
  try {
    body = await fetch("/activity?session=" + encodeURIComponent(SESSION), { headers: { "x-pi-web-token": TOKEN } }).then((r) => r.json());
  } catch (e) {
    return; // the status bar says pi-loops is not answering; the last strip stays
  }
  if (!body || !Array.isArray(body.items)) return;
  activityAnswer = body;
  drawStrip();
  drawTabTitle(body.attention);
  notifyFrom(body.attention);
}

const sameDay = (iso) => {
  const at = new Date(Date.parse(iso));
  const now = new Date();
  return at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
};


/** What the strip says closed: the day's runs, failures and rule results. */
function stripSummary(items) {
  const today = items.filter((i) => sameDay(i.finishedAt));
  const runs = today.filter((i) => i.kind === "run").length;
  const failed = today.filter((i) => i.ok === false && !i.stopped).length;
  const results = today.filter((i) => i.kind === "rule" && i.ok !== false).length;
  return { runs, failed, results };
}

/** One row of the open strip, in words. */
function activityLine(i) {
  const src = i.source || {};
  const name = plain(str(src.label || src.name || src.id)) + (src.gone ? " (removed)" : "");
  const bits = [];
  if (i.kind === "rule") {
    bits.push(i.ok === false ? "check failed: " + plain(str(i.error)) : "matched" + (num(i.findings) ? " · in inbox" : "") + (i.inChat ? " · in chat" : ""));
    if (i.ok !== false && i.text) bits.push(plain(str(i.text)));
    return { mark: i.ok === false ? "✗" : "◆", text: "rule " + name + " · " + bits.join(" · ") };
  }
  if (i.stopped) bits.push(i.stoppedBy === "person" ? "stopped by you" : "stopped");
  else if (i.ok === false) bits.push(plain(str(i.error || "failed")));
  else bits.push(num(i.findings) + " finding" + (num(i.findings) === 1 ? "" : "s"));
  if (num(i.seconds)) bits.push(num(i.seconds) + "s");
  if (num(i.costUsd)) bits.push("$" + num(i.costUsd).toFixed(3));
  // Only a card this conversation got is in the chat on the screen.
  if (i.carded && i.fromThisConversation === true) bits.push("in chat");
  return { mark: i.stopped ? "■" : i.ok === false ? "✗" : "✓", text: name + " · " + bits.join(" · ") };
}

/** The strip, drawn again; a feed that was at its end stays there, though the open strip takes room from it. */
function drawStrip() {
  drawStripInto($("activitySlot"));
  if (atBottom) feed.scrollTop = feed.scrollHeight;
}

function drawStripInto(slot) {
  slot.innerHTML = "";
  const a = activityAnswer;
  if (!a || !a.items.length) return;
  const sum = stripSummary(a.items);
  const head = document.createElement("button");
  head.type = "button";
  head.className = "strip-head";
  head.setAttribute("aria-expanded", stripOpen ? "true" : "false");
  // Runs are counted even at none, unless the day had only rule results: "0 runs" would be the news then.
  head.append(textEl("span", "", "loop activity" + (sum.runs || !sum.results ? " · " + sum.runs + " run" + (sum.runs === 1 ? "" : "s") + " today" : "")));
  if (sum.failed) head.append(textEl("span", "bad", "· " + sum.failed + " failed"));
  if (sum.results) head.append(textEl("span", "", "· " + sum.results + " rule result" + (sum.results === 1 ? "" : "s")));
  head.append(textEl("span", "chev", stripOpen ? "▾" : "▸"));
  head.addEventListener("click", () => {
    stripOpen = !stripOpen;
    remember(STRIP_KEY, stripOpen ? "open" : "closed");
    drawStrip();
  });
  slot.append(head);
  if (!stripOpen) return;
  const list = document.createElement("ul");
  list.setAttribute("role", "list");
  for (const i of a.items) {
    const li = document.createElement("li");
    li.className = "act" + (i.ok === false && !i.stopped ? " bad" : "");
    const line = activityLine(i);
    li.append(textEl("span", "when", clock(i.finishedAt)), textEl("span", "mark", line.mark), textEl("span", "t", line.text));
    li.title = line.text;
    const ids = Array.isArray(i.inboxIds) ? i.inboxIds : [];
    if (ids.length) {
      // A rule's result is a card in the inbox: the row takes you there (the Inbox pane on a phone).
      li.dataset.inb = str(ids[0]);
      li.addEventListener("click", () => {
        showPane("inbox");
        const card = document.querySelector('[data-inb="' + str(ids[0]).replace(/[^A-Za-z0-9-]/g, "") + '"]');
        if (card && card.scrollIntoView) card.scrollIntoView({ block: "nearest" });
      });
    }
    list.append(li);
  }
  if (num(a.more)) list.append(textEl("li", "act dim", "… " + num(a.more) + " more in the last day — /cron runs in a terminal"));
  slot.append(list);
}

/**
 * The tab title: new decisions, then new news, in this conversation's project, each part left out at
 * zero: "(1⚑ 2) pi-loops". An installed page also wears the decisions as its badge.
 */
function tabTitle(att) {
  const d = num(att && att.decisions);
  const n = num(att && att.news);
  const parts = [d ? d + "⚑" : "", n ? String(n) : ""].filter(Boolean);
  return (parts.length ? "(" + parts.join(" ") + ") " : "") + "pi-loops";
}
function drawTabTitle(att) {
  document.title = tabTitle(att);
  const d = num(att && att.decisions);
  try {
    const set = d ? navigator.setAppBadge && navigator.setAppBadge(d) : navigator.clearAppBadge && navigator.clearAppBadge();
    if (set && set.catch) set.catch(() => {});
  } catch (_) {
    // A browser without the badge, or one that refuses it here: the title says the same.
  }
}

/**
 * Notifications, off until asked for from the menu, and fired only while this tab is hidden: a new
 * decision anywhere on the machine, a loop entering a streak of three failures, the day's budget
 * reached. Each is a key kept in localStorage (at most 200), so it fires once, in one tab (the tag),
 * and never for what was there when the page loaded.
 */
const NOTIFY_KEY = "pi-loops-notify";
const NOTIFIED_KEY = "pi-loops-notified";
const NOTIFIED_MAX = 200;
let notifyOn = remembered(NOTIFY_KEY, "off") === "on";
let notifyLooked = false;

function notifyKeys(att) {
  if (!att) return [];
  const keys = [];
  for (const d of Array.isArray(att.newDecisions) ? att.newDecisions : []) keys.push({ key: "d:" + str(d.id), text: plain(str(d.headline)), decision: true });
  for (const f of Array.isArray(att.failing) ? att.failing : []) keys.push({ key: "f:" + str(f.key), text: plain(str(f.name || f.jobId)) + " has failed " + num(f.streak) + " times in a row" });
  if (att.budget) keys.push({ key: "b:" + str(att.budget.day), text: "today's automation reached its $" + num(att.budget.cap).toFixed(2) + " budget; loops wait until tomorrow" });
  return keys;
}

function notifyFrom(att) {
  let known = [];
  try {
    known = JSON.parse(remembered(NOTIFIED_KEY, "[]"));
  } catch (_) {
    known = []; // a value this page did not write
  }
  if (!Array.isArray(known)) known = [];
  const fresh = notifyKeys(att).filter((k) => !known.includes(k.key));
  // The first answer after a load only learns what is already there.
  const first = !notifyLooked;
  notifyLooked = true;
  if (!fresh.length) return;
  remember(NOTIFIED_KEY, JSON.stringify([...known, ...fresh.map((k) => k.key)].slice(-NOTIFIED_MAX)));
  if (first || !notifyOn || document.visibilityState !== "hidden" || typeof Notification !== "function" || Notification.permission !== "granted") return;
  const decisions = fresh.filter((k) => k.decision).length;
  const body = fresh.length === 1 ? fresh[0].text : decisions === fresh.length ? decisions + " decisions need you" : fresh.length + " things need you";
  try {
    const shown = new Notification(fresh.length === 1 && decisions ? "A decision needs you" : "pi-loops", { body, tag: fresh[0].key });
    shown.onclick = () => {
      if (window.focus) window.focus();
      showPane("inbox");
      shown.close();
    };
  } catch (_) {
    // A browser that lists the API and refuses it (a phone outside an installed page): nothing to show.
  }
}

/** The menu's switch for notifications, which says why when this browser cannot have them. */
function drawNotifyToggle() {
  const b = $("notifyMe");
  if (!window.isSecureContext || typeof Notification !== "function") {
    b.textContent = "notifications need https or localhost";
    b.disabled = true;
    return;
  }
  if (Notification.permission === "denied") {
    b.textContent = "notifications are blocked for this site";
    b.disabled = true;
    return;
  }
  b.disabled = false;
  b.textContent = "tell me when something needs me: " + (notifyOn && Notification.permission === "granted" ? "on" : "off");
}
$("notifyMe").addEventListener("click", async () => {
  if (!window.isSecureContext || typeof Notification !== "function") return;
  if (notifyOn) notifyOn = false;
  else {
    // Asked only from this click: a browser refuses a request no person made.
    const p = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    notifyOn = p === "granted";
  }
  remember(NOTIFY_KEY, notifyOn ? "on" : "off");
  drawNotifyToggle();
});
drawNotifyToggle();

/** On a phone, which pane shows: the address says, Chat when it says nothing. */
const PANES = { inbox: $("tabInbox"), chat: $("tabChat"), loops: $("tabLoops") };
function showPane(pane) {
  const p = PANES[pane] ? pane : "chat";
  document.body.dataset.pane = p;
  for (const [k, el] of Object.entries(PANES)) el.className = k === p ? "on" : "";
}
for (const [k, el] of Object.entries(PANES)) {
  el.onclick = (e) => {
    e.preventDefault();
    // pushState, not the hash itself: #loops is also the loops rail's id, and a browser scrolls to it.
    if (history.pushState) history.pushState(null, "", "#" + k);
    showPane(k);
  };
}
showPane((location.hash || "").slice(1));
if (window.addEventListener) window.addEventListener("popstate", () => showPane((location.hash || "").slice(1)));

/* ---------------- Watch for…: a watch from one sentence (docs/design.md decision 24) ---------------- */
/**
 * The sentence is a chat message ('Watch for: …'), queued and cancellable like any other. The model
 * answers it with cron_create or new_trigger, which ask before they create anything: pi's own select,
 * whose title is the card's rows and whose options are the card's choices. That select is drawn here
 * as the card, in the transcript and in the box; Set it up and Cancel answer it through /ui-response
 * like any dialog, and the tool's result in the same turn turns the card into a receipt. Nothing here
 * reads the sentence back into a prompt.
 */
const WATCH_EXAMPLES = [
  "Every morning at 9, read TODO.md and tell me about new unchecked items",
  "When ~/build.done appears, run cargo test and show me the result",
  "每 30 分钟看一下 CI，红了告诉我",
];
/** How long the modal waits for a plan or the end of the turn before it says pi did not answer. */
const WATCH_ANSWER_MS = 90000;
const WATCH_TIME = /\d\s*(?:am|pm|m|min|minutes?|h|hours?|s|secs?|seconds?|d|days?|分钟|小时|秒|天|点)\b|\b(?:every|each|daily|nightly|hourly|weekly|monthly|morning|evening|night|noon|midnight|tomorrow|tonight|today|at\s+\d|@(?:hourly|daily|weekly|monthly)|in\s+(?:\d|an?\s+(?:hour|minute|day|week))|(?:once|twice)\s+a\s+(?:day|week|month)|mon|tue|wed|thu|fri|sat|sun|(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?|weekdays?|weeknights?|weekends?)|每|天|点|小时|分钟|周|明天|晚上|早上|(?:^|\s)(?:[\d*\/,-]+\s+){4}[\d*\/,-]+(?:\s|$)/i;
const WATCH_WAIT = /\b(?:when|whenever|if|once|until|as soon as|after|appears?|exists?|changes?|fails?|gets?|arrives?|merge[sd]?|finish(?:es|ed)?|lands?)\b|当|如果|一旦|等|出现|存在|变|红|失败|完成|合并/i;
/** No time word and no wait word: a thing to do now, not a watch. Generous on purpose: a doubt goes to the model. */
function readsLikeNow(sentence) {
  const s = String(sentence || "");
  return !WATCH_TIME.test(s) && !WATCH_WAIT.test(s);
}
/** Every watch question drawn, by its dialog id: the transcript's card and the box's, settled together. */
const watchAsks = new Map();
/** Set once the transcript is drawn: a question replayed before it would land above the conversation. */
let historyDrawn = false;
/** The sentence being read: when it was sent, and what pi said back, so a turn with no plan can show its reply. */
let watchReading;
let lastReply = "";

function watchDialog() { return $("watch"); }
function watchSay(text, bad) {
  const st = $("watchStatus");
  st.textContent = text || "";
  st.hidden = !text;
  st.className = "notice" + (bad ? " bad" : "");
}
function openWatch(prefill) {
  const dlg = watchDialog();
  const ex = $("watchEx");
  ex.innerHTML = "";
  for (const e of WATCH_EXAMPLES) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = e;
    b.onclick = () => { $("watchText").value = e; $("watchText").focus(); };
    ex.append(b);
  }
  if (prefill !== undefined) $("watchText").value = prefill;
  // Closing the box, however it was closed, loses nothing: a card that still waits for its click
  // is here again; one that is settled, or the now card, goes.
  for (const c of [...$("watchCards").children]) if (!c.pending) c.remove();
  watchSay("");
  if (!dlg.open) dlg.showModal();
  // A kept card is scrolled to the top of the box, as it was when it arrived: on a short screen
  // the box reopens at the top, and the card's body would sit out of view under its buttons.
  const kept = [...$("watchCards").children].find((c) => c.pending);
  if (kept && kept.scrollIntoView) kept.scrollIntoView({ block: "start" });
  $("watchText").focus();
}
/** The "now" card: nothing is sent, and the box stays. */
function nowCard() {
  const card = document.createElement("div");
  card.className = "plan now";
  const head = document.createElement("div");
  head.className = "planh bad";
  head.textContent = "This reads like something to do now, not something to watch.";
  const hint = document.createElement("div");
  hint.className = "dim";
  hint.textContent = "Add a time (“every morning at 9”, “每 30 分钟”) or something to wait for (“when ~/build.done appears”), then what to do. To do it now, say it in the conversation instead.";
  card.append(head, hint);
  return card;
}
/** A turn that ended with no plan: pi's reply, and the box kept for the next try. */
function needsMoreCard(reply) {
  const card = document.createElement("div");
  card.className = "plan more";
  const head = document.createElement("div");
  head.className = "planh";
  head.textContent = "pi needs more before it can set this up";
  const body = document.createElement("div");
  body.className = "ib";
  body.textContent = plain(capped(reply || "(pi said nothing)", 1200));
  const hint = document.createElement("div");
  hint.className = "dim";
  hint.textContent = "Edit the sentence above and read it again.";
  card.append(head, body, hint);
  return card;
}
async function readWatch() {
  const text = $("watchText").value.trim();
  if (!text) return;
  const cards = $("watchCards");
  cards.innerHTML = "";
  watchSay("");
  if (readsLikeNow(text)) { cards.append(nowCard()); return; }
  if (watchReading) clearTimeout(watchReading.timer);
  const shown = "Watch for: " + text;
  // Drawn at once only when it is next, as the composer does; pi's echo draws it otherwise.
  if (!busy && !(state.requests || []).length) {
    row("user", "you", shown);
    drewLocally.push(shown);
    if (drewLocally.length > 20) drewLocally.shift();
  }
  lastReply = "";
  // 'turn' is set when pi echoes this very message: a sentence queued behind a busy turn must not
  // take the earlier turn's end, and its reply, for its own.
  watchReading = { since: Date.now(), text: shown, turn: false, gotPlan: false, timer: setTimeout(() => {
    if (!watchReading || watchReading.gotPlan) return;
    watchReading = undefined;
    watchSay("pi did not answer in time; the conversation has its reply when it comes.", true);
  }, WATCH_ANSWER_MS) };
  watchSay("pi is reading it…");
  const r = await api("/prompt", { text: shown, images: [] });
  if (!r.success) {
    clearTimeout(watchReading?.timer);
    watchReading = undefined;
    watchSay(r.error || "pi did not take it", true);
    return;
  }
  if (r.elsewhere) {
    clearTimeout(watchReading?.timer);
    watchReading = undefined;
    watchSay("Your terminal has this conversation and answers what you send: it asks you there before it sets anything up.");
    row("notice", "", "open in a terminal: answered there");
  } else if (r.aside) {
    clearTimeout(watchReading?.timer);
    watchReading = undefined;
    watchSay("This page shows an older copy of this conversation: your sentence is answered once it reads the new one.");
  } else if (r.queued) refresh();
}
/** The turn that read the sentence is over: with no plan, pi's reply is the answer. */
function watchTurnEnded() {
  if (!watchReading || watchReading.gotPlan || !watchReading.turn) return;
  clearTimeout(watchReading.timer);
  watchReading = undefined;
  watchSay("");
  if (watchDialog().open) $("watchCards").append(needsMoreCard(lastReply));
}
/** The first line of the select cron_create and new_trigger ask with (src/watch-plan.ts WATCH_ASK_HEAD). */
const WATCH_ASK_HEAD = "Set up this watch?";
/** One option of a watch question, as the card's choices; undefined for anything outside the fixed vocabulary. */
function watchChoiceOf(option) {
  const m = /^Set it up · (inbox|this conversation)(?: · (once|every time|with checks))?$/.exec(String(option));
  return m ? { where: m[1] === "inbox" ? "inbox" : "chat", once: m[2] !== "every time", checks: m[2] === "with checks" } : undefined;
}
/** The option the card's choices name: the inverse of watchChoiceOf, for the kind of watch asked about. */
function watchOptionOf(kind, choice) {
  const where = "Set it up · " + (choice.where === "chat" ? "this conversation" : "inbox");
  if (kind === "rule") return where + (choice.once ? " · once" : " · every time");
  return where + (choice.where === "inbox" && choice.checks ? " · with checks" : "");
}
/**
 * A select pi-loops asks for a watch, read back into the card: its rows from the title's
 * 'Label: value' lines (a value's further lines are indented two spaces), its choices from the
 * options, the first option its defaults. Undefined for any other dialog, which keeps the dialog.
 */
function watchAskOf(req) {
  if (req.method !== "select") return undefined;
  const lines = String(req.title || "").split("\n");
  if (lines[0] !== WATCH_ASK_HEAD) return undefined;
  const rows = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith("  ") && rows.length) { rows[rows.length - 1][1] += "\n" + line.slice(2); continue; }
    const cut = line.indexOf(": ");
    if (cut <= 0) return undefined;
    rows.push([line.slice(0, cut), line.slice(cut + 2)]);
  }
  const options = (Array.isArray(req.options) ? req.options : []).map(String);
  const sets = options.filter((o) => o !== "Cancel");
  if (!sets.length || !options.includes("Cancel") || sets.some((o) => !watchChoiceOf(o))) return undefined;
  const kind = rows.some(([label]) => label === "Waits for") ? "rule" : "schedule";
  return { id: String(req.id), kind, rows, options, start: watchChoiceOf(sets[0]), timeout: num(req.timeout) };
}
/** A chip row: one of the labels is on; 'onPick' gets the key. */
function chipRow(options, current, onPick) {
  const wrap = document.createElement("div");
  wrap.className = "chips";
  const draw = (key) => { for (const b of wrap.children) { b.className = b.dataset.key === key ? "on" : ""; b.setAttribute("aria-pressed", b.dataset.key === key ? "true" : "false"); } };
  for (const [key, label, sub] of options) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.key = key;
    b.textContent = label;
    if (sub) { const s = document.createElement("small"); s.textContent = sub; b.append(s); }
    b.onclick = () => { draw(key); onPick(key); };
    wrap.append(b);
  }
  draw(current);
  wrap.pick = draw;
  return wrap;
}
/**
 * The card for one watch question: what pi understood, the choices, and the one button that
 * creates. Every fact is the question's own text, drawn as text; the choices are the axes of its
 * options, and Set it up sends the one option they name.
 */
function watchCardEl(rec, inModal) {
  const ask = rec.ask;
  const rule = ask.kind === "rule";
  const choice = { ...ask.start };
  const card = document.createElement("div");
  card.className = "plan";
  card.dataset.plan = ask.id;
  const head = document.createElement("div");
  head.className = "planh";
  head.textContent = rule ? "When something happens" : "On a schedule";
  const dl = document.createElement("dl");
  const rowOf = (label, part) => {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.append(part);
    dl.append(dt, dd);
    return [dt, dd];
  };
  const textOf = (text, cls) => { const s = document.createElement(cls === "pre" ? "pre" : "span"); if (cls && cls !== "pre") s.className = cls; s.textContent = plain(String(text ?? "")); return s; };
  let command = "";
  for (const [label, value] of ask.rows) {
    if (label === "Command") { command = value; continue; }
    rowOf(label, textOf(value, label === "Then" || label === "Does" ? "pre" : label === "Careful" ? "bad" : undefined));
  }
  /** The rows that hold only for a result in the inbox: a stateful loop's notes, and its checker. */
  const inboxRows = [];
  const showInboxRows = () => { for (const el of inboxRows) el.hidden = choice.where !== "inbox"; };
  rowOf("Result", chipRow(
    rule
      ? [["chat", "Show it in this conversation"], ["inbox", "Put it in my inbox"]]
      : [["inbox", "Put it in my inbox"], ["chat", "Show it in this conversation"]],
    choice.where,
    (k) => { choice.where = k; showInboxRows(); },
  ));
  if (!rule) {
    inboxRows.push(...rowOf("Remembers", textOf("what changed since the last run")));
    if (ask.options.some((o) => watchChoiceOf(o)?.checks)) inboxRows.push(...rowOf("Checks", chipRow([["none", "None"], ["checks", "Each finding, before the inbox"]], choice.checks ? "checks" : "none", (k) => { choice.checks = k === "checks"; })));
    showInboxRows();
  }
  if (rule) rowOf("Repeats", chipRow([["once", "Once, then turn itself off"], ["every", "Every time it happens"]], choice.once ? "once" : "every", (k) => { choice.once = k === "once"; }));
  const cmd = document.createElement("pre");
  cmd.className = "preview";
  cmd.textContent = plain(command);
  const status = document.createElement("div");
  status.className = "cstat";
  const acts = document.createElement("div");
  acts.className = "acts";
  // Cancel first, so Enter in the dialog hits it, as in the confirmation dialog.
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  const set = document.createElement("button");
  set.type = "button";
  set.className = "primary";
  set.textContent = "Set it up";
  acts.append(cancel, set);
  cancel.onclick = () => watchAnswer(rec, "Cancel", "cancelling…");
  set.onclick = () => watchAnswer(rec, watchOptionOf(ask.kind, choice), "setting it up…");
  // The status and the buttons are one footer, so the sticky bar never covers the status.
  const foot = document.createElement("div");
  foot.className = "foot";
  foot.append(status, acts);
  card.append(head, dl, cmd, foot);
  card.pending = true;
  card.wait = (text) => { cancel.disabled = set.disabled = true; status.textContent = text; };
  card.settle = (line) => {
    card.pending = false;
    cancel.disabled = set.disabled = true;
    card.classList.add("done");
    status.textContent = line;
  };
  if (rec.answered) card.wait(rec.answered);
  return card;
}
/** One answer per question, from whichever of its cards was clicked: both cards wait for the tool's result. */
function watchAnswer(rec, value, saying) {
  if (rec.done || rec.answered || !rec.ask.options.includes(value)) return;
  rec.answered = saying;
  for (const c of rec.cards) c.wait(saying);
  api("/ui-response", { id: rec.ask.id, value });
}
/** A watch question arrived (live, or replayed while pi still waits for it): its card in the transcript, and in the box when the sentence is being read there. */
function watchAsked(ask) {
  // Before the transcript is drawn, a card would land above it; the stream's replay and the next poll bring it back.
  if (!historyDrawn) return;
  const rec = watchAsks.get(ask.id) || { ask, cards: [], feed: undefined, modal: undefined, answered: "", done: undefined, timer: undefined };
  if (!watchAsks.has(ask.id)) {
    watchAsks.set(ask.id, rec);
    // pi cancels it on its own when the time is up and tells nobody but the tool, whose result says so too.
    if (ask.timeout > 0) rec.timer = setTimeout(() => watchSettle(rec, { line: "Not set up: nobody answered in time" }), ask.timeout);
  }
  if (rec.done) return;
  if (!rec.feed) {
    rec.feed = watchCardEl(rec, false);
    const line = row("plan", "watch", "");
    line.parentElement.append(rec.feed);
    rec.cards.push(rec.feed);
  }
  if (!rec.modal && watchReading && watchDialog().open) {
    watchReading.gotPlan = true;
    clearTimeout(watchReading.timer);
    watchSay("");
    rec.modal = watchCardEl(rec, true);
    $("watchCards").append(rec.modal);
    // What the card says comes before its buttons: scrolled to the top of the box, on a short screen too.
    if (rec.modal.scrollIntoView) rec.modal.scrollIntoView({ block: "start" });
    rec.cards.push(rec.modal);
  }
  scroll();
}
/** What a create tool's result says, as the one line its card keeps. */
function watchReceipt(message) {
  const parts = Array.isArray(message.content) ? message.content : [message.content];
  const text = parts.map((c) => (typeof c === "string" ? c : (c?.text ?? ""))).join("");
  const d = message.details || {};
  if (message.isError) return { line: "Not set up: " + plain(capped(text, 300)) };
  if (typeof d.id === "string" && text.startsWith("created ")) {
    const rule = message.toolName === "new_trigger";
    const where = rule ? (d.promote_to_chat ? "shows here" : "kept out of this conversation") : d.stateful ? "inbox" : "shows here";
    return { line: "Set up " + d.id.slice(0, 12) + " · " + where + (rule ? " · " + (d.fire_once === false ? "every time" : "once") : ""), created: true, close: true };
  }
  return { line: "Not set up", close: true };
}
/** The result of cron_create or new_trigger, live: it answers the question of its kind that waits. */
function watchResult(message) {
  const kind = message.toolName === "cron_create" ? "schedule" : "rule";
  const rec = [...watchAsks.values()].find((r) => !r.done && r.ask.kind === kind);
  if (rec) watchSettle(rec, watchReceipt(message));
}
/** The turn is over: a question still drawn as waiting was answered by pi already, so it says it was not set up. */
function watchTurnOver() {
  for (const rec of watchAsks.values()) if (!rec.done) watchSettle(rec, { line: "Not set up" });
}
/** Every card of the question becomes its receipt; set up or cancelled, the box closes and the composer is free again. */
function watchSettle(rec, receipt) {
  if (rec.done) return;
  rec.done = receipt;
  clearTimeout(rec.timer);
  for (const c of rec.cards) c.settle(receipt.line);
  // Something was created: the starters, the panel and the inbox count change now, not at the next
  // timer, which a hidden tab never reaches. A reload reads them all anyway.
  if (receipt.created) {
    refresh().catch(() => {});
    refreshInbox().catch(() => {});
  }
  if (rec.modal && watchReading) watchReading = undefined;
  // The transcript's copy of this card keeps the receipt, so closing loses nothing.
  if (receipt.close && rec.modal && watchDialog().open) {
    $("watchClose").onclick();
    $("input").focus();
  }
}
$("watchFor").onclick = () => openWatch();
$("watchRead").onclick = () => { readWatch().catch((e) => watchSay(String(e), true)); };
$("watchClose").onclick = () => watchDialog().close();
$("watchText").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $("watchRead").onclick(); } });

/* ---------------- start ---------------- */
(async () => {
  $("input").value = savedDraft();
  autoGrow();
  setAllWork(allOpen);
  await refresh();
  const hist = await api("/history");
  for (const m of hist.messages || []) renderMessage(m, false);
  historyDrawn = true;
  feed.scrollTop = feed.scrollHeight;
  // Only what happened after the transcript we just replayed. The server numbers every event and
  // told us which number that was, so this is exact: a turn that is running right now keeps
  // streaming into the page instead of being dropped for being too early.
  seen = hist.seq ?? 0;
  epoch = hist.epoch;

  /**
   * The poll is the heartbeat.
   *
   * Everything else here reacts to events, which is no use at all when the events are what stopped
   * arriving — and they do: a server restarted under an open page, a stream the browser dropped
   * while the tab was in the background, a proxy that closed it quietly. The page went on looking
   * alive, drawing what you typed and never showing an answer, until somebody thought to reload it.
   * /state carries the same two numbers the stream does, so a page that is behind can see that it
   * is behind. Twice in a row, because one poll can simply overtake an event in flight.
   */
  checkStream = (s) => {
    // A reload ends by refreshing, and a refresh polls: without this the two call each other.
    if (resyncing || !s || !s.epoch) return;
    if (s.epoch !== epoch) {
      epoch = s.epoch;
      seen = s.seq ?? seen;
      behind = 0;
      void resync(reloadReason()).catch(() => {});
      return;
    }
    if ((s.seq ?? 0) > seen) behind++;
    else behind = 0;
    if (behind >= 2) {
      behind = 0;
      void resync("the connection dropped — the conversation above was reloaded").catch(() => {});
    }
  };

  /*
   * One stream per tab, and only while the tab is looked at.
   *
   * A browser gives one address six connections, and every open tab used to hold one of them for
   * its event stream — so the sixth tab, or a few forgotten behind the first, left nothing for the
   * request that sends what you typed: the fetch queued, neither succeeding nor failing, the bubble
   * drawn and the message never sent (#14). A tab in the background does not need to hear events as
   * they happen: it closes its stream after a moment, and when it is looked at again it opens a new
   * one and polls, and the seq/epoch check above reloads whatever it missed. The pi process behind
   * this page is not involved either way; it runs, and its jobs run, whether anyone is listening.
   */
  let es, opening = false;
  /*
   * The stream's address carries a key minted for it, good for the browser's own reconnects for ten
   * minutes. A browser gives up on a stream the server refused, which is what an old key gets: then
   * this starts again with a new one.
   */
  const openStream = async () => {
    if (es || opening) return;
    opening = true;
    const k = await api("/key", { for: "events" });
    opening = false;
    if (es) return;
    if (!k.key) {
      statusEl.textContent = "reconnecting…";
      setTimeout(() => openStream().catch(() => {}), 3000);
      return;
    }
    const source = new EventSource("/c/" + SESSION + "/events?key=" + k.key);
    es = source;
    source.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      if (Date.now() - markedAt > 2000) markOpenRead();
      applyEvent(ev);
    };
    source.onerror = () => {
      statusEl.textContent = "reconnecting…";
      if (es !== source || source.readyState !== 2) return;
      es = undefined;
      setTimeout(() => openStream().catch(() => {}), 3000);
    };
    source.onopen = () => refresh();
  };
  await openStream();
  let parking;
  document.addEventListener("visibilitychange", () => {
    clearTimeout(parking);
    if (document.visibilityState === "hidden") {
      // Not at once: switching tabs and back should not cost a reconnect and a reload.
      parking = setTimeout(() => {
        if (!es || document.visibilityState !== "hidden") return;
        es.close();
        es = undefined;
        statusEl.textContent = "paused in background";
      }, STREAM_PARK_MS);
    } else if (!es) {
      openStream().catch(() => {});
      refresh().catch(() => {});
    }
  });
  setInterval(refresh, 8000);
})();
</script>`;
