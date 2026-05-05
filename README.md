# pi-tps

TPS (tokens per second) stats widget with waterfall trace visualization for [pi coding agent](https://github.com/mariozechner/pi-coding-agent).

![pi-tps preview](https://pic1.imgdb.cn/item/69f9fb66a5f82cd27f48c614.png)

## Features

- Real-time TPS (tokens per second) display
- Token usage tracking (input/output)
- Waterfall trace visualization
- Tool call monitoring
- Thinking token stats
- TTFT (time to first token) tracking
- Color presets (morandi, forest, ocean, retro, ice, dusk, mono, nord)

## Install

```bash
pi install npm:pi-tps
```

## Usage

The widget appears automatically in the pi TUI status bar.

### Commands

- `/pi-tps` - Configure display settings

### Configuration

Config file: `~/.pi/agent/pi-tps.json`

```json
{
  "showTraces": true,
  "showStats": true,
  "showTtft": false,
  "colorPreset": "mono",
  "maxTraces": 100,
  "maxDetailed": 6
}
```

## License

MIT
