# Igggy

**Turn your audio recordings into structured notes — right inside Obsidian.**

Igggy takes any audio file from your vault, transcribes it, and uses AI to generate a clean, structured note with a summary, key highlights, and decisions. Bring your own API keys — no accounts, no subscriptions required to get started.

---

## Features

- **Transcription** — OpenAI Whisper (default) or Deepgram Nova-3 with speaker diarization
- **AI summarization** — GPT-4o Mini (default) or Claude Sonnet for higher-quality output
- **Structured notes** — auto-classified as Meeting, Memo, or Lecture with YAML frontmatter
- **Audio compression** — files over 10 MB are automatically compressed before upload (Web Audio API + lamejs), so large recordings process quickly
- **All 3 entry points** — ribbon icon, command palette, or right-click context menu on any audio file
- **Desktop only** — runs entirely within Obsidian's desktop app (Electron); no mobile support

### Supported formats
`m4a` · `mp3` · `wav` · `webm` · `ogg` · `flac` · `aac` · `mp4`

---

## Installation

1. Open Obsidian → **Settings → Community plugins → Browse**
2. Search for **Igggy** and install
3. Enable the plugin under **Installed plugins**
4. Open **Igggy settings** and add at least one API key (see Configuration below)

---

## Configuration

Open **Settings → Igggy** to configure providers and output.

### Transcription

| Provider | API key needed | Notes |
|---|---|---|
| OpenAI Whisper (default) | OpenAI | Same key used for summarization if you choose GPT-4o Mini |
| Deepgram Nova-3 | Deepgram | Adds speaker diarization — `[Speaker 0]:`, `[Speaker 1]:` labels in transcript |

### Summarization

| Provider | API key needed | Notes |
|---|---|---|
| GPT-4o Mini (default) | OpenAI | Works with the same OpenAI key as Whisper |
| Claude Sonnet | Anthropic | Higher-quality structured output |

**The simplest setup:** add a single OpenAI key — it covers both Whisper transcription and GPT-4o Mini summarization.

### Other settings

- **Output folder** — vault folder where notes are created (default: `Igggy`); created automatically if it doesn't exist
- **Embed audio link** — adds `![[recording.m4a]]` at the top of each generated note

---

## Usage

Process any audio file in your vault using any of three entry points:

1. **Ribbon icon** — click the waveform icon in the left sidebar to open a fuzzy file picker
2. **Command palette** — run `Process audio file…` (file picker) or `Process active audio file` (when an audio file is open)
3. **Right-click menu** — right-click any audio file in the file explorer and choose **Process with Igggy**

When you trigger processing, a placeholder note is created immediately and opened in your editor. The note updates in real time as each stage completes — the title starts as the audio filename and renames itself to the AI-generated title when processing finishes. No toast notifications; the note itself is the status surface.

---

## Privacy

Igggy sends audio and text data to third-party API providers you configure:

- **OpenAI** — audio sent to Whisper for transcription; transcript sent to GPT-4o Mini for summarization
- **Deepgram** — audio sent to Nova-3 for transcription (if selected)
- **Anthropic** — transcript sent to Claude Sonnet for summarization (if selected)

Your API keys are stored locally in Obsidian's plugin data store and are never sent anywhere other than their respective provider APIs. No data is collected by Igggy itself.

Refer to each provider's privacy policy for details on how they handle your data.

---

## License

MIT — see [LICENSE](LICENSE)
