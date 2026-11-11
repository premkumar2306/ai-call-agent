# Bengaluru dental pilot

This directory contains public-business research and scripts for preparing
independent clinic demo material. It does not contain mailbox credentials or
live outreach logs.

## Cloud generation

Run **Prepare Bengaluru dental campaign assets** from GitHub Actions and supply
a target slug from `targets-500.json`. The workflow validates the dataset,
generates the text demo and outreach copy on an Ubuntu runner, and uploads the
result as an artifact.

Audio generation uses Sarvam in cloud environments and requires the
`SARVAM_API_KEY` Actions secret. Without that secret, leave **Include audio**
disabled and the workflow still produces the text assets.

## Outreach automation

Mailbox work runs through the connected Outlook account rather than GitHub.
The automation follows `automation-policy.json`: public business addresses
only, at most one follow-up after four days, ten messages per run, Sent Items
verification, bounce recording, and no messages to replied, opted-out, or
failed recipients.

Runtime files under `outreach/`, generated audio, and `campaign-*.json` are
ignored because they can contain recipient addresses, Outlook message IDs, and
delivery diagnostics.

## Local commands

```bash
node campaigns/bengaluru-dental-pilot/scripts/generate-demos.mjs \
  --target prakruthi-dental-clinic-rajajinagar
```

On macOS, append `--audio --engine local` to use the system voice. On Linux or
GitHub Actions, use `--audio --engine sarvam` with `SARVAM_API_KEY` configured.
