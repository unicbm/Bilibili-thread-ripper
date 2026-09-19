"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function load(extra = {}) {
  const context = vm.createContext({ URL, AbortController, DOMException, Response, ReadableStream,
    Headers, Uint8Array, Promise, setTimeout, clearTimeout, setInterval, clearInterval, performance, console, ...extra });
  for (const name of ["range-core", "cdn-resolver", "idm-downloader"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../src", name + ".js"), "utf8"), context);
  }
  return context;
}
const mediaUrl = "https://upos-sz-mirrorali.bilivideo.com/video.m4s";
const range = { start: 0, end: 131071, length: 131072 };
const resolverStub = () => ({ urls: () => [mediaUrl], ordered: () => [mediaUrl], success() {}, failure() {} });
function response(init, total) {
  const [, start, end] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range).map(Number);
  return new Response(new Uint8Array(end - start + 1), {
    status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${total}` }
  });
}

test("rejected responses abort their transport before retries", async () => {
  const context = load();
  const signals = [];
  const downloader = context.__BILI_IDM_DOWNLOADER_FACTORY__.createDownloader({
    getSettings: () => ({}), nativeFetch: async (_url, init) => {
      assert.ok(signals.every(signal => signal.aborted), "previous failed transfers must be stopped");
      signals.push(init.signal);
      return new Response(new ReadableStream(), { status: 200 });
    }
  });
  await assert.rejects(downloader.downloadRange(range, resolverStub(), { parallel: false }), /Range 校验失败/);
  assert.equal(signals.length, 3);
  assert.ok(signals.every(signal => signal.aborted));
});

test("startup never delivers a chunk with a conflicting file total", async () => {
  const context = load();
  const delivered = [];
  const rejectedSignals = [];
  const downloader = context.__BILI_IDM_DOWNLOADER_FACTORY__.createDownloader({
    getSettings: () => ({ concurrency: 4 }), nativeFetch: async (_url, init) => {
      const head = init.headers.Range.startsWith("bytes=0-");
      if (!head) rejectedSignals.push(init.signal);
      return response(init, head ? 1000000 : 2000000);
    }
  });
  await assert.rejects(downloader.downloadRange(range, resolverStub(), {
    startup: true, kind: "video", onOrderedChunk: bytes => delivered.push(bytes.length)
  }), /总长度不一致/);
  assert.deepEqual(delivered, [65536], "only the valid head may reach MediaSource");
  assert.ok(rejectedSignals.every(signal => signal.aborted));
});

test("file totals persist across ranges but are independent per representation", async () => {
  const context = load();
  let total = 1000000;
  const downloader = context.__BILI_IDM_DOWNLOADER_FACTORY__.createDownloader({
    getSettings: () => ({}), nativeFetch: async (_url, init) => response(init, total)
  });
  const resolver = resolverStub();
  await downloader.downloadRange(range, resolver, { kind: "meta" });
  total = 2000000;
  let delivered = 0;
  await assert.rejects(downloader.downloadRange(range, resolver, {
    parallel: false, onOrderedChunk: () => { delivered++; }
  }), /总长度不一致/);
  assert.equal(delivered, 0);
  const result = await downloader.downloadRange(range, resolverStub(), { parallel: false });
  assert.equal(result.bytes.length, range.length);
});

test("a truncated response cannot poison the expected file total", async () => {
  const context = load();
  let requests = 0;
  const downloader = context.__BILI_IDM_DOWNLOADER_FACTORY__.createDownloader({
    getSettings: () => ({}), nativeFetch: async (_url, init) => {
      if (++requests === 1) {
        return new Response(new Uint8Array(1), {
          status: 206, headers: { "Content-Range": "bytes 0-131071/2000000" }
        });
      }
      return response(init, 1000000);
    }
  });
  const result = await downloader.downloadRange(range, resolverStub(), { parallel: false });
  assert.equal(requests, 2);
  assert.equal(result.total, 1000000);
});

test("refreshed signatures update active resolvers without restarting MediaSource", async () => {
  class FakeMediaSource extends EventTarget {
    static isTypeSupported() { return true; }
    constructor() { super(); this.readyState = "closed"; }
  }
  class FakeURL extends URL {
    static createObjectURL() { return "blob:test"; }
    static revokeObjectURL() {}
  }
  const video = Object.assign(new EventTarget(), {
    src: "native", currentSrc: "native", currentTime: 10, paused: false,
    volume: 1, muted: false, playbackRate: 1, dataset: {},
    getAttribute() { return "native"; }, pause() { this.paused = true; }, load() {}, removeAttribute() {}
  });
  const context = load({ URL: FakeURL, MediaSource: FakeMediaSource,
    MutationObserver: class { observe() {} disconnect() {} }, document: { getElementById() { return {}; } } });
  const resolvers = [];
  const createResolver = context.__BILI_CDN_RESOLVER_FACTORY__.createResolver;
  context.__BILI_CDN_RESOLVER_FACTORY__ = { createResolver(...args) {
    const resolver = createResolver(...args);
    resolvers.push(resolver);
    return resolver;
  } };
  context.__BILI_SIDX__ = {};
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/native-mse-player.js"), "utf8"), context);
  const info = token => ({ data: { quality: 80, dash: {
    video: [{ id: 80, height: 1080, codecs: "avc1.640028", baseUrl: `${mediaUrl}?token=${token}` }],
    audio: [{ id: 30280, codecs: "mp4a.40.2", baseUrl: `${mediaUrl.replace("video.m4s", "audio.m4s")}?token=${token}` }]
  } } });
  const player = context.__BILI_NATIVE_MSE_PLAYER_FACTORY__.createNativePlayer({
    container: { querySelector: () => video, dataset: {} }, getSettings: () => ({}), playinfo: info("old"),
    nativeFetch: () => { throw new Error("unexpected network request"); }
  });
  try {
    await player.updatePlayinfo(info("new"));
    assert.equal(player.getDebug().sessionStarts, 1);
    assert.equal(video.src, "blob:test");
    assert.equal(resolvers.length, 2);
    for (const resolver of resolvers) {
      assert.ok(resolver.urls().every(url => url.includes("token=new")));
      assert.ok(resolver.startupCandidates().every(url => url.includes("token=new")));
    }
  } finally { player.destroy({ resumeNative: false }); }
});
