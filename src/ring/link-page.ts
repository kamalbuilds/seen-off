export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const shell = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Outbox: ${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;800&display=swap" rel="stylesheet">
<style>
:root { --paper: oklch(99% 0.003 255); --ink: oklch(16% 0.010 255); --muted: oklch(42% 0.012 255); --control: oklch(62% 0.010 255); --accent: oklch(82% 0.17 95); }
* { box-sizing: border-box; } body { margin: 0; background: var(--paper); color: var(--ink); font-family: "Archivo", ui-sans-serif, sans-serif; font-size: 16px; line-height: 1.5; }
main { max-width: 520px; margin: 0 auto; padding: 48px 24px; display: grid; gap: 16px; }
.wordmark { font-weight: 800; font-size: 40px; letter-spacing: -0.045em; line-height: 0.9; } .wordmark i { display: inline-block; width: 0.52em; height: 0.52em; background: var(--accent); margin-left: 0.08em; }
h1 { font-size: 28px; font-weight: 800; letter-spacing: -0.03em; line-height: 1.1; margin: 16px 0 0; } p { margin: 0; color: var(--muted); }
label { font-size: 13px; font-weight: 600; color: var(--muted); display: grid; gap: 4px; } input { min-height: 44px; padding: 0 12px; border: 1px solid var(--control); background: var(--paper); font: inherit; border-radius: 0; width: 100%; }
button, .btn { min-height: 44px; padding: 0 24px; border: 0; background: var(--accent); color: var(--ink); font: inherit; font-weight: 700; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; }
.err { background: var(--accent); padding: 12px 16px; font-weight: 600; } form { display: grid; gap: 16px; } :focus-visible { outline: 3px solid var(--ink); outline-offset: 2px; }
</style></head><body><main><div class="wordmark">outbox<i></i></div>${body}</main></body></html>`;

/** The mandatory partner sign-in at the Account Link URL. The nonce and time Ring sent ride along as hidden fields. */
export function linkPage(o: { nonce: string; time: string; error?: string; email?: string }): string {
  return shell("link your Ring account", `
<h1>Link your Ring account</h1>
<p>Ring sent you here to finish connecting. Sign in so Outbox knows whose pickups these are.</p>
${o.error ? `<p class="err" role="alert">${esc(o.error)}</p>` : ""}
<form method="post" action="/ring/link">
<input type="hidden" name="nonce" value="${esc(o.nonce)}"><input type="hidden" name="time" value="${esc(o.time)}">
<label>Your email<input name="email" type="email" autocomplete="email" required value="${esc(o.email ?? "")}"></label>
<label>Sign-in code<input name="passcode" type="password" autocomplete="current-password" required></label>
<button type="submit">Link Ring</button>
</form>`);
}

/** A link that cannot proceed (expired, malformed, already used): what happened and the one thing to do. */
export function linkProblemPage(message: string): string {
  return shell("link not completed", `<h1>This link cannot finish</h1><p class="err" role="alert">${esc(message)}</p><a class="btn" href="/">Back to Outbox</a>`);
}
