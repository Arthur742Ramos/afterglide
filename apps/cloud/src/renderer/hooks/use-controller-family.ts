import { useEffect, useState } from "react";
import {
  controllerFamily,
  type ControllerFamily,
} from "../controller-presentation";
import { selectController } from "../stream/controller-input";
import { createControllerPolling } from "./controller-polling";

/** One label subscription for the app; no input or vibration is sent. */
export function useControllerFamily(preferredId: string): ControllerFamily {
  const [family, setFamily] = useState<ControllerFamily>("xbox");
  useEffect(() => {
    let index: number | undefined;
    const polling = createControllerPolling(
      {
        requestFrame: (callback) => requestAnimationFrame(callback),
        cancelFrame: (handle) => cancelAnimationFrame(handle),
        setTimer: (callback, delay) => window.setTimeout(callback, delay),
        clearTimer: (handle) => clearTimeout(handle),
        now: () => performance.now(),
      },
      () => !document.hidden && document.hasFocus(),
      () => {
        const pad = selectController(
          navigator.getGamepads(),
          preferredId,
          index,
        );
        index = pad?.index;
        setFamily(pad ? controllerFamily(pad.id) : "xbox");
        return Boolean(pad);
      },
      () => {
        index = undefined;
      },
      125,
    );
    const refresh = () => polling.refresh();
    for (const event of [
      "focus",
      "blur",
      "gamepadconnected",
      "gamepaddisconnected",
    ])
      window.addEventListener(event, refresh);
    document.addEventListener("visibilitychange", refresh);
    polling.refresh();
    return () => {
      polling.dispose();
      for (const event of [
        "focus",
        "blur",
        "gamepadconnected",
        "gamepaddisconnected",
      ])
        window.removeEventListener(event, refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [preferredId]);
  return family;
}
