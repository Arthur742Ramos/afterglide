export async function waitForFiniteAnimationsToSettle(): Promise<void> {
  await Promise.all(
    document
      .getAnimations()
      .filter(
        (animation) =>
          animation.playState === "running" &&
          Number.isFinite(animation.effect?.getComputedTiming().endTime),
      )
      .map(async (animation) => {
        try {
          await animation.finished;
        } catch (error) {
          // Canceled and replaced animations reject their finished promise.
          if (
            error instanceof DOMException &&
            error.name === "AbortError" &&
            (animation.playState === "idle" ||
              animation.replaceState === "removed")
          )
            return;
          throw error;
        }
      }),
  );
}
