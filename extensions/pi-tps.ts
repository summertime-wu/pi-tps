import { existsSync, readFileSync, promises as fsPromises } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { truncateToWidth } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ── helpers ──────────────────────────────────────────────────────────────

function formatNum(num: number): string {
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + "M";
  if (num >= 1_000) return (num / 1_000).toFixed(1) + "k";
  return num.toFixed(0);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

interface StatsLineData {
  tps: string;
  input: string;
  output: string;
  toolCount: number;
  thinkTokens: string | null;
  ttft: string | null;
  msgDuration: string;
  totalDuration: string | null;
}

interface TraceSegment {
  type: string;
  ms: number;
  count?: number;
}

interface TraceNode {
  id: string;
  name: string;
  type: "llm" | "tool";
  startTime: number;
  endTime: number;
  ttftTime: number;
  thinkEndTime: number;
  requestSentTime?: number;  // API request sent time (before_provider_request)
  hasThinking?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cachedBar?: { totalChars: number; result: string };
  // set on collapsed summary nodes
  collapsed?: boolean;
  foldCount?: number;
  count?: number;
  _segments?: TraceSegment[];
  _toolIcons?: string;
  _totalInputTokens?: number;
  _totalOutputTokens?: number;
}

const TOOL_ICONS: Record<string, string> = {
  read: "📖", write: "✍️", edit: "✏️",
  bash: "💻", powershell: "🪟", psh: "🪟",
  ls: "📁", find: "🔍", grep: "🔎", cat: "📄",
  mv: "📦", cp: "📋", rm: "🗑️", mkdir: "📂",
  curl: "🌐", wget: "⬇️", git: "🔀",
  npm: "📦", codex: "🤖", ask: "❓",
};

function toolIcon(name: string): string {
  return TOOL_ICONS[name] || "🛠️";
}

function shortName(name: string): string {
  if (name === "powershell") return "psh";
  return name;
}

// ── typed config ─────────────────────────────────────────────────────────

interface TpsConfig {
  showTraces: boolean;
  showStats: boolean;
  showTtft: boolean;
  colorPreset: string;
  maxTraces: number;
  maxDetailed: number;
}

const CONFIG_DEFAULTS: TpsConfig = {
  showTraces: true,
  showStats: true,
  showTtft: false,
  colorPreset: "mono",
  maxTraces: 100,
  maxDetailed: 6,
};

const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-tps.json");

let _config: TpsConfig | null = null;
let _configPromise: Promise<TpsConfig> | null = null;

function getConfig(): TpsConfig {
  if (_config) return _config;
  
  if (existsSync(CONFIG_PATH)) {
    try { 
      // Synchronous fallback just in case, but async loading is preferred
      const file = readFileSync(CONFIG_PATH, "utf-8");
      _config = { ...CONFIG_DEFAULTS, ...JSON.parse(file) };
      return _config;
    } catch {
      /* ignore invalid JSON */
    }
  }

  _config = { ...CONFIG_DEFAULTS };
  return _config;
}

async function ensureConfigAsync(): Promise<TpsConfig> {
  if (_config) return _config;
  if (_configPromise) return _configPromise;
  
  _configPromise = (async () => {
    try {
      if (existsSync(CONFIG_PATH)) {
        const file = await fsPromises.readFile(CONFIG_PATH, "utf-8");
        _config = { ...CONFIG_DEFAULTS, ...JSON.parse(file) };
      }
    } catch {
      _config = { ...CONFIG_DEFAULTS };
    }
    return _config || CONFIG_DEFAULTS;
  })();
  
  return _configPromise;
}

function saveConfig(update: Partial<TpsConfig>): TpsConfig {
  const cfg = getConfig();
  Object.assign(cfg, update);
  fsPromises.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2)).catch(() => {});
  return cfg;
}

// ── color abstraction ──────────────────────────────────────────────────────

type ColorFn = (text: string) => string;

interface ColorPalette {
  muted: ColorFn;
  warning: ColorFn;
  success: ColorFn;
  error: ColorFn;
  text: ColorFn;
  info: ColorFn;
  output: ColorFn;
  input: ColorFn;
  toolBar: ColorFn;
  think: ColorFn;
  ttft: ColorFn;
  gen: ColorFn;
  llmName: ColorFn;
  active: ColorFn;
}

const C = (() => {
  const RESET = "\x1b[0m";
  return (code: number) => (s: string) => `\x1b[38;5;${code}m${s}${RESET}`;
})();

const PALETTE_SPEC: [string, ...number[]][] = [
  ["morandi", 244,137,107,95,252,67,108,244,66,103,180,108,179,73],
  ["forest",  243,137,113,95,250,109,114,243,65,101,187,114,179,79],
  ["ocean",   244,173,79,131,252,68,80,244,67,67,117,80,185,51],
  ["retro",   242,172,148,160,254,103,106,242,64,95,215,106,221,220],
  ["ice",     247,181,110,168,254,146,152,247,145,146,152,152,187,117],
  ["dusk",    246,180,183,132,254,110,182,246,103,140,181,182,223,219],
  ["mono",    242,248,250,240,254,245,247,242,243,239,250,247,252,255],
  ["nord",    244,179,114,167,252,67,110,244,66,61,180,110,223,117],
];

const PALETTE_KEYS: (keyof ColorPalette)[] = [
  "muted","warning","success","error","text","info","output","input",
  "toolBar","think","ttft","gen","llmName","active",
];

const COLOR_PRESETS: Record<string, ColorPalette> = {};
for (const [name, ...codes] of PALETTE_SPEC) {
  const pal = {} as ColorPalette;
  for (let i = 0; i < PALETTE_KEYS.length; i++) {
    pal[PALETTE_KEYS[i]] = C(codes[i]);
  }
  COLOR_PRESETS[name] = pal;
}

const PRESET_NAMES = Object.keys(COLOR_PRESETS);

function getCustomPalette(name: string): ColorPalette {
  return COLOR_PRESETS[name] ?? COLOR_PRESETS.morandi;
}

function makeThemePalette(theme: any): ColorPalette {
  const w = (name: string) => (s: string) => theme.fg(name, s);
  return {
    muted:   w("muted"),
    warning: w("warning"),
    success: w("success"),
    error:   w("error"),
    text:    w("text"),
    info:    w("accent"),
    output:  w("success"),
    input:   w("muted"),
    toolBar: w("text"),
    think:   w("warning"),
    ttft:    w("muted"),
    gen:     w("success"),
    llmName: w("warning"),
    active:  w("success"),
  };
}

// ── bar drawing ──────────────────────────────────────────────────────────

const BAR_TTFT = "░";
const BAR_THINK = "▓";
const BAR_GEN = "█";
const BAR_TOOL = "▌";

type CharMapType = Record<string, { char: string; colorKey: keyof ColorPalette }>;
const CHAR_MAP: CharMapType = {
  ttft: { char: BAR_TTFT, colorKey: "ttft" },
  think: { char: BAR_THINK, colorKey: "think" },
  gen: { char: BAR_GEN, colorKey: "gen" },
  tool: { char: BAR_TOOL, colorKey: "toolBar" },
};

function repeat(ch: string, n: number): string {
  if (n <= 0) return "";
  return ch.repeat(n);
}

function fmtDuration(ms: number): string {
  const s = ms / 1000;
  if (s >= 60) return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
  return s.toFixed(1) + "s";
}

// ── extension ────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── state (non-config mutable state only) ──

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let toolCallCount = 0;

  let sessionStartTime = 0;
  let msgStartTime = 0;
  let turnStartTime = 0;       // turn_start timestamp
  let requestSentTime = 0;     // before_provider_request timestamp
  // firstContentTime: first content arrival (text OR thinking) — marks TTFT
  let firstContentTime = 0;
  // textStartTime: first text delta — marks end of thinking phase, start of text gen
  let textStartTime = 0;
  let streamedTextLen = 0;
  let streamedThinkLen = 0;

  const activeTools = new Map<string, TraceNode>();

  let traces: TraceNode[] = [];
  let llmCounter = 0;
  let activeLlmTrace: TraceNode | null = null;

  // ── fold/display cache ──
  let cachedFolded: TraceNode[] | null = null;
  let cachedDisplay: TraceNode[] | null = null;

  function invalidateFoldCache() {
    cachedFolded = null;
    cachedDisplay = null;
    cachedSummaryNode = null;
    cachedSummaryHash = 0;
  }

  function trimTraces() {
    const max = getConfig().maxTraces;
    const excess = traces.length - max;
    if (excess <= 0) return;

    let removed = 0;
    traces = traces.filter(t => {
      if (removed < excess && t.endTime > 0) {
        removed++;
        return false;
      }
      return true;
    });
  }

  let lastStatsLine: StatsLineData | null = null;
  let lastRefreshTime = 0;
  let smoothedTps = 0;
  let spinnerIdx = 0;
  let msgStartInputTokens = 0;
  const SPINNER_CHARS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  // widget
  let tuiRef: any = null;
  let themeRef: any = null;
  let widgetRef: {
    invalidate: () => void;
    render: (w: number) => string[];
  } | null = null;
  let widgetCache: { lines: string[]; width: number } | null = null;
  let lastWidth = 50;

  let maxNameLen = 0;

  // ── pre-compute basic display string ──
  function getDisplayName(t: TraceNode): string {
    const iconChar = t.collapsed ? "▸" : t.type === "llm" ? "🤖" : toolIcon(t.name);
    let displayName = `${iconChar} ${t.name}`;
    if (t.foldCount) displayName += ` ×${t.foldCount}`;
    return displayName;
  }

  function buildBarString(
    t: TraceNode,
    now: number,
    totalChars: number,
    p: ColorPalette
  ): string {
    if (t.endTime > 0 && t.cachedBar?.totalChars === totalChars) {
      return t.cachedBar.result;
    }

    const durMs = Math.max((t.endTime === 0 ? now : t.endTime) - t.startTime, 0);
    let result: string;

    if (t.collapsed && t._segments) {
      const segs = t._segments;
      const totalMs = segs.reduce((s, seg) => s + seg.ms, 0);
      if (totalMs > 0 && totalChars > 0 && segs.length > 0) {
        const toolCharsTotal = segs.reduce(
          (s, seg) => s + (seg.type === "tool" ? (seg.count ?? 1) : 0), 0
        );
        const llmSegs = segs.filter(s => s.type !== "tool");
        const llmTotalMs = llmSegs.reduce((s, seg) => s + seg.ms, 0);
        const llmChars = Math.max(0, totalChars - toolCharsTotal);
        let remaining = totalChars;
        result = "";
        for (const seg of segs) {
          const m = CHAR_MAP[seg.type];
          if (!m) continue;
          const colorFn = p[m.colorKey] as ColorFn;
          let n: number;
          if (seg.type === "tool") {
            n = seg.count ?? 1;
          } else {
            n = llmTotalMs > 0
              ? Math.round((seg.ms / llmTotalMs) * llmChars)
              : Math.max(0, llmChars - (remaining - llmChars));
          }
          n = Math.max(0, Math.min(n, remaining));
          result += colorFn(repeat(m.char, n));
          remaining -= n;
        }
      } else {
        result = p.toolBar(repeat(BAR_TOOL, totalChars));
      }
    } else if (t.type === "tool") {
      // Tool spans should reflect duration on the waterfall timeline.
      // foldCount is already shown in the name (×N); using it here makes long tools look like 1-cell blips.
      result = p.toolBar(repeat(BAR_TOOL, Math.max(totalChars, 1)));
    } else if (t.type === "llm") {
      if (durMs <= 0) { result = p.ttft(repeat(BAR_TTFT, totalChars)); }
      else {
        const ttftStart = t.requestSentTime ?? t.startTime;
        const ttftMs = t.ttftTime > 0 ? clamp(t.ttftTime - ttftStart, 0, durMs) : durMs;
        let thinkMs = 0;
        if (t.hasThinking) {
          const tEnd = t.thinkEndTime > 0 ? t.thinkEndTime : (t.endTime === 0 ? now : t.endTime);
          thinkMs = clamp(tEnd - t.ttftTime, 0, durMs - ttftMs);
        }
        const genMs = Math.max(durMs - ttftMs - thinkMs, 0);
        const ttftChars = Math.round((ttftMs / durMs) * totalChars);
        const thinkChars = Math.min(Math.round((thinkMs / durMs) * totalChars), totalChars - ttftChars);
        const genChars = Math.max(0, totalChars - ttftChars - thinkChars);
        result =
          p.ttft(repeat(BAR_TTFT, ttftChars)) +
          p.think(repeat(BAR_THINK, thinkChars)) +
          p.gen(repeat(BAR_GEN, genChars));
      }
    } else {
      result = "";
    }

    if (t.endTime > 0) {
      t.cachedBar = { totalChars, result };
    }
    return result;
  }

  // ── collapse old traces into summary ─────────────────────────────

  let cachedSummaryNode: TraceNode | null = null;
  let cachedSummaryHash = 0;

  function mergeCollapsed(collapsed: TraceNode[], now: number): TraceNode {
    // Quick hash to skip recalculating mostly static collapsed nodes
    let hasActive = false;
    for (let i = 0; i < collapsed.length; i++) {
      if (collapsed[i].endTime === 0) { hasActive = true; break; }
    }
    const hash = collapsed.length;
    let needsFullCalc = !cachedSummaryNode || cachedSummaryHash !== hash || hasActive;
    
    if (!needsFullCalc && cachedSummaryNode) {
      return cachedSummaryNode;
    }

    let minStart = Infinity;
    let maxEnd = 0;
    let toolCount = 0;
    let llmCount = 0;
    let hasThinking = false;
    const toolNames = new Set<string>();
    let totalInput = 0;
    let totalOutput = 0;
    const segments: TraceSegment[] = [];

    for (const t of collapsed) {
      if (t.startTime < minStart) minStart = t.startTime;
      const end = t.endTime === 0 ? now : t.endTime;
      if (end > maxEnd) maxEnd = end;
      if (t.type === "tool") {
        const cnt = t.foldCount || 1;
        toolCount += cnt;
        toolNames.add(t.name);
        segments.push({ type: "tool", ms: Math.max(end - t.startTime, 0), count: cnt });
      } else {
        llmCount++;
        totalInput += t.inputTokens || 0;
        totalOutput += t.outputTokens || 0;
        const durMs = Math.max(end - t.startTime, 0);
        const ttftStart = t.requestSentTime ?? t.startTime;
        const ttftMs = t.ttftTime > 0 ? clamp(t.ttftTime - ttftStart, 0, durMs) : durMs;
        if (ttftMs > 0) segments.push({ type: "ttft", ms: ttftMs });
        let thinkMs = 0;
        if (t.hasThinking) {
          const tEnd = t.thinkEndTime > 0 ? t.thinkEndTime : end;
          thinkMs = clamp(tEnd - t.ttftTime, 0, durMs - ttftMs);
          if (thinkMs > 0) segments.push({ type: "think", ms: thinkMs });
        }
        const genMs = Math.max(durMs - ttftMs - thinkMs, 0);
        if (genMs > 0) segments.push({ type: "gen", ms: genMs });
      }
      if (t.hasThinking) hasThinking = true;
    }

    const toolIconsArr = [...toolNames].sort().map(n => toolIcon(n));
    const parts: string[] = [];
    if (llmCount > 0) parts.push(`${llmCount}🤖`);
    if (toolCount > 0) parts.push(`${toolCount}🛠️`);

    cachedSummaryHash = hash;
    cachedSummaryNode = {
      id: "__collapsed__",
      name: parts.join(" "),
      type: "tool",
      startTime: minStart,
      endTime: maxEnd,
      ttftTime: 0,
      thinkEndTime: 0,
      collapsed: true,
      count: collapsed.length,
      hasThinking,
      _segments: segments,
      _toolIcons: toolIconsArr.join(""),
      _totalInputTokens: totalInput,
      _totalOutputTokens: totalOutput,
    };
    return cachedSummaryNode;
  }

  // ── fold consecutive same-name tool calls ────────────────────────

  function foldConsecutiveTools(nodes: TraceNode[]): TraceNode[] {
    if (nodes.length === 0) return nodes;
    const result: TraceNode[] = [];
    let i = 0;
    while (i < nodes.length) {
      const t = nodes[i];
      if (t.type === "tool" && t.endTime > 0) {
        let j = i + 1;
        while (
          j < nodes.length &&
          nodes[j].type === "tool" &&
          nodes[j].name === t.name &&
          nodes[j].endTime > 0
        ) { j++; }
        const count = j - i;
        if (count > 1) {
          result.push({
            ...t,
            cachedBar: undefined,
            endTime: Math.max(t.endTime, nodes[j - 1].endTime),
            foldCount: count,
          });
          i = j;
          continue;
        }
      }
      result.push(t);
      i++;
    }
    return result;
  }

  // ── waterfall ───────────────────────────────────────────────────────

  function buildWaterfallLines(width: number, p: ColorPalette): string[] {
    if (traces.length === 0) return [];

    const now = Date.now();
    let minTime = Infinity;
    let maxTime = -Infinity;
    for (let i = 0; i < traces.length; i++) {
      const t = traces[i];
      if (t.startTime < minTime) minTime = t.startTime;
      const end = t.endTime === 0 ? now : t.endTime;
      if (end > maxTime) maxTime = end;
    }

    const totalMs = Math.max(maxTime - minTime, 1);

    // fold + collapse (cached)
    if (!cachedFolded) {
      cachedFolded = foldConsecutiveTools(traces);
      cachedDisplay = null;
    }
    if (!cachedDisplay) {
      const maxDetailed = getConfig().maxDetailed;
      if (cachedFolded.length > maxDetailed) {
        const split = cachedFolded.length - maxDetailed;
        // Avoid slice and spread operator to reduce GC
        const collapsedArr = [];
        for (let j = 0; j < split; j++) collapsedArr.push(cachedFolded[j]);
        
        cachedDisplay = [mergeCollapsed(collapsedArr, now)];
        for (let j = split; j < cachedFolded.length; j++) {
          cachedDisplay.push(cachedFolded[j]);
        }
      } else {
        cachedDisplay = [];
        for (let j = 0; j < cachedFolded.length; j++) {
          cachedDisplay.push(cachedFolded[j]);
        }
      }
      
      // Update maxNameLen on display node cache update
      maxNameLen = 0;
      for (const t of cachedDisplay) {
        const active = t.endTime === 0 && !t.collapsed;
        let dName = getDisplayName(t);
        if (t.type === "llm" && active && t.hasThinking) dName += " 🧠";
        maxNameLen = Math.max(maxNameLen, dName.length);
      }
    }
    const displayNodes = cachedDisplay;

    // ── adaptive name column width ──
    const nameCol = clamp(maxNameLen + 1, 8, Math.floor(width * 0.35));
    const barWidth = clamp(width - nameCol - 9, 6, 60);

    // spinner
    spinnerIdx = (spinnerIdx + 1) % SPINNER_CHARS.length;

    const lines: string[] = [];

    for (let ni = 0; ni < displayNodes.length; ni++) {
      const t = displayNodes[ni];
      const active = t.endTime === 0 && !t.collapsed;
      const endTime = t.endTime === 0 ? now : t.endTime;

      const durMs = Math.max(endTime - t.startTime, 0);
      const startMs = t.startTime - minTime;
      const endMs = startMs + durMs;

      const startCol = clamp(Math.round((startMs / totalMs) * barWidth), 0, barWidth);
      const endCol = clamp(
        Math.round((endMs / totalMs) * barWidth),
        startCol + (active ? 1 : 0),
        barWidth
      );
      const preSpace = startCol;
      const totalChars = Math.max(endCol - startCol, durMs > 0 ? 1 : 0);

      // name
      let displayName = getDisplayName(t);
      if (t.type === "llm" && active && t.hasThinking) displayName += " 🧠";
      
      let nameStr = displayName;
      if (nameStr.length > nameCol) nameStr = nameStr.substring(0, nameCol - 1) + "…";
      const namePad = nameStr.padEnd(nameCol);
      const nameColored = t.collapsed
        ? p.muted(namePad)
        : active
          ? p.active(namePad)
          : t.type === "llm"
            ? p.llmName(namePad)
            : p.text(namePad);

      const marker = active ? p.active(SPINNER_CHARS[spinnerIdx]) : " ";

      const timeStr = ` ${fmtDuration(durMs)}`;
      const timeColored = t.collapsed || (!active)
        ? p.muted(timeStr)
        : p.warning(timeStr);

      const bar = buildBarString(t, now, totalChars, p);
      let line = ` ${marker} ${nameColored} ${repeat(" ", preSpace)}${bar}${timeColored}`;

      // collapsed extras
      if (t.collapsed && width >= 50) {
        const extras: string[] = [];
        if (t._toolIcons) extras.push(p.muted(t._toolIcons));
        if ((t._totalInputTokens ?? 0) > 0 || (t._totalOutputTokens ?? 0) > 0) {
          extras.push(
            `${p.input(`↑${formatNum(t._totalInputTokens ?? 0)}`)} ${p.output(`↓${formatNum(t._totalOutputTokens ?? 0)}`)}`
          );
        }
        if (extras.length) line += ` ${extras.join(" ")}`;
      }

      // LLM token stats
      if (t.type === "llm" && !t.collapsed && width >= 50) {
        const toks = t.outputTokens || 0;
        if (toks > 0 || (t.inputTokens || 0) > 0) {
          let tpsExtra = "";
          if (t.ttftTime > 0 && toks > 0) {
            const tps = endTime === 0 && smoothedTps > 0
              ? Math.round(smoothedTps)
              : Math.round(toks / Math.max((endTime - t.ttftTime) / 1000, 0.1));
            tpsExtra = ` ${p.text(`${tps}t/s`)}`;
          }
          line += ` ${p.input(`↑${formatNum(t.inputTokens || 0)}`)} ${p.output(`↓${formatNum(toks)}`)}${tpsExtra}`;
        }
      }

      lines.push(line);
    }

    return lines;
  }

  // ── full waterfall ───────────────────────────────────────────────

  function buildWaterfallFull(p: ColorPalette): string {
    const width = lastWidth || 50;
    const lines = buildWaterfallLines(width, p);
    if (lines.length === 0) return "";
    return "\n\n" + lines.join("\n");
  }

  // ── stats ────────────────────────────────────────────────────────────

  function updateStats(message: any, now: number) {
    if (msgStartTime <= 0) return;

    // TPS calc starts from: text generation > first content (thinking) > message start
    const genStart = textStartTime > 0 ? textStartTime : (firstContentTime > 0 ? firstContentTime : msgStartTime);
    const pureOutputElapsed = Math.max((now - genStart) / 1000, 0.1);

    let outputTokens = message.usage?.output;
    if (!outputTokens) {
      const thinkToks = Math.floor(streamedThinkLen / 4);
      const textToks = Math.floor(streamedTextLen / 3.5);
      outputTokens = thinkToks + textToks || 0;
    }

    const inputTokens = message.usage?.input;
    const currentInput = Math.max(inputTokens ?? 0, msgStartInputTokens);
    const inputKnown = currentInput > 0 || totalInputTokens > 0;
    const displayInput = totalInputTokens + currentInput;
    const displayOutput = totalOutputTokens + outputTokens;

    let tps = "…";
    if (outputTokens > 0) {
      const rawTps = outputTokens / Math.max(pureOutputElapsed, 0.05);
      if (smoothedTps === 0) {
        smoothedTps = rawTps;
      } else {
        smoothedTps = 0.15 * rawTps + 0.85 * smoothedTps;
      }
      tps = Math.round(smoothedTps).toString();
    }

    const rawThink = Math.floor(streamedThinkLen / 4);
    const showTtft = getConfig().showTtft;
    // TTFT: use requestSentTime if available, fallback to msgStartTime
    const ttftBase = requestSentTime > 0 ? requestSentTime : msgStartTime;
    const ttftStr = showTtft && firstContentTime > 0 ? fmtDuration(firstContentTime - ttftBase) : null;
    const totalDurationStr = turnStartTime > 0 ? fmtDuration(now - turnStartTime) : null;

    // LLM call duration: use requestSentTime if available
    const llmDuration = requestSentTime > 0 ? now - requestSentTime : now - msgStartTime;

    lastStatsLine = {
      tps,
      input: inputKnown ? formatNum(displayInput) : "?",
      output: formatNum(displayOutput),
      toolCount: toolCallCount,
      thinkTokens: rawThink > 0 ? formatNum(rawThink) : null,
      ttft: ttftStr,
      msgDuration: fmtDuration(llmDuration),
      totalDuration: totalDurationStr,
    };
  }

  // ── stats line render ───────────────────────────────────────────────

  function renderStatsLine(data: StatsLineData | null, width: number, p: ColorPalette): string {
    if (!data) {
      return truncateToWidth(p.text(traces.length === 0 ? "⚡ Idle" : "⚡ …"), width);
    }

    const tpsLabel = data.tps === "…" ? data.tps : data.tps + "t/s";
    let line = data.input === "?"
      ? `⚡ ${p.text(tpsLabel)} ↓ ${p.output(data.output)}`
      : `⚡ ${p.text(tpsLabel)} ↑ ${p.input(data.input)} ↓ ${p.output(data.output)}`;

    const extras: (string | null)[] = [
      data.ttft ? `${p.warning("⏱ " + data.ttft)}` : null,
      data.toolCount > 0 ? `${p.info("🔧 " + data.toolCount)}` : null,
      data.thinkTokens ? `${p.think("🧠 " + data.thinkTokens)}` : null,
      `${p.muted("⏳ " + data.msgDuration)}`,
      data.totalDuration ? `${p.muted("📊 " + data.totalDuration)}` : null,
    ];

    for (const extra of extras) {
      if (!extra) continue;
      const candidate = `${line} ${extra}`;
      if (truncateToWidth(candidate, width) === candidate) {
        line = candidate;
      } else {
        break;
      }
    }

    return line;
  }

  // ── widget ───────────────────────────────────────────────────────────

  function buildWidgetLines(width: number, theme: any): string[] {
    lastWidth = width;
    const cfg = getConfig();
    const p = cfg.colorPreset === "theme" ? makeThemePalette(theme) : getCustomPalette(cfg.colorPreset);
    const lines: string[] = [];

    if (cfg.showStats) {
      lines.push(renderStatsLine(lastStatsLine, width, p));
    }

    if (cfg.showTraces && traces.length > 0) {
      const wfLines = buildWaterfallLines(width, p);
      for (const l of wfLines) {
        lines.push(truncateToWidth(l, width));
      }
    }

    return lines;
  }

  function registerWidget(ctx: { ui: { setWidget: (...args: any[]) => any } }) {
    if (widgetRef) return;
    ctx.ui.setWidget("pi-tps", (tui: any, theme: any) => {
      tuiRef = tui;
      themeRef = theme;
      widgetCache = null;
      widgetRef = {
        invalidate() {
          widgetCache = null;
        },
        render(width: number): string[] {
          if (widgetCache && widgetCache.width === width) {
            return widgetCache.lines;
          }
          const lines = buildWidgetLines(width, themeRef);
          widgetCache = { lines, width };
          return lines;
        },
      };
      return widgetRef;
    });
  }

  function refreshWidget() {
    if (tuiRef && widgetRef) {
      widgetRef.invalidate();
      tuiRef.requestRender();
    }
  }

  // ── event handlers ───────────────────────────────────────────────────

  pi.on("agent_start", async () => {
    try {
      _config = null; // force re-read
      _configPromise = null;
      await ensureConfigAsync(); // async prime cache

      totalInputTokens = 0;
      totalOutputTokens = 0;
      toolCallCount = 0;

      sessionStartTime = Date.now();
      msgStartTime = 0;
      turnStartTime = 0;
      requestSentTime = 0;
      firstContentTime = 0;
      textStartTime = 0;
      streamedTextLen = 0;
      streamedThinkLen = 0;
      lastRefreshTime = 0;

      activeTools.clear();
      traces = [];
      llmCounter = 0;
      activeLlmTrace = null;
      lastStatsLine = null;
      smoothedTps = 0;
      spinnerIdx = 0;
      widgetRef = null;
      widgetCache = null;
      invalidateFoldCache();
      tuiRef = null;
    } catch (e) {
      console.error("pi-tps: agent_start error", e);
    }
  });

  // ── turn / provider timing ──

  pi.on("turn_start", async () => {
    try {
      turnStartTime = Date.now();
    } catch (e) {
      console.error("pi-tps: turn_start error", e);
    }
  });

  pi.on("turn_end", async () => {
    try {
      if (turnStartTime > 0 && lastStatsLine) {
        lastStatsLine.totalDuration = fmtDuration(Date.now() - turnStartTime);
      }
      turnStartTime = 0;
      refreshWidget();
    } catch (e) {
      console.error("pi-tps: turn_end error", e);
    }
  });

  pi.on("before_provider_request", async () => {
    try {
      // only track during agent turns (skip compaction, etc.)
      if (turnStartTime > 0) {
        requestSentTime = Date.now();
      }
    } catch (e) {
      console.error("pi-tps: before_provider_request error", e);
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    try {
      turnStartTime = 0;
      requestSentTime = 0;
      if (lastStatsLine) {
        const p = getConfig().colorPreset === "theme"
          ? makeThemePalette(ctx.ui.theme)
          : getCustomPalette(getConfig().colorPreset);
        const coloredStats = renderStatsLine(lastStatsLine, lastWidth || 50, p);
        const fullTimeline = getConfig().showTraces ? buildWaterfallFull(p) : "";
        ctx.ui.notify(coloredStats + fullTimeline, "info");
      }
      ctx.ui.setWidget("pi-tps", undefined);
      widgetRef = null;
      widgetCache = null;
      tuiRef = null;
    } catch (e) {
      console.error("pi-tps: agent_end error", e);
    }
  });

  pi.on("message_start", async (event, ctx) => {
    try {
      if (event.message.role !== "assistant") return;
      msgStartTime = Date.now();

      firstContentTime = 0;
      textStartTime = 0;
      streamedTextLen = 0;
      streamedThinkLen = 0;

      msgStartInputTokens = event.message.usage?.input ?? 0;

      llmCounter++;
      activeLlmTrace = {
        id: `LLM ${llmCounter}`,
        name: `#${llmCounter}`,
        type: "llm",
        startTime: msgStartTime,
        endTime: 0,
        ttftTime: 0,
        thinkEndTime: 0,
        requestSentTime: requestSentTime > 0 ? requestSentTime : undefined,
      };
      traces.push(activeLlmTrace);
      trimTraces();
      invalidateFoldCache();

      registerWidget(ctx);
      refreshWidget();
    } catch (e) {
      console.error("pi-tps: message_start error", e);
    }
  });

  pi.on("message_update", async (event, ctx) => {
    try {
      if (event.message.role !== "assistant") return;

      const deltaEvent = event.assistantMessageEvent;
      if (deltaEvent?.type === "text_delta" && deltaEvent.delta) {
        streamedTextLen += deltaEvent.delta.length;
      } else if (deltaEvent?.type === "thinking_delta" && deltaEvent.delta) {
        streamedThinkLen += deltaEvent.delta.length;
        if (activeLlmTrace) activeLlmTrace.hasThinking = true;
      }

      if (activeLlmTrace) {
        const thinkToks = Math.floor(streamedThinkLen / 4);
        const textToks = Math.floor(streamedTextLen / 3.5);
        activeLlmTrace.outputTokens = thinkToks + textToks;
      }

      const hasContent =
        streamedTextLen > 0 || streamedThinkLen > 0 ||
        (event.message.thinking?.length ?? 0) > 0;

      const now = Date.now();
      // first content (text or thinking) → TTFT
      if (firstContentTime === 0 && hasContent) {
        firstContentTime = now;
        if (activeLlmTrace) activeLlmTrace.ttftTime = now;
      }
      // first text delta → marks thinking phase ended
      if (textStartTime === 0 && deltaEvent?.type === "text_delta" && deltaEvent.delta) {
        textStartTime = now;
        if (activeLlmTrace) activeLlmTrace.thinkEndTime = now;
      }

      const hasDelta = deltaEvent?.type === "text_delta" || deltaEvent?.type === "thinking_delta";
      if (hasDelta && now - lastRefreshTime > 80) {
        lastRefreshTime = now;
        updateStats(event.message, now);
        refreshWidget();
      }
    } catch (e) {
      console.error("pi-tps: message_update error", e);
    }
  });

  pi.on("message_end", async (event, ctx) => {
    try {
      if (event.message.role !== "assistant") return;
      if (msgStartTime <= 0) return;

      const now = Date.now();

      if (activeLlmTrace) {
        activeLlmTrace.endTime = now;
        const usage = event.message.usage;
        if (usage) {
          activeLlmTrace.inputTokens = usage.input ?? 0;
          activeLlmTrace.outputTokens = usage.output ?? 0;
        }
      }
      activeLlmTrace = null;
      invalidateFoldCache();

      updateStats(event.message, now);

      // override msgDuration with requestSentTime-based LLM call duration
      if (lastStatsLine && requestSentTime > 0) {
        lastStatsLine.msgDuration = fmtDuration(now - requestSentTime);
      }

      const outputTokens = event.message.usage?.output ?? 0;
      const inputTokens = event.message.usage?.input ?? 0;

      totalInputTokens += Math.max(inputTokens, msgStartInputTokens);
      totalOutputTokens += outputTokens;

      requestSentTime = 0;
      refreshWidget();
    } catch (e) {
      console.error("pi-tps: message_end error", e);
    }
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    try {
      const t: TraceNode = {
        id: event.toolCallId,
        name: shortName(event.toolName),
        type: "tool",
        startTime: Date.now(),
        endTime: 0,
        ttftTime: 0,
        thinkEndTime: 0,
      };

      toolCallCount++;
      activeTools.set(event.toolCallId, t);
      traces.push(t);
      trimTraces();
      invalidateFoldCache();

      registerWidget(ctx);
      refreshWidget();
    } catch (e) {
      console.error("pi-tps: tool_execution_start error", e);
    }
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    try {
      const t = activeTools.get(event.toolCallId);
      if (t) {
        t.endTime = Date.now();
        t.cachedBar = undefined;
        activeTools.delete(event.toolCallId);
        invalidateFoldCache();
      }
      refreshWidget();
    } catch (e) {
      console.error("pi-tps: tool_execution_end error", e);
    }
  });

  // ── /tps command ────────────────────────────────────────────────────

  async function editNumSetting(name: keyof TpsConfig, label: string, current: number, ctx: any) {
    const val = await ctx.ui.input(`${label} (current: ${current}):`, String(current));
    if (!val) return;
    const num = parseInt(val, 10);
    if (isNaN(num) || num < 1) {
      ctx.ui.notify("Invalid — must be positive number", "error");
      return;
    }
    saveConfig({ [name]: num } as any);
    if (name === "maxDetailed") invalidateFoldCache();
    refreshWidget();
    ctx.ui.notify(`${name} = ${num}`, "info");
  }

  pi.registerCommand("pi-tps", {
    description: "Configure TPS widget display",
    handler: async (_args, ctx) => {
      const cfg = getConfig();

      const choices = [
        `Show waterfall traces [${cfg.showTraces ? "on" : "off"}]`,
        `Show stats bar        [${cfg.showStats ? "on" : "off"}]`,
        `Show TTFT             [${cfg.showTtft ? "on" : "off"}]`,
        `Color preset          [${cfg.colorPreset}]`,
        `Detailed traces count [${cfg.maxDetailed}]`,
        `Memory limit (total)  [${cfg.maxTraces}]`,
      ];
      const choice = await ctx.ui.select("TPS setting:", choices);
      if (!choice) return;

      if (choice === choices[0]) {
        saveConfig({ showTraces: !cfg.showTraces });
        refreshWidget();
        ctx.ui.notify(`showTraces = ${!cfg.showTraces ? "on" : "off"}`, "info");
      } else if (choice === choices[1]) {
        saveConfig({ showStats: !cfg.showStats });
        refreshWidget();
        ctx.ui.notify(`showStats = ${!cfg.showStats ? "on" : "off"}`, "info");
      } else if (choice === choices[2]) {
        saveConfig({ showTtft: !cfg.showTtft });
        refreshWidget();
        ctx.ui.notify(`showTtft = ${!cfg.showTtft ? "on" : "off"}`, "info");
      } else if (choice === choices[3]) {
        const opts = ["theme (follow terminal theme)", ...PRESET_NAMES.map(n => {
          const pal = getCustomPalette(n);
          return `${n}  ${pal.active("█")}${pal.success("█")}${pal.warning("█")}${pal.muted("█")}`;
        })];
        const picked = await ctx.ui.select("Color preset:", opts);
        if (picked) {
          const name = picked.startsWith("theme") ? "theme" : picked.split("  ")[0];
          saveConfig({ colorPreset: name });
          refreshWidget();
          ctx.ui.notify(`Color preset: ${name}`, "info");
        }
      } else if (choice === choices[4]) {
        await editNumSetting("maxDetailed", "Detailed traces count", cfg.maxDetailed, ctx);
      } else if (choice === choices[5]) {
        await editNumSetting("maxTraces", "Memory limit", cfg.maxTraces, ctx);
      }
    },
  });
}
