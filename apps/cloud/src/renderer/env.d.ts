/// <reference types="vite/client" />

import type { StreamApi, TestApi } from "../shared/contracts";

declare global {
  interface Window {
    afterglideCloud: StreamApi;
    afterglideCloudTest?: TestApi;
  }
}

export {};
