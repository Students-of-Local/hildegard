// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `hildegard make`: media from a terminal or an agent's shell, one command per piece. Each command waits until its job
 * on the Hildegard server has finished, saves what it made in a folder here, runs Hildegard's checks on it, and prints
 * the file paths, so an agent that can only run commands (Local Studio, a coding agent's bash) gets a file it can look
 * at, or an error it can act on. Cloning a voice is never one of them: that takes the person, in the Studio.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { describeReview, lintPrompt, type Medium, type Review, reviewMedia } from '@hildegard/craft';
import { HildegardClient, HildegardError, toRequest } from '@hildegard/mcp';
import type { Still, Take, VoiceJob } from '@hildegard/presets';
import { resource, type Step } from '@hildegard/runtime';
import { baseUrl, type Ctx, readStdin } from './commands.ts';
import { type Result, result } from './output.ts';

const DONE = ['done', 'failed', 'canceled'];
/** Long enough for a final video on a laptop GPU; `--wait-minutes` changes it. */
const WAIT_MINUTES = 60;

export const USAGE = `hildegard make image "<prompt>"     [--aspect 1:1] [--quality draft|final] [--count 1-4] [--seed N]
hildegard make video "<prompt>"     [--seconds 5] [--aspect 16:9] [--quality draft|final] [--model <id>] [--from <image>]
hildegard make speech "<script>"    --voice <id> [--direction "<how>"] [--language en]
hildegard make voice "<who it is>"  --text "<a line to read>" [--count 1-3]
hildegard make voice keep <job> <n> --name "<name>"
hildegard make clean <recording>    [--lufs -16] [--peak -1.5]
hildegard make voices               The voices you may speak in
Each one waits for the job, saves into --out (./hildegard-out), checks the result and prints the paths.
A script or prompt of - is read from standard input.`;

/** Every way of asking for a clone, refused before anything reaches the server. */
const CLONE = new Set(['clone', 'clone-voice', 'voice-clone', 'cloning']);

/** What an agent is told when it asks to clone a voice. The person does it in the Studio, with their consent. */
export function cloneRefusal(studio: string): Result {
  return {
    ...result(
      [
        {
          id: 'clone',
          title: 'Cloning a voice needs the person whose voice it is',
          status: 'needs-owner',
          detail: `An agent can’t clone a voice, and this command never will. The person opens Voice › Clone in the Hildegard Studio (${studio}/#/voice/clone), reads a fresh consent line aloud, live, and adds recordings of their own voice. Hildegard checks the line was said by them, wasn’t made by AI, and that every recording is the same person, then signs a consent they can revoke.\nOnce that voice is in the library, \`hildegard make voices\` lists it and \`hildegard make speech --voice <id>\` speaks in it.`,
        },
      ],
      `Refused: an agent can’t clone a voice. Nothing was sent.\nNEXT: tell the person to open ${studio}/#/voice/clone and clone their own voice there, with their consent.`,
    ),
    ok: false,
  };
}

export async function make(ctx: Ctx, args: string[]): Promise<Result> {
  const [what = '', ...rest] = args;
  const client = new HildegardClient(process.env.HILDEGARD_URL ?? baseUrl(ctx.config));
  if (CLONE.has(what) || (what === 'voice' && CLONE.has(rest[0] ?? ''))) return cloneRefusal(client.url);
  const m = new Maker(ctx, client);
  try {
    switch (what) {
      case 'image':
      case 'images':
        return await m.image(await words(rest, 'prompt'));
      case 'video':
      case 'shot':
        return await m.video(await words(rest, 'prompt'));
      case 'speech':
      case 'speak':
        return await m.speech(await words(rest, 'script'));
      case 'voice':
        if (rest[0] === 'keep') return await m.keep(rest.slice(1));
        return await m.design(await words(rest, 'description'));
      case 'voices':
        return await m.voices();
      case 'clean':
        return await m.clean(rest[0]);
      default:
        return usage(what ? `There is no “make ${what}”.` : 'Say what to make.');
    }
  } catch (e) {
    if (e instanceof Usage) return usage(e.message);
    if (e instanceof HildegardError && e.status === 0)
      return failed(
        'server',
        'Hildegard isn’t reachable',
        e.message,
        'tell the person to run `hildegard start`, and stop.',
      );
    // A route this Hildegard doesn't have answers 404 with no error of its own: the server is older than this command.
    if (e instanceof HildegardError && e.status === 404 && e.body.error === undefined)
      return failed(
        'server',
        'This Hildegard is older than this command',
        `The Hildegard at ${client.url}${await serverVersion(client.url)} can’t “make ${what}” yet. Updating it adds it.`,
        'tell the person to run `hildegard update`, and stop.',
      );
    if (e instanceof Error) return failed('make', 'It didn’t work', e.message);
    throw e;
  }
}

/** The server's version, as " (0.1.17)", or nothing when it doesn't say. */
async function serverVersion(url: string): Promise<string> {
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(3000) });
    const v = ((await r.json()) as { version?: unknown }).version;
    return typeof v === 'string' && /^[\w.+-]{1,40}$/.test(v) ? ` (${v})` : '';
  } catch {
    return '';
  }
}

class Usage extends Error {}

function usage(why: string): Result {
  return result(
    [{ id: 'usage', title: why, status: 'failed', detail: USAGE }],
    `${why}\nNEXT: run the command again in one of the forms above.`,
  );
}

const failed = (
  id: string,
  title: string,
  detail: string,
  next = 'tell the person what went wrong, in their words, and stop.',
): Result =>
  result([{ id, title, status: 'failed', detail }], `${title}: ${detail.split('\n')[0]}\nNEXT: ${next}`);

/** The prompt or script: the words after the command, or standard input for `-`. */
async function words(rest: string[], what: string): Promise<string> {
  const text = rest.length === 1 && rest[0] === '-' ? await readStdin() : rest.join(' ');
  if (!text.trim()) throw new Usage(`Give the ${what} in quotes.`);
  return text.trim();
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

class Maker {
  readonly out: string;
  readonly until: number;
  readonly agent: string;
  readonly steps: Step[] = [];
  readonly files: string[] = [];
  readonly reviews: Array<{ file: string; passed: boolean; summary: string; sheet: string | null }> = [];

  readonly ctx: Ctx;
  readonly client: HildegardClient;

  constructor(ctx: Ctx, client: HildegardClient) {
    this.ctx = ctx;
    this.client = client;
    this.out = resolve(ctx.opts.get('out') ?? 'hildegard-out');
    const minutes = Number(ctx.opts.get('wait-minutes') ?? WAIT_MINUTES);
    this.until = Date.now() + (Number.isFinite(minutes) && minutes > 0 ? minutes : WAIT_MINUTES) * 60_000;
    this.agent = (ctx.opts.get('agent') ?? process.env.HILDEGARD_AGENT ?? 'hildegard make').slice(0, 60);
  }

  num(name: string, min: number, max: number): number | undefined {
    const v = this.ctx.opts.get(name);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max)
      throw new Usage(`--${name} must be a number from ${min} to ${max}.`);
    return n;
  }

  quality(): 'draft' | 'final' | undefined {
    const q = this.ctx.opts.get('quality');
    if (q === undefined) return undefined;
    if (q !== 'draft' && q !== 'final') throw new Usage('--quality is draft or final.');
    return q;
  }

  /** Prompt advice before rendering, as review_prompt gives it: the habits that make work look generated. */
  lint(prompt: string, medium: Medium) {
    const r = lintPrompt(prompt, medium);
    if (!r.findings.length) return;
    this.steps.push({
      id: 'prompt',
      title: r.ok ? 'Prompt: judgment calls' : 'Prompt: fix these before the final render',
      // Advice for the next try, not a question for the owner: needsOwner keeps its meaning.
      status: 'skipped',
      detail: r.findings
        .map(
          (f) =>
            `${f.severity === 'fail' ? 'FIX' : 'consider'} ${f.id}${f.match ? ` (${f.match.join(', ')})` : ''}: ${f.fix}`,
        )
        .join('\n'),
    });
  }

  progress(line: string) {
    if (!this.ctx.json) process.stderr.write(`${line}\n`);
  }

  async wait<T>(read: () => Promise<T>, done: (t: T) => boolean, say: (t: T) => string): Promise<T> {
    let last = '';
    for (;;) {
      const t = await read();
      if (done(t)) return t;
      const now = say(t);
      if (now !== last) this.progress(now);
      last = now;
      if (Date.now() >= this.until) throw new Error(`Still not finished after the wait. ${now}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  /** Saves a file the server serves into the out folder. */
  async save(served: string, name: string, made = true): Promise<string> {
    const bytes = await this.client.bytes(served);
    if (!bytes) throw new Error(`Hildegard made it, but ${served} couldn’t be downloaded.`);
    mkdirSync(this.out, { recursive: true });
    const file = join(this.out, name);
    writeFileSync(file, bytes);
    if (made) this.files.push(file);
    return file;
  }

  python(): string {
    const own = join(
      this.ctx.config.dataDir,
      'python',
      process.platform === 'win32' ? join('Scripts', 'python.exe') : join('bin', 'python'),
    );
    if (process.env.HILDEGARD_PYTHON) return process.env.HILDEGARD_PYTHON;
    return existsSync(own) ? own : process.platform === 'win32' ? 'python' : 'python3';
  }

  /** Hildegard's technical checks on a file it made, with a contact sheet for video and sound. */
  async review(
    file: string,
    spec: { sheet?: boolean; seconds?: number; final?: boolean; audio?: boolean } = {},
  ) {
    const sheet = spec.sheet ? join(this.out, `${basename(file, extname(file))}.sheet.jpg`) : undefined;
    let r: Review;
    try {
      r = await reviewMedia(this.python(), resource(join('tools', 'review_media.py')), {
        path: file,
        sheet,
        seconds: spec.seconds,
        final: spec.final,
        audio: spec.audio,
      });
    } catch (e) {
      this.steps.push({
        id: 'review',
        title: `Not reviewed: ${basename(file)}`,
        status: 'skipped',
        detail: `The check couldn’t run here: ${(e as Error).message}`,
      });
      return;
    }
    this.record(file, r, sheet ?? null);
  }

  record(file: string, r: Pick<Review, 'passed' | 'checks'>, sheet: string | null) {
    const summary = describeReview({ ...r, kind: 'image', info: {} });
    this.reviews.push({ file, passed: r.passed, summary: summary.split('\n')[0]!, sheet });
    this.steps.push({
      id: 'review',
      title: `Review ${r.passed ? 'passed' : 'FAILED'}: ${basename(file)}`,
      status: r.passed ? 'done' : 'failed',
      detail: `${summary}${sheet ? `\nContact sheet to look at: ${sheet}` : ''}`,
    });
  }

  finish(made: string, extra: Record<string, unknown> = {}, next?: string): Result {
    const bad = this.reviews.filter((r) => !r.passed).length;
    const unchecked = this.files.length - this.reviews.length;
    const error = this.steps.find((x) => x.status === 'failed' && x.id !== 'review');
    const paths = `path${this.files.length > 1 ? 's' : ''}`;
    const message = !this.files.length
      ? `Nothing was made. ${error ? `${error.title}: ${error.detail}` : ''}\nNEXT: tell the person what went wrong, in their words, and stop.`
      : bad
        ? `${made}: ${this.files.join(', ')}. ${plural(bad, 'file')} failed review.\nNEXT: change one thing in the prompt or settings and run the command again (three tries at most), or tell the person what is still wrong.`
        : unchecked
          ? `${made}: ${this.files.join(', ')}. ${plural(unchecked, 'file')} couldn’t be checked here.\nNEXT: give the person the file ${paths}, say in one sentence what you made, and say Hildegard’s checks couldn’t run, so they should look at it themselves.`
          : `${made}: ${this.files.join(', ')}.\nNEXT: ${next ?? `give the person the file ${paths} and say in one sentence what you made.`}`;
    return result(this.steps, message, { files: this.files, reviews: this.reviews, ...extra });
  }

  async image(prompt: string): Promise<Result> {
    this.lint(prompt, 'image');
    const { stills } = await this.client.makeImages({
      prompt,
      aspect: this.ctx.opts.get('aspect'),
      quality: this.quality(),
      count: this.num('count', 1, 4),
      seed: this.num('seed', 0, 4294967295),
      agent: this.agent,
    });
    const ids = stills.map((s) => s.id);
    this.progress(`Drawing ${plural(ids.length, 'image')} (${ids.join(', ')}).`);
    const all = await this.wait(
      async () => {
        const snap = await this.client.snapshot();
        return ids.map((id) => snap.stills.find((s) => s.id === id)).filter((s): s is Still => !!s);
      },
      (list) => list.length === ids.length && list.every((s) => DONE.includes(s.status)),
      (list) =>
        list
          .map((s) => `${s.id} ${s.status}${s.progress ? ` ${Math.round(s.progress.value * 100)}%` : ''}`)
          .join(', '),
    );
    for (const s of all) {
      if (s.status !== 'done' || !s.image) {
        this.steps.push({
          id: 'image',
          title: `Image ${s.id} ${s.status}`,
          status: 'failed',
          detail: s.error ? `${s.error.message} ${s.error.hint}`.trim() : 'It didn’t finish.',
        });
        continue;
      }
      const file = await this.save(s.image, `image-${s.id}${extname(s.image) || '.png'}`);
      this.steps.push({
        id: 'image',
        title: `Image: ${file}`,
        status: 'done',
        detail: `${s.width}×${s.height}, seed ${s.seed}, ${s.model}${s.renderMs ? `, ${Math.round(s.renderMs / 1000)} s` : ''}.`,
      });
      await this.review(file);
    }
    return this.finish(`Made ${plural(this.files.length, 'image')}`, { stills: ids });
  }

  async video(prompt: string): Promise<Result> {
    this.lint(prompt, 'video');
    const [catalog, snap] = await Promise.all([this.client.catalog(), this.client.snapshot()]);
    const installed = new Set(snap.models.filter((x) => x.installed).map((x) => x.id));
    const request = toRequest(
      {
        prompt,
        aspect: this.ctx.opts.get('aspect'),
        seconds: this.num('seconds', 1, 20),
        quality: this.quality(),
        model: this.ctx.opts.get('model'),
        seed: this.num('seed', 0, 4294967295),
      },
      catalog,
      installed,
    );
    // toRequest names the first video model when none is installed, so this always says which one to install.
    if (!request.model || !installed.has(request.model))
      return failed(
        'model',
        `The video model ${request.model} isn’t installed`,
        `The person installs it after reading its license: hildegard models install ${request.model}`,
        `give the person this command to run themselves, and stop: hildegard models install ${request.model}`,
      );
    const from = this.ctx.opts.get('from');
    if (from) request.startFrame = await this.client.uploadBytes(readFileSync(resolve(from)));
    const { shot, takes } = await this.client.createShot({ request, agent: this.agent });
    this.progress(
      `Rendering shot ${shot.id}, ${plural(takes.length, 'take')} (${takes.map((t) => t.id).join(', ')}).`,
    );
    const d = await this.wait(
      () => this.client.shot(shot.id),
      (x) => x.takes.every((t) => DONE.includes(t.status)),
      (x) =>
        x.takes
          .map(
            (t: Take) =>
              `${t.id} ${t.status}${t.status === 'running' ? ` ${Math.round((t.progress?.value ?? 0) * 100)}%` : t.queuePosition ? ` (number ${t.queuePosition} in line)` : ''}`,
          )
          .join(', '),
    );
    for (const t of d.takes) {
      if (t.status !== 'done' || !t.video) {
        this.steps.push({
          id: 'video',
          title: `Take ${t.id} ${t.status}`,
          status: 'failed',
          detail: t.error ? `${t.error.message} ${t.error.hint}`.trim() : 'It didn’t finish.',
        });
        continue;
      }
      const file = await this.save(t.video, `video-${t.id}.mp4`);
      this.steps.push({
        id: 'video',
        title: `Video: ${file}`,
        status: 'done',
        detail: `${t.width}×${t.height}, ${t.seconds} s, seed ${t.seed}, ${t.quality}.`,
      });
      // The server's own review holds the take to the shot it was asked for (its size and length).
      try {
        const r = await this.client.review(t.id);
        const sheet = r.sheet
          ? await this.save(r.sheet, `video-${t.id}.sheet.jpg`, false).catch(() => null)
          : null;
        this.record(file, r, sheet);
      } catch {
        await this.review(file, { sheet: true, seconds: t.seconds, final: t.quality === 'final' });
      }
    }
    return this.finish(`Made ${plural(this.files.length, 'video')}`, { shot: shot.id });
  }

  async voiceJob(j: VoiceJob, name: (i: number) => string): Promise<VoiceJob> {
    this.progress(`Voice job ${j.id} queued.`);
    const done = await this.wait(
      () => this.client.voiceJob(j.id),
      (x) => DONE.includes(x.status),
      (x) =>
        `${x.id} ${x.status}${x.progress ? ` ${x.progress.done} of ${x.progress.total}` : x.queuePosition ? ` (number ${x.queuePosition} in line)` : ''}`,
    );
    if (done.status !== 'done') {
      this.steps.push({
        id: 'voice',
        title: `Voice job ${done.id} ${done.status}`,
        status: 'failed',
        detail: done.error ? `${done.error.message} ${done.error.hint}`.trim() : 'It didn’t finish.',
      });
      return done;
    }
    for (const [i, a] of done.audio.entries()) {
      const file = await this.save(a, name(i));
      this.steps.push({
        id: 'audio',
        title: `Audio: ${file}`,
        status: 'done',
        detail: `${done.seconds ? `${done.seconds.toFixed(1)} s, ` : ''}${done.model}. It carries Hildegard’s inaudible AI watermark.`,
      });
      await this.review(file, { sheet: true });
    }
    return done;
  }

  async speech(script: string): Promise<Result> {
    const voice = this.ctx.opts.get('voice');
    if (!voice) {
      const v = await this.voices();
      return failed(
        'voice',
        'Say which voice: --voice <id>',
        v.steps[0]!.detail,
        'pick one voice id from the list and run the same command with --voice <id>.',
      );
    }
    const direction = this.ctx.opts.get('direction');
    const paragraphs = script
      .split(/\n\s*\n/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((text) => ({ text, ...(direction ? { direction } : {}) }));
    const j = await this.client.voiceRun('speak', {
      paragraphs,
      voice,
      language: this.ctx.opts.get('language'),
      settings: { speed: 1, expressiveness: 0.5, stability: 0.5, variety: 0.5 },
      seed: this.num('seed', 0, 4294967295),
      agent: this.agent,
    });
    await this.voiceJob(j, () => `speech-${j.id}.wav`);
    return this.finish(`Spoke the script in ${voice}`, { job: j.id });
  }

  async design(description: string): Promise<Result> {
    const line = this.ctx.opts.get('text');
    if (!line) throw new Usage('Give --text "<a line for the candidates to read>".');
    const j = await this.client.voiceRun('design', {
      description,
      text: line,
      language: this.ctx.opts.get('language'),
      candidates: this.num('count', 1, 3),
      agent: this.agent,
    });
    const done = await this.voiceJob(j, (i) => `voice-${j.id}-${i + 1}.wav`);
    if (done.status === 'done')
      this.steps.push({
        id: 'keep',
        title: 'Listen, then keep the candidate you want',
        status: 'skipped',
        detail: `hildegard make voice keep ${j.id} <1-${done.audio.length}> --name "<name>"`,
        command: `hildegard make voice keep ${j.id} 1 --name "<name>"`,
      });
    return this.finish(
      `Designed ${plural(this.files.length, 'candidate voice')}`,
      { job: j.id },
      `give the person the file paths to listen to, ask which one to keep and its name, then run: hildegard make voice keep ${j.id} <number> --name "<name>"`,
    );
  }

  async keep(rest: string[]): Promise<Result> {
    const [job, n] = rest;
    const name = this.ctx.opts.get('name');
    if (!job || !n || !name) throw new Usage('Give the job, the candidate number and --name.');
    const v = await this.client.keepDesign(job, Number(n), name);
    this.steps.push({
      id: 'keep',
      title: `Kept “${v.name}” as voice ${v.id}`,
      status: 'done',
      detail: `hildegard make speech "<script>" --voice ${v.id}`,
    });
    return result(
      this.steps,
      `Kept “${v.name}” as voice ${v.id}.\nNEXT: tell the person, and speak in it with: hildegard make speech "<script>" --voice ${v.id}`,
      { voice: v.id },
    );
  }

  async voices(): Promise<Result> {
    const s = await this.client.voice();
    // Only voices that may be used now: a clone whose consent is withdrawn or waiting is left out.
    const usable = s.voices.filter((v) => !v.consent || v.consent.status === 'active');
    const ready = new Set(s.models.filter((x) => x.installed).map((x) => x.id));
    const lines = usable.map(
      (v) =>
        `${v.id}: ${v.name} (${v.kind}${v.consent ? `, ${v.consent.speaker}’s own voice, consented` : ''}), ${v.language}${v.models.some((x) => ready.has(x)) ? '' : ', its model isn’t installed'}`,
    );
    return result(
      [
        {
          id: 'voices',
          title: `${plural(usable.length, 'voice')} you may speak in`,
          status: 'done',
          detail: lines.join('\n'),
        },
      ],
      `Voices: ${usable.map((v) => v.id).join(', ') || 'none yet'}.\nNEXT: pick one id and run: hildegard make speech "<script>" --voice <id>`,
      { voices: usable.map((v) => ({ id: v.id, name: v.name, kind: v.kind })) },
    );
  }

  async clean(path: string | undefined): Promise<Result> {
    if (!path) throw new Usage('Give the recording to clean: a WAV, MP3, M4A, OGG, FLAC, WebM or MP4 file.');
    const bytes = readFileSync(resolve(path));
    const rec = await this.client.importRecording(bytes, 'auto');
    let job = await this.client.cleanRecording(rec.id, {
      target_lufs: this.num('lufs', -40, -5),
      peak: this.num('peak', -9, 0),
    });
    job = await this.wait(
      () => this.client.cleanJob(job.id),
      (x) => x.status === 'done' || x.status === 'failed',
      (x) => `cleaning: ${x.stage ?? 'working'}`,
    );
    if (job.status === 'failed' || !job.recording?.url)
      return failed('clean', 'Cleaning failed', job.error ?? 'It didn’t finish.');
    const r = job.recording;
    const ext = extname(r.url ?? '') || (r.kind === 'video' ? '.mp4' : '.wav');
    const file = await this.save(r.url!, `${basename(path, extname(path))}-clean${ext}`);
    this.steps.push({
      id: 'clean',
      title: `Cleaned: ${file}`,
      status: 'done',
      detail: `${r.seconds !== null ? `${r.seconds.toFixed(1)} s, ` : ''}${r.clean ? `${r.clean.lufs.toFixed(1)} LUFS, true peak ${r.clean.truePeak.toFixed(1)} dBTP` : 'levelled'}. The original is unchanged.`,
    });
    await this.review(file, { sheet: true, audio: true });
    return this.finish('Cleaned the recording', { recording: r.id });
  }
}
