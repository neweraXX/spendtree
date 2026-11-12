import { chromium } from 'playwright';
import { createServer } from 'node:http';
import {
  cp, copyFile, mkdtemp, readFile, realpath, rm, writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = '/work';
const scratch = await mkdtemp(path.join(tmpdir(), 'spendtree-video-'));
const scenes = path.join(scratch, 'scenes');
const output = path.join(root, 'video/spendtree-demo.mp4');
const width = 1280, height = 720, fps = 30;

await cp(new URL('./scenes/', import.meta.url), scenes, { recursive: true });

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

async function confinedFile(base, relative) {
  const resolvedBase = await realpath(base);
  const file = await realpath(path.resolve(resolvedBase, relative));
  if (!file.startsWith(resolvedBase + path.sep)) throw new Error('Forbidden');
  return file;
}

const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(
      new URL(req.url, 'http://localhost').pathname
    );
    let file;
    if (pathname.startsWith('/ui/')) {
      file = await confinedFile(path.join(root, 'ui'), pathname.slice(4));
    } else if (pathname.startsWith('/scenes/')) {
      file = await confinedFile(scenes, pathname.slice(8));
    } else if (pathname === '/demo-output.txt') {
      file = path.join(root, 'video/demo-output.txt');
    } else {
      res.writeHead(404).end();
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
        "style-src 'self' 'unsafe-inline'; connect-src 'self'; " +
        "font-src 'self'; img-src 'self' data:"
    });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = deadline => sleep(Math.max(0, deadline - Date.now()));

async function probe(file) {
  const { stdout } = await exec('ffprobe', [
    '-v', 'error', '-show_format', '-show_streams', '-of', 'json', file
  ]);
  return JSON.parse(stdout);
}

const presentationCSS = `
  html { scroll-behavior: auto !important; }
  body { padding-bottom: 94px; }
  main { max-width: 1220px; padding: 14px 24px 94px; }
  header p, header .meta, header .runs { display: none; }
  header h1 { font-size: 28px; }
  .steps { margin: 10px 0; }
  .steps button { font-size: 15px; padding: 5px 8px; }
  .story { padding: 10px 14px; }
  .story h2 { font-size: 23px; }
  .story p { font-size: 17px; }
  .equation { margin: 10px 0; font-size: 18px; }
  .grid { gap: 14px; }
  .card { padding: 12px; }
  .card h3 { font-size: 16px; margin-bottom: 8px; }
  .node { padding-top: 3px; padding-bottom: 3px; margin: 2px 0; }
  .node .name { font-size: 18px; }
  .node .budget { font-size: 16px; }
  .nums { font-size: 15px; }
  .bar { height: 8px; margin: 4px 0 2px; }
  .events { max-height: 280px; }
  .events li { font-size: 15px; padding: 5px 7px; }
  .events .k, .events .n { font-size: 14px; }
  .legend { font-size: 14px; }
  .compare { margin-top: 12px; }
  .compare table { font-size: 20px; }
  .compare th, .compare td { padding: 10px; }
  #evalBox table { font-size: 18px; }
  #evalBox th, #evalBox td { padding: 8px; }
  #evalBox .nums { font-size: 18px; }
`;

async function installCaption(page) {
  await page.addStyleTag({ content: `
    #video-caption {
      position: fixed; inset: auto 0 0; z-index: 2147483647;
      min-height: 82px; padding: 18px 28px;
      display: flex; align-items: center; justify-content: center;
      background: #101a18; color: #f3fff9;
      border-top: 3px solid #64e7b1;
      font: 600 30px/1.2 system-ui, sans-serif;
      text-align: center; box-sizing: border-box;
    }
    #video-caption:empty { display: none; }
  ` });
  await page.evaluate(() => {
    const caption = document.createElement('div');
    caption.id = 'video-caption';
    document.body.append(caption);
    window.setCaption = text => { caption.textContent = text; };
  });
}

const caption = (page, text) =>
  page.evaluate(text => window.setCaption(text), text);

async function focus(page, selector) {
  await page.locator(selector).evaluate(element => {
    const y = element.getBoundingClientRect().top + window.scrollY - 14;
    window.scrollTo(0, Math.max(0, y));
  });
}

async function prepareUI(page, ai = false) {
  await page.goto(`${origin}/ui/index.html${ai ? '?run=ai' : ''}`);
  await page.waitForFunction(() =>
    document.querySelectorAll('#stepBtns button').length > 0
  );
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: presentationCSS });
  await installCaption(page);
}

async function record(name, seconds, prepare, perform) {
  const context = await browser.newContext({
    viewport: { width, height },
    screen: { width, height },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    reducedMotion: 'reduce',
    recordVideo: {
      dir: path.join(scratch, 'raw'),
      size: { width, height }
    }
  });
  let video, pageError;
  try {
    await context.route('**/*', route => {
      if (route.request().url().startsWith(origin + '/')) {
        return route.continue();
      }
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => { pageError ??= error; });
    video = page.video();
    await prepare(page);
    await page.waitForTimeout(350);
    const start = Date.now();
    await perform(page, start);
    await until(start + seconds * 1000);
    if (pageError) throw pageError;
  } finally {
    await context.close();
  }

  const raw = await video.path();
  const metadata = await probe(raw);
  const duration = Number(metadata.format.duration);
  if (!Number.isFinite(duration) || duration < seconds) {
    throw new Error(`${name}: recording is shorter than its scene`);
  }

  // Keep the final scene-length window, excluding navigation and setup.
  const clip = path.join(scratch, `${name}.mp4`);
  await exec('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(Math.max(0, duration - seconds)), '-i', raw,
    '-an',
    '-vf',
    `scale=${width}:${height},setsar=1,setpts=PTS-STARTPTS,` +
    `fps=${fps},tpad=stop_mode=clone:stop_duration=${seconds},` +
    `trim=duration=${seconds},format=yuv420p`,
    '-frames:v', String(seconds * fps),
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
    '-video_track_timescale', '90000',
    clip
  ]);
  return clip;
}

async function prepareStage(page, mode) {
  await page.goto(`${origin}/scenes/stage.html?mode=${mode}`);
  await page.evaluate(() => window.ready);
  await page.evaluate(() => document.fonts.ready);
  await installCaption(page);
}

try {
  browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage']
  });

  const clips = [];

  clips.push(await record('title', 5,
    page => prepareStage(page, 'title'),
    async () => {}
  ));

  clips.push(await record('terminal', 25,
    page => prepareStage(page, 'terminal'),
    page => page.evaluate(() => window.replayTerminal())
  ));

  const scriptedCaptions = [
    'A human funds the planner.',
    'Delegation moves budget to each branch.',
    'Only one fork gets budget · delegate_rejected',
    'Direct transfer blocked. Overspend rejected.',
    'Failed payout restored exactly once.',
    'Revoke reclaims 5 NEAR and freezes the branch.'
  ];

  clips.push(await record('scripted', 15, async page => {
    await prepareUI(page);
    if (await page.locator('#stepBtns button').count() !== 6) {
      throw new Error('Expected the six-step scripted trace.');
    }
    await caption(page, scriptedCaptions[0]);
  }, async (page, start) => {
    for (let i = 0; i < 6; i++) {
      await page.locator('#stepBtns button').nth(i).click();
      await caption(page, scriptedCaptions[i]);
      await focus(page, '.steps');
      await until(start + (i + 1) * 2500);
    }
  }));

  clips.push(await record('ai', 25, async page => {
    await prepareUI(page, true);
    await page.locator('#compare').waitFor({ state: 'visible' });
    const values = await page.locator('#compareRows tr').evaluateAll(rows =>
      rows.flatMap(row => [...row.cells].slice(1).map(cell =>
        Number.parseFloat(cell.textContent)
      ))
    );
    if (JSON.stringify(values) !== JSON.stringify([9, 6, 1, 0, 31, 10])) {
      throw new Error('AI comparison differs from the approved README.');
    }
    if (await page.locator('#evalRows tr').count() !== 11) {
      throw new Error('Expected the recorded eleven-run LLM table.');
    }

    // Reveal the live LLM section after the tree playback.
    await page.addStyleTag({
      content: 'body:not(.show-eval) #evalBox { display: none; }'
    });
    await focus(page, '#compare');
    await caption(page, 'Same actions, two policies · worst-case testnet replay');
  }, async (page, start) => {
    await until(start + 5000);
    await page.locator('#stepBtns button').first().click();
    await focus(page, '.steps');
    await caption(page, 'Delegation contains the attack · accelerated replay');

    // Use the UI's Play handler, shortening only its replay interval.
    await page.evaluate(() => {
      const nativeInterval = window.setInterval.bind(window);
      const steps = document.querySelectorAll('#stepBtns button').length;
      window.setInterval = (handler, delay, ...args) =>
        nativeInterval(
          handler,
          delay === 4000 ? Math.min(4000, 12000 / steps) : delay,
          ...args
        );
    });
    await page.locator('#play').click();
    await until(start + 19000);
    if (await page.locator('#play').textContent() !== 'Play') {
      throw new Error('AI replay did not finish within the scene.');
    }

    await page.evaluate(() => document.body.classList.add('show-eval'));
    await focus(page, '#evalBox');
    await caption(page, 'Live LLM runs · loss stayed within the blast radius');
    await until(start + 25000);
  }));

  clips.push(await record('end', 8,
    page => prepareStage(page, 'end'),
    async () => {}
  ));

  // Filenames are generated locally and contain no quotes.
  const list = path.join(scratch, 'concat.txt');
  await writeFile(list, clips.map(file => `file '${file}'`).join('\n') + '\n');
  const final = path.join(scratch, 'spendtree-demo.mp4');
  await exec('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', list,
    '-an', '-c:v', 'copy', '-movflags', '+faststart', final
  ]);

  const metadata = await probe(final);
  const stream = metadata.streams.find(stream => stream.codec_type === 'video');
  const valid = stream?.codec_name === 'h264'
    && stream.pix_fmt === 'yuv420p'
    && stream.width === width && stream.height === height
    && stream.r_frame_rate === '30/1'
    && !metadata.streams.some(stream => stream.codec_type === 'audio')
    && Math.abs(Number(metadata.format.duration) - 78) < 0.1;
  if (!valid) throw new Error('Final video failed format/duration validation.');

  await copyFile(final, output);
  console.log(`Rendered ${output}`);
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
