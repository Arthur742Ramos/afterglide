/// <reference types="vite/client" />

import type { StreamApi, TestApi } from "../shared/contracts";

declare global {
  interface Window {
    afterglide: StreamApi;
    afterglideTest?: TestApi;
  }
}

export {};
