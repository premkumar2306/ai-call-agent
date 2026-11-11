#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const campaignDirectory = resolve(scriptDirectory, '..');
const generatedDirectory = join(campaignDirectory, 'generated');
const temporaryDirectory = join(generatedDirectory, '.tmp');

const args = process.argv.slice(2);
const targetArgument = valueAfter('--target');
const shouldGenerateAudio = args.includes('--audio');
const audioEngine = valueAfter('--engine') ?? (process.env.SARVAM_API_KEY ? 'sarvam' : 'local');
const targetPayload = JSON.parse(await readFile(join(campaignDirectory, 'targets-500.json'), 'utf8'));
const targets = targetPayload.targets;
const selectedTargets = targetArgument
  ? targets.filter((target) => target.slug === targetArgument)
  : targets;

if (targetArgument && selectedTargets.length === 0) {
  throw new Error(`Unknown target: ${targetArgument}`);
}

if (!['local', 'sarvam'].includes(audioEngine)) {
  throw new Error('--engine must be local or sarvam');
}

if (shouldGenerateAudio && audioEngine === 'sarvam' && !process.env.SARVAM_API_KEY) {
  throw new Error('SARVAM_API_KEY is required for --engine sarvam');
}

if (shouldGenerateAudio && audioEngine === 'local' && process.platform !== 'darwin') {
  throw new Error('Local audio generation requires macOS; use --engine sarvam in cloud environments');
}

await mkdir(generatedDirectory, { recursive: true });
if (shouldGenerateAudio) await mkdir(temporaryDirectory, { recursive: true });

for (const target of selectedTargets) {
  const demo = buildDemo(target);
  const outreach = buildOutreach(target);
  await writeFile(join(generatedDirectory, `${target.slug}-demo.txt`), `${demo}\n`);
  await writeFile(join(generatedDirectory, `${target.slug}-outreach.txt`), `${outreach}\n`);

  if (shouldGenerateAudio) {
    await generateAudio(target.slug, demo, audioEngine);
  }
}

if (shouldGenerateAudio) await rm(temporaryDirectory, { recursive: true, force: true });
console.log(`Generated ${selectedTargets.length} clinic demo pack(s) in ${generatedDirectory}`);

function buildDemo(target) {
  return [
    `Independent concept demo for ${target.clinicName}; not connected to the clinic's live number.`,
    `Namaste! ${target.clinicName} mein aapka swagat hai.`,
    'Main Aanya, aapki virtual appointment assistant.',
    'Aap Hindi ya English, jis language mein comfortable hon, baat kar sakte hain.',
    'Kya aapko tooth pain ho raha hai, ya cleaning, root canal, ya general check-up book karna hai?',
    'Bilkul. Bas apna naam, preferred day, aur time batayiye.',
    'Clinic team aapki request confirm karke WhatsApp par message bhej degi.',
    'Take care, and keep smiling!'
  ].join(' ');
}

function buildOutreach(target) {
  const leadName = target.leadName || 'clinic team';
  const afterHoursAngle = target.afterHoursAngle || 'missed and after-hours appointment requests';
  return [
    `Hi ${leadName}, I made a 25-second independent mock demo for ${target.clinicName}.`,
    `It shows how ${afterHoursAngle.toLowerCase()} could be captured in Hindi or English and confirmed on WhatsApp.`,
    'It is not connected to your number. If useful, may I send the demo link and explain a free 14-day call-forwarding pilot?'
  ].join(' ');
}

async function generateAudio(slug, text, engine) {
  if (engine === 'sarvam') {
    await generateSarvamAudio(slug, text);
    return;
  }

  const aiffPath = join(temporaryDirectory, `${slug}.aiff`);
  const mp3Path = join(generatedDirectory, `${slug}-demo.mp3`);
  await execFileAsync('say', ['-v', 'Rishi', '-r', '174', '-o', aiffPath, text]);
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', aiffPath,
    '-codec:a', 'libmp3lame',
    '-q:a', '4',
    mp3Path
  ]);
}

async function generateSarvamAudio(slug, text) {
  const defaults = {
    model: 'bulbul:v4-flash',
    speaker: 'ishita_enhi_customer_expressive',
    languageCode: 'hi-IN'
  };
  const response = await fetch('https://api.sarvam.ai/text-to-speech', {
    method: 'POST',
    headers: {
      'api-subscription-key': process.env.SARVAM_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      text,
      model: process.env.SARVAM_TTS_MODEL ?? defaults.model,
      speaker: process.env.SARVAM_TTS_SPEAKER ?? defaults.speaker,
      language_code: process.env.SARVAM_TTS_LANGUAGE ?? defaults.languageCode,
      pace: Number(process.env.SARVAM_TTS_PACE ?? 0.95),
      temperature: Number(process.env.SARVAM_TTS_TEMPERATURE ?? 0.75),
      speech_sample_rate: 44100,
      output_audio_codec: 'mp3'
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Sarvam TTS failed (${response.status}): ${body.slice(0, 500)}`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload.audios) || payload.audios.length === 0) {
    throw new Error('Sarvam TTS returned no audio');
  }

  const audio = Buffer.from(payload.audios.join(''), 'base64');
  await writeFile(join(generatedDirectory, `${slug}-demo.mp3`), audio);
}

function valueAfter(flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}
