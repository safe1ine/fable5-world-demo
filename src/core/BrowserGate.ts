/**
 * Pre-boot environment gate — runs before ANY engine work so users on
 * unsupported setups get a clear message instead of a broken boot screen.
 *
 * Order of checks:
 *  1. non-Chromium browser → Chrome required. The engine is built and
 *     tested exclusively against Chrome's WebGPU; Safari/Firefox coverage
 *     of the features used here is incomplete (user-verified: neither
 *     boots). Brand list from UA-CH when present (covers Chrome, Edge,
 *     Brave, Arc, Opera), "Chrome/" UA token as the fallback —
 *     HeadlessChrome passes both, so the Playwright tooling is unaffected.
 *  2. Chromium but `navigator.gpu` missing → the standard tactic: there
 *     is no fallback, so give the actionable checklist (update, hardware
 *     acceleration, chrome://gpu).
 *
 * The adapter-level probe (gpu present but no usable adapter) stays in
 * boot()/probeWebGPU, which reports richer diagnostics.
 *
 * `?nogate=1` skips everything (tooling/debug escape hatch).
 */

import { failLoud } from './Diagnostics';

interface UAClientHints {
  mobile?: boolean;
  brands?: { brand: string; version: string }[];
}

function clientHints(): UAClientHints | undefined {
  return (navigator as { userAgentData?: UAClientHints }).userAgentData;
}

/** Chrome or any Chromium-based browser (Edge, Brave, Arc, Opera, ...) */
export function isChromiumBrowser(): boolean {
  const brands = clientHints()?.brands;
  if (brands && brands.length > 0) {
    return brands.some((b) => /Chromium|Google Chrome/i.test(b.brand));
  }
  // every Chromium UA carries "Chrome/" (incl. HeadlessChrome); Safari and
  // Firefox never do
  return /Chrome\//.test(navigator.userAgent);
}

/** @returns true when boot may proceed; false after rendering a notice */
export function browserGate(): boolean {
  if (new URLSearchParams(window.location.search).get('nogate') === '1') return true;

  if (!isChromiumBrowser()) {
    failLoud('Google Chrome is required', [
      '侏罗纪世界基于 Chrome 的 WebGPU 实现构建和验证。',
      'Safari 和 Firefox 当前无法正常运行。',
      '',
      '请使用 Google Chrome 113 或更高版本打开此页面。',
      'Chromium 内核浏览器（Edge、Brave、Arc、Opera）通常也可以运行。',
    ]);
    return false;
  }

  if (!('gpu' in navigator) || !navigator.gpu) {
    failLoud('WebGPU is unavailable in this browser', [
      '当前浏览器虽然是 Chromium 内核，但没有提供 WebGPU。',
      '',
      '可以检查以下项目：',
      '  • 更新 Chrome，WebGPU 需要 113 或更高版本。',
      '  • 设置 → 系统 → 打开“使用硬件加速”，然后重新启动浏览器。',
      '  • 打开 chrome://gpu，确认 WebGPU 显示为“Hardware accelerated”。',
      '  • Linux 上的新版本 Chrome 可能需要开启',
      '    chrome://flags/#enable-vulkan 或使用 --enable-features=Vulkan 启动。',
    ]);
    return false;
  }

  return true;
}
