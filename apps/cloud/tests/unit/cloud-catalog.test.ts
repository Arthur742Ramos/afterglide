import { describe, expect, it } from "vitest";
import {
  buildSessionPayload,
  mapCloudTitles,
} from "../../src/main/live-platform-service";

describe("cloud catalog mapping", () => {
  it("uses only cloud title IDs and never changes device class for a quality setting", () => {
    const a = buildSessionPayload({ source: "cloud", id: "game" }, 720);
    const b = buildSessionPayload({ source: "cloud", id: "game" }, 1080);
    expect(a).toMatchObject({ titleId: "game", serverId: "" });
    expect(a.settings.osName).toBe(b.settings.osName);
    expect(a.settings.osName).not.toBe("android");
  });
  it("joins stream titles to catalog metadata and puts recent games first", () => {
    const titles = mapCloudTitles(
      [
        {
          titleId: "second",
          details: { productId: "p2", supportedInputTypes: ["Controller"] },
        },
        {
          titleId: "first",
          details: { productId: "p1", supportedInputTypes: ["Controller"] },
        },
      ],
      [
        {
          StoreId: "p1",
          ProductTitle: "Alpha",
          PublisherName: "Publisher A",
          Image_Tile: { URL: "//store-images.s-microsoft.com/image.png" },
        },
        {
          StoreId: "p2",
          ProductTitle: "Beta",
          PublisherName: "Publisher B",
          Image_Tile: { URL: "https://untrusted.example/art.png" },
        },
      ],
      new Set(["second"]),
    );

    expect(titles.map((title) => title.id)).toEqual(["second", "first"]);
    expect(titles[0]).toMatchObject({
      name: "Beta",
      recentlyPlayed: true,
      imageUrl: undefined,
    });
    expect(titles[1]?.imageUrl).toBe(
      "https://store-images.s-microsoft.com/image.png",
    );
  });
});
