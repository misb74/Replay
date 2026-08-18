import type { ReplayDesktopApi } from "../shared/contracts.js";

declare global {
  interface Window {
    replay?: ReplayDesktopApi;
  }
}

export {};
