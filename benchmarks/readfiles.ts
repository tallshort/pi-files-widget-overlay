import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import type { Theme } from "@earendil-works/pi-coding-agent";

import { createFileBrowser } from "../browser.ts";

const RENDER_WIDTH = 160;
const NAVIGATION_SAMPLES = 50;
const IDLE_TIMEOUT_MS = 180_000;

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

type BenchmarkResult = {
  scenario: "private-git" | "synthetic-non-git";
  firstUsableRenderMs: number;
  navigationRenderMs: { median: number; p95: number };
  metadataIdleMs: number | null;
};

function percentile(samples: number[], percentile: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentile))];
}

async function waitForMetadataIdle(render: () => string[]): Promise<number | null> {
  const start = performance.now();
  while (performance.now() - start < IDLE_TIMEOUT_MS) {
    const header = render()[0] ?? "";
    if (!header.includes("scanning") && !header.includes("counts")) {
      return performance.now() - start;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return null;
}

async function benchmark(root: string, scenario: BenchmarkResult["scenario"]): Promise<BenchmarkResult> {
  const start = performance.now();
  const browser = createFileBrowser(root, new Set(), theme, () => {}, () => {}, () => {});
  const render = () => browser.render(RENDER_WIDTH);
  render();
  const firstUsableRenderMs = performance.now() - start;

  const navigationSamples: number[] = [];
  for (let index = 0; index < NAVIGATION_SAMPLES; index++) {
    const navigationStart = performance.now();
    browser.handleInput("j");
    render();
    navigationSamples.push(performance.now() - navigationStart);
  }

  return {
    scenario,
    firstUsableRenderMs,
    navigationRenderMs: {
      median: percentile(navigationSamples, 0.5),
      p95: percentile(navigationSamples, 0.95),
    },
    metadataIdleMs: await waitForMetadataIdle(render),
  };
}

async function createSyntheticNonGitFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "readfiles-benchmark-"));
  for (let directory = 0; directory < 80; directory++) {
    const folder = join(root, `group-${String(directory).padStart(2, "0")}`, "module");
    await mkdir(folder, { recursive: true });
    for (let file = 0; file < 25; file++) {
      await writeFile(join(folder, `file-${String(file).padStart(2, "0")}.ts`), "export const value = 1;\n");
    }
  }
  return root;
}

async function main(): Promise<void> {
  const privateRoot = process.env.READFILES_BENCH_ROOT;
  if (!privateRoot) {
    throw new Error("READFILES_BENCH_ROOT must point to a local Git worktree.");
  }

  const syntheticRoot = await createSyntheticNonGitFixture();
  try {
    const results = [
      await benchmark(privateRoot, "private-git"),
      await benchmark(syntheticRoot, "synthetic-non-git"),
    ];
    // Deliberately emit only aggregate timings; never emit source paths, names, or contents.
    console.log(JSON.stringify(results, null, 2));
  } finally {
    await rm(syntheticRoot, { recursive: true, force: true });
  }
}

await main();
