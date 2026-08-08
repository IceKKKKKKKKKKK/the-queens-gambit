import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the minimal game entrance", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>The Queen's Gambit<\/title>/i);
  assert.match(html, /创建棋局/);
  assert.match(html, /房间码/);
  assert.doesNotMatch(html, /把战场|PRIVATE ROOMS|codex-preview|react-loading-skeleton/i);
});

test("starter preview and promotional copy stay removed", async () => {
  const [page, layout, css, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(page, /<GameApp hasRoom=/);
  assert.doesNotMatch(`${page}${layout}${css}${packageJson}`, /codex-preview|react-loading-skeleton|把战场|PRIVATE ROOMS/i);
  await assert.rejects(access(new URL("../app/_sites-preview", templateRoot)));
});

test("opponent headquarters replace only the hidden-piece diamond with an outlined white square", async () => {
  const [component, css] = await Promise.all([
    readFile(new URL("../app/GameApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  const selector = ".station-hit.is-opponent-headquarters .piece-model.is-hidden .piece-crest";
  const ruleStart = css.indexOf(selector);
  const ruleEnd = css.indexOf("}", ruleStart);
  const rule = css.slice(ruleStart, ruleEnd + 1);

  assert.match(component, /info\?\.glyph \?\? "◆"/);
  assert.match(component, /"is-opponent-headquarters"/);
  assert.notEqual(ruleStart, -1);
  assert.match(rule, /aspect-ratio:\s*1/);
  assert.match(rule, /border:\s*2px solid var\(--black\)/);
  assert.match(rule, /background:\s*var\(--white\)/);
  assert.match(rule, /color:\s*transparent/);
});

test("board coordinates, move markers, and replay controls stay visibly rendered", async () => {
  const [component, css, game] = await Promise.all([
    readFile(new URL("../app/GameApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../lib/game.ts", import.meta.url), "utf8"),
  ]);

  assert.match(component, /board-axis-columns/);
  assert.match(component, /board-axis-rows/);
  assert.match(component, /last-move-marker is-from/);
  assert.match(component, /last-move-marker is-to/);
  assert.match(component, /明棋复盘/);
  assert.match(component, /上一手/);
  assert.match(component, /下一手/);
  assert.match(css, /\.board-frame\s*\{[\s\S]*grid-template-columns:\s*2\.4ch minmax\(0, 1fr\) 2\.4ch/);
  assert.match(css, /\.station-hit\.is-last-move-from/);
  assert.match(css, /\.station-hit\.is-last-move-to/);
  assert.match(game, /String\.fromCharCode\(65 \+ position\.col\)/);
});
