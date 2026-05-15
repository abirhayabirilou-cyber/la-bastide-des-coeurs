#!/usr/bin/env node
// Render presentation/index.html to an MP4 video.
//
// Approach: launch headless Chrome via Puppeteer, override every wall-clock
// timing primitive inside the page (Date.now, performance.now, the Date
// constructor, setTimeout/setInterval, requestAnimationFrame) so virtual time
// is fully controlled from Node. For each video frame we advance virtual
// time, step CSS animations via Animation.currentTime, take a PNG screenshot,
// and pipe it to a single long-running ffmpeg process on stdin. ffmpeg muxes
// the silent video stream with assets/music.mp3 if it exists.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import puppeteer from "puppeteer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const args = parseArgs(process.argv.slice(2));
const width = args.width ?? 3840;
const height = args.height ?? 2160;
const fps = args.fps ?? 30;
const duration = args.duration ?? 150;
const totalFrames = Math.round(duration * fps);
const audioPath = args.audio ?? resolve(repoRoot, "assets/music.mp3");
const outputPath = args.output ?? resolve(repoRoot, "output/bdc-auterive-4k.mp4");
const htmlPath = resolve(repoRoot, "presentation/index.html");

console.log(`[render] viewport ${width}x${height} @ ${fps}fps`);
console.log(`[render] duration ${duration}s -> ${totalFrames} frames`);
console.log(`[render] html     ${htmlPath}`);
console.log(`[render] audio    ${existsSync(audioPath) ? audioPath : "(none — silent video)"}`);
console.log(`[render] output   ${outputPath}`);

mkdirSync(dirname(outputPath), { recursive: true });

const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    "--mute-audio",
    "--font-render-hinting=none",
    `--window-size=${width},${height}`,
  ],
  defaultViewport: { width, height, deviceScaleFactor: 1 },
});

const page = await browser.newPage();

// Patch every timing primitive BEFORE any page script runs so the slideshow
// JS uses our virtual clock from frame zero. The page's own setInterval
// (which drives scene transitions) becomes a controllable queue.
await page.evaluateOnNewDocument(() => {
  const RealDate = Date;
  let virtualNow = 0;
  let nextTimerId = 1;
  const timers = new Map(); // id -> { fireAt, cb, interval, args }
  const rafCallbacks = [];

  globalThis.__setVirtualNow = (t) => {
    virtualNow = t;
    // Fire any timers whose deadline has passed, in deadline order. We loop
    // because a timer's callback may schedule more timers.
    while (true) {
      let due = null;
      for (const [id, t] of timers) {
        if (t.fireAt <= virtualNow && (!due || t.fireAt < due[1].fireAt)) {
          due = [id, t];
        }
      }
      if (!due) break;
      const [id, t] = due;
      if (t.interval == null) {
        timers.delete(id);
      } else {
        t.fireAt += t.interval;
      }
      try { t.cb(...t.args); } catch (e) { console.error(e); }
    }
    // Drain rAF queue: spec says rAFs scheduled during a tick run on the
    // NEXT tick, so swap the queue before invoking.
    const queue = rafCallbacks.splice(0, rafCallbacks.length);
    for (const cb of queue) {
      try { cb(virtualNow); } catch (e) { console.error(e); }
    }
  };

  globalThis.__getVirtualNow = () => virtualNow;

  // Date
  function PatchedDate(...a) {
    if (!(this instanceof PatchedDate)) return new RealDate(virtualNow).toString();
    if (a.length === 0) return new RealDate(virtualNow);
    return new RealDate(...a);
  }
  PatchedDate.prototype = RealDate.prototype;
  PatchedDate.now = () => virtualNow;
  PatchedDate.parse = RealDate.parse;
  PatchedDate.UTC = RealDate.UTC;
  // eslint-disable-next-line no-global-assign
  Date = PatchedDate;

  // performance.now
  const origPerf = performance;
  const perfStart = virtualNow;
  Object.defineProperty(performance, "now", {
    value: () => virtualNow - perfStart,
    configurable: true,
    writable: true,
  });

  // setTimeout / setInterval / clear*
  globalThis.setTimeout = (cb, delay = 0, ...args) => {
    const id = nextTimerId++;
    timers.set(id, { fireAt: virtualNow + delay, cb, interval: null, args });
    return id;
  };
  globalThis.setInterval = (cb, delay = 0, ...args) => {
    const id = nextTimerId++;
    timers.set(id, { fireAt: virtualNow + delay, cb, interval: Math.max(1, delay), args });
    return id;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);
  globalThis.clearInterval = (id) => timers.delete(id);

  // requestAnimationFrame
  globalThis.requestAnimationFrame = (cb) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  };
  globalThis.cancelAnimationFrame = () => {};
});

// Stub the AudioContext: the page generates ambient music procedurally via
// Web Audio. We don't want it making sound in the rendered video (we'll mix
// our own track in ffmpeg) and we don't want it spending CPU on synthesis.
await page.evaluateOnNewDocument(() => {
  class FakeAudioParam {
    constructor(v = 0) { this.value = v; }
    setValueAtTime() { return this; }
    linearRampToValueAtTime() { return this; }
    exponentialRampToValueAtTime() { return this; }
  }
  class FakeNode {
    constructor() {
      this.gain = new FakeAudioParam(1);
      this.frequency = new FakeAudioParam(440);
      this.detune = new FakeAudioParam(0);
    }
    connect() { return this; }
    disconnect() {}
    start() {}
    stop() {}
  }
  class FakeAudioContext {
    constructor() {
      this.currentTime = 0;
      this.sampleRate = 44100;
      this.destination = new FakeNode();
    }
    createGain() { return new FakeNode(); }
    createOscillator() { return new FakeNode(); }
    createConvolver() { return Object.assign(new FakeNode(), { buffer: null }); }
    createBuffer(channels, length) {
      return { getChannelData: () => new Float32Array(length) };
    }
  }
  globalThis.AudioContext = FakeAudioContext;
  globalThis.webkitAudioContext = FakeAudioContext;
});

await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle0" });

// Wait for the first scene's images & fonts to settle. We're at virtual t=0;
// the page hasn't really animated yet.
await page.evaluate(() => document.fonts && document.fonts.ready);

const ffmpegArgs = [
  "-y",
  "-f", "image2pipe",
  "-vcodec", "png",
  "-framerate", String(fps),
  "-i", "-",
];

const haveAudio = existsSync(audioPath);
if (haveAudio) {
  ffmpegArgs.push("-i", audioPath);
} else {
  console.warn("[render] No audio file found at", audioPath, "- producing silent video.");
}

ffmpegArgs.push(
  "-c:v", "libx264",
  "-pix_fmt", "yuv420p",
  "-preset", "medium",
  "-crf", "18",
  "-movflags", "+faststart",
);

if (haveAudio) {
  ffmpegArgs.push(
    "-c:a", "aac",
    "-b:a", "192k",
    "-af", `afade=t=out:st=${Math.max(0, duration - 2.5)}:d=2.5`,
    "-shortest",
  );
}

ffmpegArgs.push(outputPath);

console.log("[render] ffmpeg", ffmpegArgs.join(" "));

const ffmpeg = spawn("ffmpeg", ffmpegArgs, { stdio: ["pipe", "inherit", "inherit"] });
const ffmpegDone = new Promise((resolveDone, reject) => {
  ffmpeg.on("error", reject);
  ffmpeg.on("close", (code) => {
    if (code === 0) resolveDone();
    else reject(new Error(`ffmpeg exited with code ${code}`));
  });
});

const frameMs = 1000 / fps;
const t0 = Date.now();

for (let f = 0; f < totalFrames; f++) {
  const virtualMs = f * frameMs;

  // Advance the in-page clock. This will fire any pending timers (including
  // the slideshow's setInterval, which advances scenes every 10s).
  await page.evaluate((t) => globalThis.__setVirtualNow(t), virtualMs);

  // Step CSS animations to match virtual time. document.getAnimations()
  // returns every running CSS animation (ken-burns, opacity transitions);
  // setting currentTime keeps them deterministic.
  await page.evaluate((t) => {
    for (const anim of document.getAnimations()) {
      try {
        anim.pause();
        // Some implementations require currentTime as a CSSNumericValue, but
        // a plain number works in Chromium.
        anim.currentTime = t - (anim.startTime ?? 0);
      } catch {}
    }
  }, virtualMs);

  const buf = await page.screenshot({ type: "png", omitBackground: false });

  if (!ffmpeg.stdin.write(buf)) {
    await new Promise((r) => ffmpeg.stdin.once("drain", r));
  }

  if (f % Math.max(1, Math.floor(fps)) === 0 || f === totalFrames - 1) {
    const pct = ((f + 1) / totalFrames * 100).toFixed(1);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write(`\r[render] frame ${f + 1}/${totalFrames} (${pct}%) — ${elapsed}s elapsed   `);
  }
}

process.stdout.write("\n");
ffmpeg.stdin.end();
await ffmpegDone;
await browser.close();

const totalElapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`[render] done in ${totalElapsed}s -> ${outputPath}`);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      const n = Number(next);
      out[key] = Number.isFinite(n) ? n : next;
      i++;
    }
  }
  return out;
}
