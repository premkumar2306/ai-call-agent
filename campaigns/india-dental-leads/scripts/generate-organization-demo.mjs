#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const campaignDirectory = resolve(scriptDirectory, '..');
const citiesDirectory = join(campaignDirectory, 'data', 'cities');
const demoAssetsDirectory = join(campaignDirectory, 'assets', 'demos');
const campaignWhatsAppUrl = 'https://api.whatsapp.com/send/?phone=919944707799&text&type=phone_number&app_absent=0';
const supportedCities = new Set(['bengaluru', 'chennai', 'hyderabad']);
const siteAudioDirectory = resolve(campaignDirectory, '..', 'sites', 'dental-demo-site', 'dist', 'audio');

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await main();

async function main() {
  const args = process.argv.slice(2);
  const city = valueAfter(args, '--city') ?? 'bengaluru';
  const targetArgument = valueAfter(args, '--target');
  const approvedOnly = args.includes('--approved');
  const shouldGenerateAudio = args.includes('--audio');
  const shouldSyncSite = args.includes('--sync-site');
  const audioEngine = valueAfter(args, '--engine') ?? (process.env.SARVAM_API_KEY ? 'sarvam' : 'local');
  const campaignPolicy = JSON.parse(await readFile(join(campaignDirectory, 'automation-policy.json'), 'utf8'));

  if (!supportedCities.has(city)) throw new Error(`Unsupported city: ${city}`);
  if (!['local', 'sarvam'].includes(audioEngine)) throw new Error('--engine must be local or sarvam');
  if (shouldGenerateAudio && audioEngine === 'sarvam' && !process.env.SARVAM_API_KEY) {
    throw new Error('SARVAM_API_KEY is required for --engine sarvam');
  }
  if (shouldGenerateAudio && audioEngine === 'local' && process.platform !== 'darwin') {
    throw new Error('Local audio generation requires macOS; use --engine sarvam in cloud environments');
  }
  if (shouldSyncSite && !shouldGenerateAudio) throw new Error('--sync-site requires --audio');

  const payload = JSON.parse(await readFile(join(citiesDirectory, city, 'organization-targets.json'), 'utf8'));
  const approvedSlugs = approvedOnly ? await readApprovedSlugs(city) : null;
  const selectedTargets = targetArgument
    ? payload.organizations.filter((target) => target.slug === targetArgument)
    : payload.organizations.filter((target) => approvedSlugs ? approvedSlugs.has(target.slug) : ['A', 'B'].includes(target.organizationTier));
  if (targetArgument && selectedTargets.length === 0) throw new Error(`Unknown organization target: ${targetArgument}`);
  if (approvedOnly && selectedTargets.length !== approvedSlugs.size) {
    throw new Error(`Found ${selectedTargets.length} of ${approvedSlugs.size} approved ${city} targets`);
  }

  const generatedDirectory = join(demoAssetsDirectory, city);
  const temporaryDirectory = join(generatedDirectory, '.tmp');
  await mkdir(generatedDirectory, { recursive: true });
  if (shouldGenerateAudio) await mkdir(temporaryDirectory, { recursive: true });
  if (shouldSyncSite) await mkdir(siteAudioDirectory, { recursive: true });

  for (const target of selectedTargets) {
    const demo = buildDemo(target, city);
    const outreach = buildOutreach(target, campaignPolicy.targeting);
    await writeFile(join(generatedDirectory, `${target.slug}-demo.txt`), `${demo}\n`);
    await writeFile(join(generatedDirectory, `${target.slug}-outreach.txt`), `${outreach}\n`);
    if (shouldGenerateAudio) {
      const audioPath = await generateAudio(target.slug, demo, audioEngine, city, generatedDirectory, temporaryDirectory);
      if (shouldSyncSite) await copyFile(audioPath, join(siteAudioDirectory, `${target.slug}.mp3`));
    }
  }

  if (shouldGenerateAudio) await rm(temporaryDirectory, { recursive: true, force: true });
  console.log(`Generated ${selectedTargets.length} organization demo pack(s) in ${generatedDirectory}`);
}

export function buildDemo(target, cityKey) {
  const scripts = {
    bengaluru: [
      `Independent branch-level concept demo for ${target.organizationName}; not connected to a live clinic number.`,
      `Namaste! ${target.organizationName} mein aapka swagat hai.`,
      'Main Aanya, appointment assistant hoon. Aap Hindi ya English mein baat kar sakte hain.',
      'Please tell me your preferred Bengaluru branch and whether you need help with tooth pain, cleaning, root canal, or a general check-up.',
      'Main aapka preferred day and time note kar leti hoon. Clinic team WhatsApp par confirm karegi.'
    ],
    chennai: [
      `Independent branch-level concept demo for ${target.organizationName}; not connected to a live clinic number.`,
      `Vanakkam! ${target.organizationName}-ku varaverkirom.`,
      'I am Aanya, the appointment assistant. You may continue in Tamil or English.',
      'Please tell me your preferred Chennai branch and whether this is for tooth pain, cleaning, root canal, or a general check-up.',
      'I will note your preferred day and time. The clinic team will confirm the request on WhatsApp.'
    ],
    hyderabad: [
      `Independent branch-level concept demo for ${target.organizationName}; not connected to a live clinic number.`,
      `Namaste! ${target.organizationName} mein aapka swagat hai.`,
      'I am Aanya, the appointment assistant. You may continue in Hindi, Telugu, or English.',
      'Please tell me your preferred Hyderabad branch and whether this is for tooth pain, cleaning, root canal, or a general check-up.',
      'I will note your preferred day and time. The clinic team will confirm the request on WhatsApp.'
    ]
  };
  return scripts[cityKey].join(' ');
}

export function buildOutreach(target, targeting = {}) {
  const treatmentFocus = Array.isArray(targeting.treatmentFocus) ? targeting.treatmentFocus.filter(Boolean) : [];
  const inquiryFocus = treatmentFocus.length > 0
    ? `${treatmentFocus.join(', ')} enquiries`
    : 'high-value service enquiries';
  return [
    `Hi ${target.organizationName} operations team, I prepared a short independent branch-level call demo.`,
    `It shows how overflow and after-hours ${inquiryFocus} across your ${target.locationCountInCity} ${target.city} locations could be captured and confirmed on WhatsApp.`,
    'The proposed pilot starts with one branch, includes free setup, and does not replace your number, reception team, or call centre.',
    'Would the person managing appointment operations be open to reviewing it?',
    '',
    'WhatsApp Prem:',
    campaignWhatsAppUrl,
    '',
    'To opt out, reply no.'
  ].join('\n');
}

async function generateAudio(slug, text, engine, cityKey, generatedDirectory, temporaryDirectory) {
  if (engine === 'sarvam') {
    return generateSarvamAudio(slug, text, cityKey, generatedDirectory);
  }

  const aiffPath = join(temporaryDirectory, `${slug}.aiff`);
  const mp3Path = join(generatedDirectory, `${slug}-demo.mp3`);
  const voice = cityKey === 'chennai' ? 'Veena' : 'Rishi';
  await execFileAsync('say', ['-v', voice, '-r', '174', '-o', aiffPath, text]);
  await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', aiffPath, '-codec:a', 'libmp3lame', '-q:a', '4', mp3Path]);
  return mp3Path;
}

async function generateSarvamAudio(slug, text, cityKey, generatedDirectory) {
  const languageCode = cityKey === 'chennai' ? 'ta-IN' : 'hi-IN';
  const response = await fetch('https://api.sarvam.ai/text-to-speech', {
    method: 'POST',
    headers: {
      'api-subscription-key': process.env.SARVAM_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      text,
      model: process.env.SARVAM_TTS_MODEL ?? 'bulbul:v4-flash',
      speaker: process.env.SARVAM_TTS_SPEAKER ?? 'ishita_enhi_customer_expressive',
      language_code: process.env.SARVAM_TTS_LANGUAGE ?? languageCode,
      pace: Number(process.env.SARVAM_TTS_PACE ?? 0.95),
      temperature: Number(process.env.SARVAM_TTS_TEMPERATURE ?? 0.75),
      speech_sample_rate: 44100,
      output_audio_codec: 'mp3'
    })
  });
  if (!response.ok) throw new Error(`Sarvam TTS failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  const result = await response.json();
  if (!Array.isArray(result.audios) || result.audios.length === 0) throw new Error('Sarvam TTS returned no audio');
  const audioPath = join(generatedDirectory, `${slug}-demo.mp3`);
  await writeFile(audioPath, Buffer.from(result.audios.join(''), 'base64'));
  return audioPath;
}

async function readApprovedSlugs(city) {
  const payload = JSON.parse(await readFile(join(campaignDirectory, 'approved-organizations.json'), 'utf8'));
  return new Set(payload.organizations.filter((target) => target.city === city).map((target) => target.slug));
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}
